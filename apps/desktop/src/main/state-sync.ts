import { EventEmitter } from "node:events";
import {
  conflictResponseSchema,
  desktopConnectionSchema,
  desktopSnapshotSchema,
  emptySharedState,
  type DesktopConnection,
  type DesktopSnapshot,
  type HistoryResponse,
} from "@clipboard-mate/contracts";
import { ApiClient, ApiHttpError } from "./api-client.js";

export interface StateStorePort {
  read<T>(name: string): Promise<T | null>;
  write(name: string, value: unknown): Promise<void>;
  remove(name: string): Promise<void>;
}

export type StateApiPort = Pick<
  ApiClient,
  "getState" | "publish" | "clear" | "getHistory" | "runEventLoop"
>;

export type StateApiFactory = (connection: DesktopConnection) => StateApiPort;

const initialSnapshot = (): DesktopSnapshot => ({
  connection: "unconfigured",
  state: emptySharedState(),
  lastSyncedAt: null,
  error: null,
});

export class StateSync extends EventEmitter {
  #connection: DesktopConnection | null = null;
  #client: StateApiPort | null = null;
  #snapshot: DesktopSnapshot = initialSnapshot();
  #eventController: AbortController | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #persistQueue: Promise<void> = Promise.resolve();
  #stateOperationQueue: Promise<void> = Promise.resolve();
  #generation = 0;

  constructor(
    private readonly store: StateStorePort,
    private readonly createClient: StateApiFactory = (connection) =>
      new ApiClient(connection),
  ) {
    super();
  }

  get snapshot(): DesktopSnapshot {
    return structuredClone(this.#snapshot);
  }

  get connectionInfo(): { apiUrl: string } | null {
    return this.#connection ? { apiUrl: this.#connection.apiUrl } : null;
  }

  async initialize(): Promise<void> {
    const [rawConnection, rawSnapshot] = await Promise.all([
      this.store.read<unknown>("connection"),
      this.store.read<unknown>("snapshot"),
    ]);
    const cached = desktopSnapshotSchema.safeParse(rawSnapshot);
    if (cached.success) {
      this.#snapshot = {
        ...cached.data,
        connection: "offline",
        error: null,
      };
    }
    const connection = desktopConnectionSchema.safeParse(rawConnection);
    if (!connection.success) {
      this.#snapshot = initialSnapshot();
      this.#emit();
      return;
    }
    this.#connection = connection.data;
    this.#client = this.createClient(connection.data);
    this.#generation += 1;
    this.#snapshot = { ...this.#snapshot, connection: "connecting", error: null };
    this.#emit();
    try {
      await this.refresh();
    } catch (error) {
      this.#markOffline(error);
    }
    this.#startBackgroundSync();
  }

