import type {
  DesktopConnection,
  DesktopSnapshot,
  MutationResponse,
  SharedState,
} from "@clipboard-mate/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  StateSync,
  type StateApiPort,
  type StateStorePort,
} from "../src/main/state-sync.js";

const connection: DesktopConnection = {
  apiUrl: "https://clipboard.example.com",
  deviceToken: "cbm_" + "a".repeat(48),
};

const state = (revision: number, content: string): SharedState => ({
  revision,
  value: {
    id: "73463e76-06e9-4b25-a268-c0e0a5b4fc2a",
    content,
    contentType: "text/plain",
    origin: {
      id: "cb253db1-04ad-4b80-841a-fc3f758def0d",
      name: "Test server",
    },
    updatedAt: "2026-07-17T12:00:00.000Z",
  },
});

const snapshot = (sharedState: SharedState): DesktopSnapshot => ({
  connection: "online",
  state: sharedState,
  lastSyncedAt: "2026-07-17T12:00:00.000Z",
  error: null,
});

class MemoryStore implements StateStorePort {
  readonly values = new Map<string, unknown>();

  async read<T>(name: string): Promise<T | null> {
    return (structuredClone(this.values.get(name)) as T | undefined) ?? null;
  }

  async write(name: string, value: unknown): Promise<void> {
    this.values.set(name, structuredClone(value));
  }

  async remove(name: string): Promise<void> {
    this.values.delete(name);
  }
}

const apiStub = (): StateApiPort => ({
  getState: vi.fn(async () => null),
  publish: vi.fn(async (): Promise<MutationResponse> => {
    throw new Error("Unexpected publish");
  }),
  clear: vi.fn(async (): Promise<MutationResponse> => {
    throw new Error("Unexpected clear");
  }),
  getHistory: vi.fn(async () => ({ entries: [], nextBeforeRevision: null })),
  runEventLoop: vi.fn(async () => undefined),
});

describe("desktop state synchronization", () => {
  it("accepts an authoritative lower revision after a server backup restore", async () => {
    const store = new MemoryStore();
    store.values.set("connection", connection);
    store.values.set("snapshot", snapshot(state(42, "cached before restore")));
    const api = apiStub();
    vi.mocked(api.getState).mockResolvedValue(state(30, "restored server"));
    const sync = new StateSync(store, () => api);

    await sync.initialize();

    expect(api.getState).toHaveBeenCalledWith('"state-42"');
    expect(sync.snapshot.state).toEqual(state(30, "restored server"));
    expect(sync.snapshot.connection).toBe("online");
    sync.shutdown();
  });

  it("serializes refreshes so an older concurrent response cannot win", async () => {
    const store = new MemoryStore();
    store.values.set("connection", connection);
    store.values.set("snapshot", snapshot(state(1, "initial")));
    const api = apiStub();
    let resolveFirstRefresh: ((value: SharedState) => void) | undefined;
    vi.mocked(api.getState)
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(
        () =>
          new Promise<SharedState>((resolve) => {
            resolveFirstRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce(state(3, "second refresh"));
    const sync = new StateSync(store, () => api);
    await sync.initialize();

    const first = sync.refresh();
    const second = sync.refresh();
    await vi.waitFor(() => expect(api.getState).toHaveBeenCalledTimes(2));
    expect(api.getState).toHaveBeenCalledTimes(2);

    resolveFirstRefresh?.(state(2, "first refresh"));
    await first;
    await second;

    expect(api.getState).toHaveBeenCalledTimes(3);
    expect(sync.snapshot.state).toEqual(state(3, "second refresh"));
    sync.shutdown();
  });
});
