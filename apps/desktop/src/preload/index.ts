import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopConnection,
  DesktopSnapshot,
  HistoryResponse,
} from "@clipboard-mate/contracts";

const api = {
  getSnapshot: (): Promise<DesktopSnapshot> => ipcRenderer.invoke("snapshot:get"),
  getConnectionInfo: (): Promise<{ apiUrl: string } | null> =>
    ipcRenderer.invoke("connection:info"),
  saveConnection: (connection: DesktopConnection): Promise<DesktopSnapshot> =>
    ipcRenderer.invoke("connection:save", connection),
  clearConnection: (): Promise<DesktopSnapshot> =>
    ipcRenderer.invoke("connection:clear"),
  refresh: (): Promise<DesktopSnapshot> => ipcRenderer.invoke("state:refresh"),
  publishText: (input: {
    content: string;
    expectedRevision?: number;
  }): Promise<DesktopSnapshot> => ipcRenderer.invoke("state:publish-text", input),
  publishClipboard: (): Promise<DesktopSnapshot> =>
    ipcRenderer.invoke("state:publish-clipboard"),
  copyShared: (): Promise<void> => ipcRenderer.invoke("state:copy-shared"),
  clearShared: (): Promise<DesktopSnapshot> =>
    ipcRenderer.invoke("state:clear"),
  getHistory: (limit = 10): Promise<HistoryResponse> =>
    ipcRenderer.invoke("history:get", { limit }),
  hide: (): Promise<void> => ipcRenderer.invoke("window:hide"),
  onSnapshot: (listener: (snapshot: DesktopSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot) =>
      listener(snapshot);
    ipcRenderer.on("snapshot:changed", handler);
    return () => ipcRenderer.removeListener("snapshot:changed", handler);
  },
  onSettingsRequested: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("view:settings", handler);
    return () => ipcRenderer.removeListener("view:settings", handler);
  },
};

contextBridge.exposeInMainWorld("clipboardMate", api);

export type ClipboardMateDesktopApi = typeof api;
