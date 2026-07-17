import type { DesktopSnapshot } from "@clipboard-mate/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ManualClipboardActions,
  type ClipboardPort,
  type ManualSyncPort,
} from "../src/main/manual-clipboard.js";

const snapshot = (content: string | null): DesktopSnapshot => ({
  connection: "online",
  state: {
    revision: content === null ? 0 : 7,
    value:
      content === null
        ? null
        : {
            id: "2f09aec5-d860-4fa7-92ce-c0bdbeee22d1",
            content,
            contentType: "text/plain",
            origin: {
              id: "32edb891-b3a1-45c8-96c3-f1028d91785a",
              name: "Test device",
            },
            updatedAt: "2026-07-17T12:00:00.000Z",
          },
  },
  lastSyncedAt: "2026-07-17T12:00:00.000Z",
  error: null,
});

const harness = (sharedContent: string | null) => {
  const clipboard: ClipboardPort = {
    readText: vi.fn(() => "local clipboard"),
    writeText: vi.fn(),
  };
  const state = snapshot(sharedContent);
  const sync: ManualSyncPort = {
    snapshot: state,
    publishText: vi.fn(async () => state),
  };
  return {
    actions: new ManualClipboardActions(clipboard, sync),
    clipboard,
    sync,
  };
};

describe("manual clipboard boundary", () => {
  it("does not touch the OS clipboard when constructed or idle", () => {
    const { clipboard } = harness("shared value");

    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("reads exactly once only when publishing the local clipboard", async () => {
    const { actions, clipboard, sync } = harness("shared value");

    await actions.publishLocalClipboard();

    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(sync.publishText).toHaveBeenCalledWith("local clipboard");
  });

  it("writes exactly once only when copying the shared value", () => {
    const { actions, clipboard, sync } = harness("line one\r\nline two");

    actions.copySharedToLocal();

    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledOnce();
    expect(clipboard.writeText).toHaveBeenCalledWith("line one\r\nline two");
    expect(sync.publishText).not.toHaveBeenCalled();
  });

  it("refuses to overwrite the local clipboard when shared state is clear", () => {
    const { actions, clipboard } = harness(null);

    expect(() => actions.copySharedToLocal()).toThrow(
      "The shared clipboard is empty.",
    );
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});
