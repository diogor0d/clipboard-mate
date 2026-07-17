import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ClipboardDatabase } from "../src/database.js";

interface Harness {
  app: FastifyInstance;
  token: string;
}

const openApps: FastifyInstance[] = [];

const createHarness = (
  maxTextBytes = 256 * 1024,
  allowedOrigin: string | null = null,
): Harness => {
  const database = new ClipboardDatabase(":memory:", 10);
  const { token } = database.createDevice("Test device");
  const app = buildApp({
    config: {
      dbPath: ":memory:",
      historyLimit: 10,
      maxTextBytes,
      allowedOrigin,
    },
    database,
  });
  openApps.push(app);
  return { app, token };
};

const authorization = (token: string) => ({
  authorization: `Bearer ${token}`,
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("shared clipboard API", () => {
  it("rejects requests without a device credential", async () => {
    const { app } = createHarness();
    const response = await app.inject({ method: "GET", url: "/v1/state" });
    expect(response.statusCode).toBe(401);
  });

  it("starts empty and marks state responses as non-cacheable", async () => {
    const { app, token } = createHarness();
    const response = await app.inject({
      method: "GET",
      url: "/v1/state",
      headers: authorization(token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: 0, value: null });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.etag).toBe('"state-0"');
  });

  it("round-trips exact text and supports conditional reads", async () => {
    const { app, token } = createHarness();
    const content = "  first line\r\nemoji: 🫡\nlast line  ";
    const mutationId = randomUUID();
    const publish = await app.inject({
      method: "PUT",
      url: "/v1/state",
      headers: authorization(token),
      payload: { mutationId, content, force: true },
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().state.value.content).toBe(content);

    const current = await app.inject({
      method: "GET",
      url: "/v1/state",
      headers: { ...authorization(token), "if-none-match": '"state-1"' },
    });
    expect(current.statusCode).toBe(304);
  });

  it("makes retries idempotent and rejects mutation ID reuse", async () => {
    const { app, token } = createHarness();
    const mutationId = randomUUID();
    const request = {
      method: "PUT" as const,
      url: "/v1/state",
      headers: authorization(token),
      payload: { mutationId, content: "same", force: true },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.json().acceptedRevision).toBe(1);
    expect(replay.json()).toMatchObject({ acceptedRevision: 1, replayed: true });

    const reused = await app.inject({
      ...request,
      payload: { mutationId, content: "different", force: true },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("protects textbox edits with an expected revision", async () => {
    const { app, token } = createHarness();
    await app.inject({
      method: "PUT",
      url: "/v1/state",
      headers: authorization(token),
      payload: { mutationId: randomUUID(), content: "newer", force: true },
    });
    const stale = await app.inject({
      method: "PUT",
      url: "/v1/state",
      headers: authorization(token),
      payload: {
        mutationId: randomUUID(),
        content: "stale edit",
        expectedRevision: 0,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: "REVISION_CONFLICT",
      state: { revision: 1 },
    });
  });

  it("supports exact empty text distinctly from a cleared state", async () => {
    const { app, token } = createHarness();
    const push = await app.inject({
      method: "POST",
      url: "/v1/shortcut/push",
      headers: authorization(token),
      payload: { mutationId: randomUUID(), text: "" },
    });
    expect(push.statusCode).toBe(204);

    const latest = await app.inject({
      method: "GET",
      url: "/v1/shortcut/latest",
      headers: authorization(token),
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.body).toBe("");

    await app.inject({
      method: "POST",
      url: "/v1/state/clear",
      headers: authorization(token),
      payload: { mutationId: randomUUID(), force: true },
    });
    const cleared = await app.inject({
      method: "GET",
      url: "/v1/shortcut/latest",
      headers: authorization(token),
    });
    expect(cleared.statusCode).toBe(204);
  });

  it("rejects UTF-8 content beyond the configured limit", async () => {
    const { app, token } = createHarness(4);
    const response = await app.inject({
      method: "PUT",
      url: "/v1/state",
      headers: authorization(token),
      payload: { mutationId: randomUUID(), content: "🫡🫡", force: true },
    });
    expect(response.statusCode).toBe(413);
  });

  it("accepts valid text even when JSON escaping makes the body much larger", async () => {
    const { app, token } = createHarness(4_000);
    const content = "\u0000".repeat(4_000);
    const response = await app.inject({
      method: "PUT",
      url: "/v1/state",
      headers: authorization(token),
      payload: { mutationId: randomUUID(), content, force: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().state.value.content).toBe(content);
  });

  it("answers browser preflights for the one configured origin", async () => {
    const allowedOrigin = "https://clipboard-ui.example.com";
    const { app } = createHarness(256 * 1024, allowedOrigin);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/state",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(response.headers["access-control-allow-methods"]).toContain("PUT");
    expect(response.headers["access-control-allow-headers"]).toContain(
      "Authorization",
    );
  });

  it("returns stable revision-based history pages", async () => {
    const { app, token } = createHarness();
    for (const content of ["one", "two", "three"]) {
      await app.inject({
        method: "PUT",
        url: "/v1/state",
        headers: authorization(token),
        payload: { mutationId: randomUUID(), content, force: true },
      });
    }
    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/history?limit=2",
      headers: authorization(token),
    });
    expect(firstPage.json().entries.map((entry: { revision: number }) => entry.revision)).toEqual([
      3, 2,
    ]);
    expect(firstPage.json().nextBeforeRevision).toBe(2);
  });
});
