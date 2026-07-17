import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  HistoryEntry,
  HistoryResponse,
  MutationResponse,
  SharedState,
} from "@clipboard-mate/contracts";

export const TokenScope = { Read: 1, Write: 2, Admin: 4 } as const;

export interface AuthenticatedDevice {
  id: string;
  name: string;
  scopes: number;
}

interface CurrentRow {
  revision: number;
  event_id: string;
  operation: "text" | "clear";
  content: string | null;
  created_at_ms: number;
  device_id: string;
  device_name: string;
}

interface MutationRow {
  request_hash: Buffer;
  result_revision: number;
}

export interface ApplyMutationInput {
  device: AuthenticatedDevice;
  mutationId: string;
  operation: "text" | "clear";
  content: string | null;
  expectedRevision?: number;
  force?: true;
  clientCreatedAt?: string;
}

export class RevisionConflictError extends Error {
  constructor(readonly state: SharedState) {
    super("The shared clipboard changed before this update was published.");
  }
}

export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super("The mutation ID was already used for a different request.");
  }
}

const hashSecret = (secret: string): Buffer =>
  createHash("sha256").update(Buffer.from(secret, "base64url")).digest();

const hashRequest = (input: ApplyMutationInput): Buffer =>
  createHash("sha256")
    .update(
      JSON.stringify({
        operation: input.operation,
        content: input.content,
        expectedRevision: input.expectedRevision ?? null,
        force: input.force === true,
      }),
    )
    .digest();

export class ClipboardDatabase {
  readonly #database: Database.Database;

  constructor(
    filename: string,
    private readonly historyLimit = 250,
  ) {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.#database = new Database(filename);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#database.pragma("secure_delete = ON");
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS device_tokens (
        token_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        secret_hash BLOB NOT NULL CHECK(length(secret_hash) = 32),
        scopes INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        last_used_ms INTEGER,
        revoked_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS state_revisions (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        operation TEXT NOT NULL CHECK(operation IN ('text', 'clear')),
        mime TEXT,
        content TEXT,
        origin_device_id TEXT NOT NULL REFERENCES devices(id),
        created_at_ms INTEGER NOT NULL,
        client_time_ms INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
        CHECK (
          (operation = 'text' AND mime = 'text/plain' AND content IS NOT NULL)
          OR (operation = 'clear' AND mime IS NULL AND content IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS current_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER REFERENCES state_revisions(revision)
      );
      CREATE TABLE IF NOT EXISTS mutations (
        device_id TEXT NOT NULL REFERENCES devices(id),
        mutation_id TEXT NOT NULL,
        request_hash BLOB NOT NULL CHECK(length(request_hash) = 32),
        result_revision INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(device_id, mutation_id)
      );
      CREATE INDEX IF NOT EXISTS revisions_by_created_at
        ON state_revisions(created_at_ms DESC);
      INSERT OR IGNORE INTO current_state(singleton, revision)
        VALUES (1, NULL);
    `);
  }

  createDevice(
    name: string,
    scopes = TokenScope.Read | TokenScope.Write,
  ): { deviceId: string; token: string } {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 80) {
      throw new Error("Device name must contain between 1 and 80 characters.");
    }
    const deviceId = randomUUID();
    const tokenId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.#database.transaction(() => {
      this.#database
        .prepare("INSERT INTO devices(id, name, created_at_ms) VALUES (?, ?, ?)")
        .run(deviceId, trimmedName, now);
      this.#database
        .prepare(
          `INSERT INTO device_tokens(
            token_id, device_id, secret_hash, scopes, created_at_ms
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(tokenId, deviceId, hashSecret(secret), scopes, now);
    })();
    return { deviceId, token: `cbm_${tokenId}.${secret}` };
  }

  revokeDevice(deviceId: string): boolean {
    const now = Date.now();
    return this.#database.transaction(() => {
      const result = this.#database
        .prepare(
          "UPDATE devices SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL",
        )
        .run(now, deviceId);
      this.#database
        .prepare(
          "UPDATE device_tokens SET revoked_at_ms = ? WHERE device_id = ? AND revoked_at_ms IS NULL",
        )
        .run(now, deviceId);
      return result.changes > 0;
    })();
  }

  authenticate(token: string): AuthenticatedDevice | null {
    const match = /^cbm_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(token);
    if (!match) return null;
    const tokenId = match[1];
    const secret = match[2];
    if (!tokenId || !secret) return null;
    const row = this.#database
      .prepare(
        `SELECT dt.secret_hash, dt.scopes,
          d.id AS device_id, d.name AS device_name
        FROM device_tokens dt
        JOIN devices d ON d.id = dt.device_id
        WHERE dt.token_id = ? AND dt.revoked_at_ms IS NULL
          AND d.revoked_at_ms IS NULL`,
      )
      .get(tokenId) as
      | { secret_hash: Buffer; scopes: number; device_id: string; device_name: string }
      | undefined;
    if (!row || !timingSafeEqual(hashSecret(secret), row.secret_hash)) return null;
    this.#database
      .prepare("UPDATE device_tokens SET last_used_ms = ? WHERE token_id = ?")
      .run(Date.now(), tokenId);
    return { id: row.device_id, name: row.device_name, scopes: row.scopes };
  }

