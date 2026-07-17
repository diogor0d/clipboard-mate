import { Buffer } from "node:buffer";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  clearStateRequestSchema,
  publishStateRequestSchema,
  shortcutPushRequestSchema,
} from "@clipboard-mate/contracts";
import type { ApiConfig } from "./config.js";
import {
  ClipboardDatabase,
  IdempotencyKeyReusedError,
  RevisionConflictError,
  TokenScope,
  type AuthenticatedDevice,
} from "./database.js";
import { StateEventHub } from "./events.js";

declare module "fastify" {
  interface FastifyRequest {
    clipboardDevice?: AuthenticatedDevice;
  }
}

export interface BuildAppOptions {
  config: Pick<ApiConfig, "dbPath" | "historyLimit" | "maxTextBytes" | "allowedOrigin">;
  database?: ClipboardDatabase;
  logger?: boolean;
}

const bearerToken = (request: FastifyRequest): string | null => {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
};

const validationFailure = (reply: FastifyReply, issues: unknown) =>
  reply.code(400).send({
    code: "INVALID_REQUEST",
    message: "The request body is invalid.",
    issues,
  });

const corsHeaders = (
  request: FastifyRequest,
  allowedOrigin: string | null,
): Record<string, string> => {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigin || origin !== allowedOrigin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, PUT, POST, PATCH, OPTIONS",
    "access-control-allow-headers": [
      "Authorization",
      "Content-Type",
      "If-None-Match",
      "Last-Event-ID",
      "CF-Access-Client-Id",
      "CF-Access-Client-Secret",
    ].join(", "),
    "access-control-expose-headers": "ETag, X-Clipboard-Revision",
    "access-control-max-age": "600",
    vary: "Origin",
  };
};

