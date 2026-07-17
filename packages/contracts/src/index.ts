import { z } from "zod";

export const MAX_TEXT_BYTES_DEFAULT = 256 * 1024;

export const deviceSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
});

export const sharedClipSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  contentType: z.literal("text/plain"),
  origin: deviceSummarySchema,
  updatedAt: z.string().datetime(),
});

export const sharedStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  value: sharedClipSchema.nullable(),
});

const conflictPolicySchema = {
  expectedRevision: z.number().int().nonnegative().optional(),
  force: z.literal(true).optional(),
};

export const publishStateRequestSchema = z
  .object({
    mutationId: z.string().uuid(),
    content: z.string(),
    clientCreatedAt: z.string().datetime().optional(),
    ...conflictPolicySchema,
  })
  .superRefine((value, context) => {
    if ((value.expectedRevision === undefined) === (value.force === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of expectedRevision or force.",
      });
    }
  });

export const clearStateRequestSchema = z
  .object({
    mutationId: z.string().uuid(),
    ...conflictPolicySchema,
  })
  .superRefine((value, context) => {
    if ((value.expectedRevision === undefined) === (value.force === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of expectedRevision or force.",
      });
    }
  });

export const mutationResponseSchema = z.object({
  acceptedRevision: z.number().int().positive(),
  replayed: z.boolean(),
  state: sharedStateSchema,
});

export const historyEntrySchema = z.object({
  revision: z.number().int().positive(),
  id: z.string().uuid(),
  kind: z.enum(["text", "clear"]),
  content: z.string().nullable(),
  origin: deviceSummarySchema,
  createdAt: z.string().datetime(),
  pinned: z.boolean(),
});

export const historyResponseSchema = z.object({
  entries: z.array(historyEntrySchema),
  nextBeforeRevision: z.number().int().positive().nullable(),
});

export const conflictResponseSchema = z.object({
  code: z.literal("REVISION_CONFLICT"),
  message: z.string(),
  state: sharedStateSchema,
});

export const shortcutPushRequestSchema = z.object({
  mutationId: z.string().uuid(),
  text: z.string(),
});

export const stateChangedEventSchema = z.object({
  type: z.literal("state.changed"),
  revision: z.number().int().positive(),
});

export const desktopConnectionSchema = z.object({
  apiUrl: z.string().url().refine(
    (value) => {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) return false;
      if (url.protocol === "https:") return true;
      return (
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      );
    },
    {
      message:
        "Use HTTPS, except for an exact localhost or 127.0.0.1 development URL.",
    },
  ),
  deviceToken: z.string().min(32),
  cloudflareAccess: z
    .object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
    })
    .optional(),
});

export const desktopSnapshotSchema = z.object({
  connection: z.enum(["unconfigured", "connecting", "online", "offline"]),
  state: sharedStateSchema,
  lastSyncedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});

export type DeviceSummary = z.infer<typeof deviceSummarySchema>;
export type SharedClip = z.infer<typeof sharedClipSchema>;
export type SharedState = z.infer<typeof sharedStateSchema>;
export type PublishStateRequest = z.infer<typeof publishStateRequestSchema>;
export type ClearStateRequest = z.infer<typeof clearStateRequestSchema>;
export type MutationResponse = z.infer<typeof mutationResponseSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
export type ConflictResponse = z.infer<typeof conflictResponseSchema>;
export type ShortcutPushRequest = z.infer<typeof shortcutPushRequestSchema>;
export type StateChangedEvent = z.infer<typeof stateChangedEventSchema>;
export type DesktopConnection = z.infer<typeof desktopConnectionSchema>;
export type DesktopSnapshot = z.infer<typeof desktopSnapshotSchema>;

export const emptySharedState = (): SharedState => ({ revision: 0, value: null });