  async saveConnection(input: DesktopConnection): Promise<DesktopSnapshot> {
    const connection = desktopConnectionSchema.parse(input);
    const client = this.createClient(connection);
    const generation = ++this.#generation;
    this.#stopBackgroundSync();
    this.#snapshot = { ...this.#snapshot, connection: "connecting", error: null };
    this.#emit();
    try {
      const state = await client.getState();
      if (!state) throw new Error("The initial API response was unexpectedly empty.");
      if (generation !== this.#generation) {
        throw new Error("Connection setup was superseded by a newer action.");
      }
      this.#connection = connection;
      this.#client = client;
      this.#snapshot = {
        connection: "online",
        state,
        lastSyncedAt: new Date().toISOString(),
        error: null,
      };
      await Promise.all([
        this.store.write("connection", connection),
        this.#persistSnapshot(),
      ]);
      this.#emit();
      this.#startBackgroundSync();
      return this.snapshot;
    } catch (error) {
      if (generation === this.#generation) {
        this.#snapshot = {
          ...this.#snapshot,
          connection: this.#connection ? "offline" : "unconfigured",
          error: error instanceof Error ? error.message : "Connection failed.",
        };
        this.#emit();
        if (this.#client) this.#startBackgroundSync();
      }
      throw error;
    }
  }

  async clearConnection(): Promise<DesktopSnapshot> {
    this.#generation += 1;
    this.#stopBackgroundSync();
    this.#connection = null;
    this.#client = null;
    this.#snapshot = initialSnapshot();
    await this.#persistQueue.catch(() => undefined);
    await Promise.all([
      this.store.remove("connection"),
      this.store.remove("snapshot"),
    ]);
    this.#emit();
    return this.snapshot;
  }

  refresh(): Promise<DesktopSnapshot> {
    return this.#enqueueStateOperation(() => this.#refresh());
  }

  async #refresh(): Promise<DesktopSnapshot> {
    const client = this.#requireClient();
    const generation = this.#generation;
    try {
      const state = await client.getState(`"state-${this.#snapshot.state.revision}"`);
      if (generation !== this.#generation || client !== this.#client) {
        return this.snapshot;
      }
      this.#snapshot = {
        connection: "online",
        // A 200 response is authoritative even when its revision is lower.
        // This matters after restoring an older server backup. Serialized
        // state operations prevent an older concurrent response from winning.
        state: state ?? this.#snapshot.state,
        lastSyncedAt: new Date().toISOString(),
        error: null,
      };
      await this.#persistSnapshot();
      this.#emit();
      return this.snapshot;
    } catch (error) {
      if (generation === this.#generation && client === this.#client) {
        this.#markOffline(error);
      }
      throw error;
    }
  }

  publishText(
    content: string,
    expectedRevision?: number,
  ): Promise<DesktopSnapshot> {
    return this.#enqueueStateOperation(() =>
      this.#publishText(content, expectedRevision),
    );
  }

  async #publishText(
    content: string,
    expectedRevision?: number,
  ): Promise<DesktopSnapshot> {
    const client = this.#requireClient();
    const generation = this.#generation;
    try {
      const result = await client.publish(content, expectedRevision);
      if (generation !== this.#generation || client !== this.#client) {
        return this.snapshot;
      }
      await this.#acceptState(result.state);
      return this.snapshot;
    } catch (error) {
      if (
        error instanceof ApiHttpError &&
        error.status === 409 &&
        generation === this.#generation &&
        client === this.#client
      ) {
        const conflict = conflictResponseSchema.safeParse(error.details);
        if (conflict.success) {
          await this.#acceptState(conflict.data.state);
        }
      } else if (generation === this.#generation && client === this.#client) {
        this.#markOffline(error);
      }
      throw error;
    }
  }

  clearShared(): Promise<DesktopSnapshot> {
    return this.#enqueueStateOperation(() => this.#clearShared());
  }

  async #clearShared(): Promise<DesktopSnapshot> {
    const client = this.#requireClient();
    const generation = this.#generation;
    const result = await client.clear();
    if (generation !== this.#generation || client !== this.#client) {
      return this.snapshot;
    }
    await this.#acceptState(result.state);
    return this.snapshot;
  }

  getHistory(limit = 10): Promise<HistoryResponse> {
    return this.#requireClient().getHistory(limit);
  }

  shutdown(): void {
    this.#stopBackgroundSync();
  }

  async #acceptState(state: DesktopSnapshot["state"]): Promise<void> {
    this.#snapshot = {
      connection: "online",
      state,
      lastSyncedAt: new Date().toISOString(),
      error: null,
    };
    await this.#persistSnapshot();
    this.#emit();
  }

  #persistSnapshot(): Promise<void> {
    const snapshot = this.snapshot;
    const write = this.#persistQueue
      .catch(() => undefined)
      .then(() => this.store.write("snapshot", snapshot));
    this.#persistQueue = write;
    return write;
  }

  #enqueueStateOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#stateOperationQueue
      .catch(() => undefined)
      .then(operation);
    this.#stateOperationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #requireClient(): StateApiPort {
    if (!this.#client) throw new Error("Configure an API connection first.");
    return this.#client;
  }

  #startBackgroundSync(): void {
    this.#stopBackgroundSync();
    const client = this.#client;
    if (!client) return;
    const generation = this.#generation;
    this.#eventController = new AbortController();
    const signal = this.#eventController.signal;
    void client.runEventLoop(
      this.#snapshot.state.revision,
      async () => {
        if (generation === this.#generation) {
          await this.refresh().catch(() => undefined);
        }
      },
      () => {
        if (
          generation === this.#generation &&
          this.#snapshot.connection !== "online"
        ) {
          this.#snapshot = { ...this.#snapshot, connection: "online", error: null };
          this.#emit();
        }
      },
      (error) => {
        if (generation === this.#generation) this.#markOffline(error);
      },
      signal,
    );
    this.#pollTimer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, 60_000);
    this.#pollTimer.unref();
  }

  #stopBackgroundSync(): void {
    this.#eventController?.abort();
    this.#eventController = null;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  #markOffline(error: unknown): void {
    this.#snapshot = {
      ...this.#snapshot,
      connection: this.#connection ? "offline" : "unconfigured",
      error: error instanceof Error ? error.message : "The API is unavailable.",
    };
    this.#emit();
  }

  #emit(): void {
    this.emit("snapshot", this.snapshot);
  }
}
