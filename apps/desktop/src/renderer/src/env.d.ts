import type { ClipboardMateDesktopApi } from "../../preload";

declare global {
  interface Window {
    clipboardMate: ClipboardMateDesktopApi;
  }
}

export {};