export const buildApp = (options: BuildAppOptions): FastifyInstance => {
  const app = Fastify({
    // A JSON string may encode one text byte as a six-character `\u00XX`
    // escape. The exact UTF-8 limit is still enforced after parsing.
    bodyLimit: options.config.maxTextBytes * 6 + 64 * 1024,
    logger: options.logger
      ? {
          redact: [
            "req.headers.authorization",
            "headers.authorization",
            "req.headers.cf-access-client-id",
            "headers.cf-access-client-id",
            "req.headers.cf-access-client-secret",
            "headers.cf-access-client-secret",
          ],
        }
      : false,
  });
  const database =
    options.database ??
    new ClipboardDatabase(options.config.dbPath, options.config.historyLimit);
  const events = new StateEventHub();

  const requireScope =
    (scope: number) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const token = bearerToken(request);
      const device = token ? database.authenticate(token) : null;
      if (!device) {
        await reply.code(401).send({
          code: "UNAUTHORIZED",
          message: "A valid device token is required.",
        });
        return;
      }
      if ((device.scopes & scope) !== scope) {
        await reply.code(403).send({
          code: "FORBIDDEN",
          message: "This device token does not grant the required scope.",
        });
        return;
      }
      request.clipboardDevice = device;
    };

  const applyMutation = (
    request: FastifyRequest,
    reply: FastifyReply,
    input: {
      mutationId: string;
      operation: "text" | "clear";
      content: string | null;
      expectedRevision?: number;
      force?: true;
      clientCreatedAt?: string;
    },
  ) => {
    try {
      const result = database.applyMutation({
        device: request.clipboardDevice as AuthenticatedDevice,
        ...input,
      });
      if (!result.replayed) events.broadcast(result.acceptedRevision);
      return result;
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        reply.code(409).send({
          code: "REVISION_CONFLICT",
          message: error.message,
          state: error.state,
        });
        return null;
      }
      if (error instanceof IdempotencyKeyReusedError) {
        reply.code(409).send({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: error.message,
        });
        return null;
      }
      throw error;
    }
  };

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/v1/")) {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      for (const [name, value] of Object.entries(
        corsHeaders(request, options.config.allowedOrigin),
      )) {
        reply.header(name, value);
      }
    }
    return payload;
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.options("/v1/*", async (request, reply) => {
    if (
      !options.config.allowedOrigin ||
      request.headers.origin !== options.config.allowedOrigin
    ) {
      return reply.code(403).send({
        code: "ORIGIN_FORBIDDEN",
        message: "This browser origin is not allowed.",
      });
    }
    return reply.code(204).send();
  });

  app.get(
    "/v1/state",
    { preHandler: requireScope(TokenScope.Read) },
    async (request, reply) => {
      const state = database.getState();
      const etag = `"state-${state.revision}"`;
      reply.header("etag", etag);
      if (request.headers["if-none-match"] === etag) {
        return reply.code(304).send();
      }
      return state;
    },
  );

  app.put(
    "/v1/state",
    { preHandler: requireScope(TokenScope.Write) },
    async (request, reply) => {
      const parsed = publishStateRequestSchema.safeParse(request.body);
      if (!parsed.success) return validationFailure(reply, parsed.error.issues);
      if (Buffer.byteLength(parsed.data.content, "utf8") > options.config.maxTextBytes) {
        return reply.code(413).send({
          code: "CONTENT_TOO_LARGE",
          message: `Text must be at most ${options.config.maxTextBytes} UTF-8 bytes.`,
        });
      }
      const result = applyMutation(request, reply, {
        mutationId: parsed.data.mutationId,
        operation: "text",
        content: parsed.data.content,
        expectedRevision: parsed.data.expectedRevision,
        force: parsed.data.force,
        clientCreatedAt: parsed.data.clientCreatedAt,
      });
      if (!result) return;
      reply.header("etag", `"state-${result.state.revision}"`);
      return result;
    },
  );

  app.post(
    "/v1/state/clear",
    { preHandler: requireScope(TokenScope.Write) },
    async (request, reply) => {
      const parsed = clearStateRequestSchema.safeParse(request.body);
      if (!parsed.success) return validationFailure(reply, parsed.error.issues);
      const result = applyMutation(request, reply, {
        mutationId: parsed.data.mutationId,
        operation: "clear",
        content: null,
        expectedRevision: parsed.data.expectedRevision,
        force: parsed.data.force,
      });
      if (!result) return;
      return result;
    },
  );

  app.get(
    "/v1/history",
    { preHandler: requireScope(TokenScope.Read) },
    async (request, reply) => {
      const query = request.query as { beforeRevision?: string; limit?: string };
      const beforeRevision = query.beforeRevision
        ? Number.parseInt(query.beforeRevision, 10)
        : null;
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 25;
      if (
        (beforeRevision !== null &&
          (!Number.isSafeInteger(beforeRevision) || beforeRevision <= 0)) ||
        !Number.isSafeInteger(limit) ||
        limit <= 0 ||
        limit > 100
      ) {
        return validationFailure(reply, "Invalid history cursor or limit.");
      }
      return database.getHistory(beforeRevision, limit);
    },
  );

  app.patch(
    "/v1/history/:revision/pin",
    { preHandler: requireScope(TokenScope.Write) },
    async (request, reply) => {
      const revision = Number.parseInt(
        (request.params as { revision: string }).revision,
        10,
      );
      const pinned = (request.body as { pinned?: unknown } | null)?.pinned;
      if (!Number.isSafeInteger(revision) || revision <= 0 || typeof pinned !== "boolean") {
        return validationFailure(reply, "A valid revision and boolean pinned value are required.");
      }
      if (!database.setPinned(revision, pinned)) {
        return reply.code(404).send({
          code: "NOT_FOUND",
          message: "That text revision does not exist.",
        });
      }
      return { revision, pinned };
    },
  );

  app.get(
    "/v1/shortcut/latest",
    { preHandler: requireScope(TokenScope.Read) },
    async (_request, reply) => {
      const state = database.getState();
      reply.header("x-clipboard-revision", state.revision);
      if (!state.value) return reply.code(204).send();
      return reply.type("text/plain; charset=utf-8").send(state.value.content);
    },
  );

  app.post(
    "/v1/shortcut/push",
    { preHandler: requireScope(TokenScope.Write) },
    async (request, reply) => {
      const parsed = shortcutPushRequestSchema.safeParse(request.body);
      if (!parsed.success) return validationFailure(reply, parsed.error.issues);
      if (Buffer.byteLength(parsed.data.text, "utf8") > options.config.maxTextBytes) {
        return reply.code(413).send({
          code: "CONTENT_TOO_LARGE",
          message: `Text must be at most ${options.config.maxTextBytes} UTF-8 bytes.`,
        });
      }
      const result = applyMutation(request, reply, {
        mutationId: parsed.data.mutationId,
        operation: "text",
        content: parsed.data.text,
        force: true,
      });
      if (!result) return;
      reply.header("x-clipboard-revision", result.acceptedRevision);
      return reply.code(204).send();
    },
  );

  app.get(
    "/v1/events",
    { preHandler: requireScope(TokenScope.Read) },
    async (request, reply) => {
      const lastEventId = Number.parseInt(
        String(request.headers["last-event-id"] ?? "0"),
        10,
      );
      reply.hijack();
      reply.raw.writeHead(200, {
        ...corsHeaders(request, options.config.allowedOrigin),
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      });
      reply.raw.write("retry: 2500\n\n");
      const remove = events.add(reply.raw);
      // Register before reading the revision so a concurrent mutation is
      // either observed live or included in this catch-up read.
      const currentRevision = database.getState().revision;
      if (!Number.isNaN(lastEventId) && currentRevision > lastEventId) {
        events.send(reply.raw, currentRevision);
      }
      request.raw.once("close", remove);
    },
  );

  app.addHook("preClose", async () => {
    events.close();
  });

  app.addHook("onClose", async () => {
    database.close();
  });

  return app;
};
