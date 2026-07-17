import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
  type Rectangle,
} from "electron";
import { registerIpc } from "./ipc.js";
import { ManualClipboardActions } from "./manual-clipboard.js";
import { getDevelopmentRendererUrl } from "./renderer-source.js";
import { SecureStore } from "./secure-store.js";
import { StateSync } from "./state-sync.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const POPUP_WIDTH = 396;
const POPUP_HEIGHT = 620;
let quitting = false;
let retainedTray: Tray | null = null;
let retainedWindow: BrowserWindow | null = null;
let retainedSync: StateSync | null = null;

const diagnostic = (message: string): void => {
  if (process.env.CLIPBOARD_MATE_DIAGNOSTICS === "1") {
    console.error(`[Clipboard Mate] ${message}`);
  }
};

diagnostic("main module loaded");
app.setName("Clipboard Mate");
if (process.platform === "win32") {
  app.setAppUserModelId("dev.clipboard-mate.desktop");
}
const singleInstance = app.requestSingleInstanceLock();
diagnostic(`single-instance lock: ${singleInstance ? "acquired" : "denied"}`);
if (!singleInstance) app.quit();

const createTrayImage = () => {
  const color = process.platform === "darwin" ? "#000000" : "#315EFB";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
    <path fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M3.5 5.5 10 10.5l6.5-5M10 10.5v3.2"/>
    <circle fill="${color}" cx="10" cy="16" r="1.65"/>
  </svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
};

const positionPopover = (window: BrowserWindow, trayBounds: Rectangle): void => {
  const trayCenter = {
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  };
  const workArea = screen.getDisplayNearestPoint(trayCenter).workArea;
  const opensDownward = trayCenter.y < workArea.y + workArea.height / 2;
  const idealX = trayCenter.x - POPUP_WIDTH / 2;
  const x = Math.max(
    workArea.x + 8,
    Math.min(idealX, workArea.x + workArea.width - POPUP_WIDTH - 8),
  );
  const idealY = opensDownward
    ? trayBounds.y + trayBounds.height + 8
    : trayBounds.y - POPUP_HEIGHT - 8;
  const y = Math.max(
    workArea.y + 8,
    Math.min(idealY, workArea.y + workArea.height - POPUP_HEIGHT - 8),
  );
  window.setPosition(Math.round(x), Math.round(y), false);
};

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    show: false,
    frame: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#edf1f7",
    webPreferences: {
      preload: join(currentDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("blur", () => {
    if (!window.webContents.isDevToolsOpened()) window.hide();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });

  const developmentRendererUrl = getDevelopmentRendererUrl(app.isPackaged);
  if (developmentRendererUrl) {
    void window.loadURL(developmentRendererUrl);
  } else {
    void window.loadFile(join(currentDirectory, "../renderer/index.html"));
  }
  return window;
};

const start = (): void => {
  diagnostic("Electron app ready");
  app.dock?.hide();
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  const window = createWindow();
  const tray = new Tray(createTrayImage());
  retainedWindow = window;
  retainedTray = tray;
  diagnostic("tray and popover created");
  const store = new SecureStore();
  const sync = new StateSync(store);
  retainedSync = sync;
  const manualClipboard = new ManualClipboardActions(
    {
      readText: () => clipboard.readText(),
      writeText: (value) => clipboard.writeText(value),
    },
    sync,
  );

  tray.setToolTip("Clipboard Mate");
  tray.setIgnoreDoubleClickEvents(true);
  registerIpc(window, sync, manualClipboard);

  const showPopover = (bounds = tray.getBounds()): void => {
    positionPopover(window, bounds);
    window.show();
    window.focus();
    void sync.refresh().catch(() => undefined);
  };

  tray.on("click", (_event, bounds) => {
    if (window.isVisible()) window.hide();
    else showPopover(bounds);
  });

  tray.on("right-click", () => {
    const menu = Menu.buildFromTemplate([
      {
        label: "Open Clipboard Mate",
        click: () => showPopover(),
      },
      {
        label: "Refresh shared state",
        click: () => void sync.refresh().catch(() => undefined),
      },
      { type: "separator" },
      {
        label: "Settings…",
        click: () => {
          showPopover();
          window.webContents.send("view:settings");
        },
      },
      {
        label: "Open at login",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray.popUpContextMenu(menu);
  });

  app.on("second-instance", () => showPopover());
  app.on("before-quit", () => {
    quitting = true;
    retainedSync?.shutdown();
    retainedTray?.destroy();
    retainedTray = null;
    retainedWindow = null;
    retainedSync = null;
  });
  app.on("window-all-closed", () => undefined);

  void sync.initialize().catch((error) => {
    console.error("Clipboard Mate could not initialize its encrypted cache.", error);
  });
};

if (singleInstance) {
  void app.whenReady().then(start).catch((error) => {
    console.error("Clipboard Mate failed during desktop startup.", error);
    app.quit();
  });
}