  getState(): SharedState {
    const row = this.#database
      .prepare(
        `SELECT sr.revision, sr.event_id, sr.operation, sr.content,
          sr.created_at_ms, d.id AS device_id, d.name AS device_name
        FROM current_state cs
        JOIN state_revisions sr ON sr.revision = cs.revision
        JOIN devices d ON d.id = sr.origin_device_id
        WHERE cs.singleton = 1`,
      )
      .get() as CurrentRow | undefined;
    if (!row) return { revision: 0, value: null };
    if (row.operation === "clear") return { revision: row.revision, value: null };
    return {
      revision: row.revision,
      value: {
        id: row.event_id,
        content: row.content ?? "",
        contentType: "text/plain",
        origin: { id: row.device_id, name: row.device_name },
        updatedAt: new Date(row.created_at_ms).toISOString(),
      },
    };
  }

  applyMutation(input: ApplyMutationInput): MutationResponse {
    if ((input.expectedRevision === undefined) === (input.force === undefined)) {
      throw new Error("Exactly one mutation conflict policy is required.");
    }
    const hash = hashRequest(input);
    this.#database.exec("BEGIN IMMEDIATE");
    let acceptedRevision = 0;
    let replayed = false;
    try {
      const existing = this.#database
        .prepare(
          "SELECT request_hash, result_revision FROM mutations WHERE device_id = ? AND mutation_id = ?",
        )
        .get(input.device.id, input.mutationId) as MutationRow | undefined;
      if (existing) {
        if (!timingSafeEqual(hash, existing.request_hash)) {
          throw new IdempotencyKeyReusedError();
        }
        acceptedRevision = existing.result_revision;
        replayed = true;
      } else {
        const current = this.getState();
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== current.revision
        ) {
          throw new RevisionConflictError(current);
        }
        const createdAt = Date.now();
        const result = this.#database
          .prepare(
            `INSERT INTO state_revisions(
              event_id, operation, mime, content, origin_device_id,
              created_at_ms, client_time_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.operation,
            input.operation === "text" ? "text/plain" : null,
            input.content,
            input.device.id,
            createdAt,
            input.clientCreatedAt
              ? new Date(input.clientCreatedAt).getTime()
              : null,
          );
        acceptedRevision = Number(result.lastInsertRowid);
        this.#database
          .prepare("UPDATE current_state SET revision = ? WHERE singleton = 1")
          .run(acceptedRevision);
        this.#database
          .prepare(
            `INSERT INTO mutations(
              device_id, mutation_id, request_hash, result_revision, created_at_ms
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.device.id, input.mutationId, hash, acceptedRevision, createdAt);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    if (!replayed) this.pruneHistory();
    return { acceptedRevision, replayed, state: this.getState() };
  }

  getHistory(beforeRevision: number | null, limit: number): HistoryResponse {
    const rows = this.#database
      .prepare(
        `SELECT sr.revision, sr.event_id, sr.operation, sr.content,
          sr.created_at_ms, sr.pinned,
          d.id AS device_id, d.name AS device_name
        FROM state_revisions sr
        JOIN devices d ON d.id = sr.origin_device_id
        WHERE (? IS NULL OR sr.revision < ?)
        ORDER BY sr.revision DESC LIMIT ?`,
      )
      .all(beforeRevision, beforeRevision, limit + 1) as Array<
      CurrentRow & { pinned: 0 | 1 }
    >;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const entries: HistoryEntry[] = page.map((row) => ({
      revision: row.revision,
      id: row.event_id,
      kind: row.operation,
      content: row.content,
      origin: { id: row.device_id, name: row.device_name },
      createdAt: new Date(row.created_at_ms).toISOString(),
      pinned: row.pinned === 1,
    }));
    return {
      entries,
      nextBeforeRevision:
        hasMore && entries.length > 0
          ? entries[entries.length - 1]?.revision ?? null
          : null,
    };
  }

  setPinned(revision: number, pinned: boolean): boolean {
    return (
      this.#database
        .prepare(
          "UPDATE state_revisions SET pinned = ? WHERE revision = ? AND operation = 'text'",
        )
        .run(pinned ? 1 : 0, revision).changes > 0
    );
  }

  pruneHistory(): void {
    const result = this.#database
      .prepare(
        `DELETE FROM state_revisions WHERE revision IN (
          SELECT sr.revision FROM state_revisions sr
          JOIN current_state cs ON cs.singleton = 1
          WHERE sr.pinned = 0 AND sr.revision != cs.revision
          ORDER BY sr.revision DESC LIMIT -1 OFFSET ?
        )`,
      )
      .run(Math.max(0, this.historyLimit - 1));
    if (result.changes > 0) {
      // secure_delete scrubs deleted cells; truncating the WAL prevents an old
      // frame from retaining the pruned plaintext outside the main DB file.
      this.#database.pragma("wal_checkpoint(TRUNCATE)");
    }
  }

  close(): void {
    this.#database.close();
  }
}
