import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { desktopConnectionSchema } from "@clipboard-mate/contracts";
import { z } from "zod";
import { ManualClipboardActions } from "./manual-clipboard.js";
import { getDevelopmentRendererUrl } from "./renderer-source.js";
import { StateSync } from "./state-sync.js";

const publishTextSchema = z.object({
  content: z.string(),
  expectedRevision: z.number().int().nonnegative().optional(),
});

const historyRequestSchema = z.object({
  limit: z.number().int().positive().max(50),
});

const packagedRendererUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "../renderer/index.html"),
).href;

const assertTrustedSender = (
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
): void => {
  const frame = event.senderFrame;
  if (
    !frame ||
    event.sender !== window.webContents ||
    frame !== window.webContents.mainFrame
  ) {
    throw new Error("Blocked IPC from an unexpected renderer frame.");
  }
  const url = frame.url;
  const developmentRendererUrl = getDevelopmentRendererUrl(app.isPackaged);
  const developmentOrigin = developmentRendererUrl
    ? new URL(developmentRendererUrl).origin
    : null;
  const trusted = url === packagedRendererUrl ||
    (developmentOrigin !== null && new URL(url).origin === developmentOrigin);
  if (!trusted) throw new Error("Blocked IPC from an untrusted renderer.");
};

export const registerIpc = (
  window: BrowserWindow,
  sync: StateSync,
  manualClipboard: ManualClipboardActions,
): void => {
  const handle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, input: unknown) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, input) => {
      assertTrustedSender(event, window);
      return handler(event, input);
    });
  };

  handle("snapshot:get", () => sync.snapshot);
  handle("connection:info", () => sync.connectionInfo);
  handle("connection:save", (_event, input) =>
    sync.saveConnection(desktopConnectionSchema.parse(input)),
  );
  handle("connection:clear", () => sync.clearConnection());
  handle("state:refresh", () => sync.refresh());
  handle("state:publish-text", (_event, input) => {
    const parsed = publishTextSchema.parse(input);
    return sync.publishText(parsed.content, parsed.expectedRevision);
  });
  handle("state:publish-clipboard", () =>
    manualClipboard.publishLocalClipboard(),
  );
  handle("state:copy-shared", () => manualClipboard.copySharedToLocal());
  handle("state:clear", () => sync.clearShared());
  handle("history:get", (_event, input) => {
    const parsed = historyRequestSchema.parse(input);
    return sync.getHistory(parsed.limit);
  });
  handle("window:hide", () => window.hide());

  sync.on("snapshot", (snapshot) => {
    if (!window.isDestroyed()) window.webContents.send("snapshot:changed", snapshot);
  });
};
