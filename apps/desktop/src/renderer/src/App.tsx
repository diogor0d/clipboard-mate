import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopSnapshot,
  HistoryEntry,
} from "@clipboard-mate/contracts";

const relativeTime = (isoDate: string): string => {
  const seconds = Math.round((new Date(isoDate).getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
};

const displayError = (error: unknown): string =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': /, "")
    : "The action could not be completed.";

interface ConnectionFormProps {
  configured: boolean;
  initialApiUrl: string;
  onCancel: () => void;
  onConnected: (snapshot: DesktopSnapshot) => void;
  onDisconnect: () => Promise<void>;
}

const ConnectionForm = ({
  configured,
  initialApiUrl,
  onCancel,
  onConnected,
  onDisconnect,
}: ConnectionFormProps) => {
  const [apiUrl, setApiUrl] = useState(initialApiUrl || "http://127.0.0.1:43120");
  const [deviceToken, setDeviceToken] = useState("");
  const [showEdgeAuth, setShowEdgeAuth] = useState(false);
  const [accessClientId, setAccessClientId] = useState("");
  const [accessClientSecret, setAccessClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (disconnectConfirmOpen) {
      disconnectCancelRef.current?.focus({ preventScroll: true });
    }
  }, [disconnectConfirmOpen]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onConnected(
        await window.clipboardMate.saveConnection({
          apiUrl,
          deviceToken,
          ...(showEdgeAuth
            ? {
                cloudflareAccess: {
                  clientId: accessClientId,
                  clientSecret: accessClientSecret,
                },
              }
            : {}),
        }),
      );
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      await onDisconnect();
    } catch (caught) {
      setError(displayError(caught));
      setDisconnectConfirmOpen(false);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <main className="setup-shell">
      <div className="brand-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      <p className="eyebrow">Device relay</p>
      <h1>{configured ? "Connection settings" : "Connect this device"}</h1>
      <p className="setup-copy">
        Use a dedicated token created by the server. Clipboard Mate keeps it in
        OS-backed encrypted storage.
      </p>
      <form onSubmit={save} className="connection-form">
        <label>
          <span>API URL</span>
          <input
            type="url"
            required
            spellCheck={false}
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            placeholder="https://clips-api.example.com"
          />
        </label>
        <button
          type="button"
          className="edge-auth-toggle"
          onClick={() => setShowEdgeAuth((value) => !value)}
        >
          {showEdgeAuth ? "Hide" : "Add"} Cloudflare Access service credentials
        </button>
        {showEdgeAuth && (
          <div className="edge-auth-fields">
            <label>
              <span>Access client ID</span>
              <input
                required
                autoComplete="off"
                spellCheck={false}
                value={accessClientId}
                onChange={(event) => setAccessClientId(event.target.value)}
              />
            </label>
            <label>
              <span>Access client secret</span>
              <input
                type="password"
                required
                autoComplete="off"
                spellCheck={false}
                value={accessClientSecret}
                onChange={(event) => setAccessClientSecret(event.target.value)}
              />
            </label>
          </div>
        )}
        <label>
          <span>Device token</span>
          <input
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            value={deviceToken}
            onChange={(event) => setDeviceToken(event.target.value)}
            placeholder="cbm_…"
          />
        </label>
        {error && <p className="inline-error">{error}</p>}
        <div className="form-actions">
          {configured && (
            <button type="button" className="button ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button className="button primary grow" disabled={saving || disconnecting}>
            {saving ? "Connecting…" : "Save and connect"}
          </button>
        </div>
      </form>
      {configured && (
        <section className="disconnect-zone" aria-label="Device connection">
          {!disconnectConfirmOpen ? (
            <button
              type="button"
              className="text-button danger-text"
              disabled={saving || disconnecting}
              onClick={() => setDisconnectConfirmOpen(true)}
            >
              Disconnect this device
            </button>
          ) : (
            <div
              className="confirm-panel"
              role="alertdialog"
              aria-labelledby="disconnect-confirm-title"
              aria-describedby="disconnect-confirm-copy"
            >
              <div className="confirm-route" aria-hidden="true">
                <span>This device</span>
                <span className="confirm-route-line" />
                <span>Relay off</span>
              </div>
              <strong id="disconnect-confirm-title">Disconnect this device?</strong>
              <p id="disconnect-confirm-copy">
                This removes the saved connection and cached shared state from
                this app. It does not revoke the server token.
              </p>
              <div className="confirm-actions">
                <button
                  ref={disconnectCancelRef}
                  type="button"
                  className="button ghost"
                  disabled={disconnecting}
                  onClick={() => setDisconnectConfirmOpen(false)}
                >
                  Keep connected
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={disconnecting}
                  onClick={() => void disconnect()}
                >
                  {disconnecting ? "Disconnecting…" : "Disconnect device"}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
};

export const App = () => {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [apiUrl, setApiUrl] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [editBaseRevision, setEditBaseRevision] = useState<number | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const clearCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void window.clipboardMate.getSnapshot().then(setSnapshot);
    void window.clipboardMate
      .getConnectionInfo()
      .then((value) => setApiUrl(value?.apiUrl ?? ""));
    const stopSnapshot = window.clipboardMate.onSnapshot(setSnapshot);
    const stopSettings = window.clipboardMate.onSettingsRequested(() =>
      setSettingsOpen(true),
    );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void window.clipboardMate.hide();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      stopSnapshot();
      stopSettings();
      window.removeEventListener("keydown", keydown);
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (clearConfirmOpen) {
      clearCancelRef.current?.focus({ preventScroll: true });
    }
  }, [clearConfirmOpen]);

  const current = snapshot?.state.value ?? null;
  const connectionLabel = useMemo(() => {
    switch (snapshot?.connection) {
      case "online":
        return "Synced";
      case "connecting":
        return "Connecting";
      case "offline":
        return "Offline · cached";
      default:
        return "Not connected";
    }
  }, [snapshot?.connection]);

  const run = async <T,>(name: string, action: () => Promise<T>): Promise<T | null> => {
    setBusy(name);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(displayError(caught));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const publishDraft = async () => {
    const result = await run("text", () =>
      window.clipboardMate.publishText({
        content: draft,
        ...(editBaseRevision === undefined
          ? {}
          : { expectedRevision: editBaseRevision }),
      }),
    );
    if (!result) return;
    setSnapshot(result);
    setDraft("");
    setEditBaseRevision(undefined);
    setMessage("Published");
  };

  const loadHistory = async () => {
    const nextOpen = !historyOpen;
    setHistoryOpen(nextOpen);
    if (!nextOpen) return;
    const result = await run("history", () => window.clipboardMate.getHistory(8));
    if (result) setHistory(result.entries);
  };

  const clearShared = async () => {
    const result = await run("clear", () => window.clipboardMate.clearShared());
    if (!result) return;
    setSnapshot(result);
    setClearConfirmOpen(false);
    setDraft("");
    setEditBaseRevision(undefined);
    setMessage("Shared state cleared");
  };

  if (!snapshot) {
    return <div className="loading-screen">Loading cached state…</div>;
  }

  if (snapshot.connection === "unconfigured" || settingsOpen) {
    return (
      <ConnectionForm
        configured={snapshot.connection !== "unconfigured"}
        initialApiUrl={apiUrl}
        onCancel={() => setSettingsOpen(false)}
        onConnected={(connected) => {
          setSnapshot(connected);
          setSettingsOpen(false);
          void window.clipboardMate
            .getConnectionInfo()
            .then((value) => setApiUrl(value?.apiUrl ?? ""));
        }}
        onDisconnect={async () => {
          const disconnected = await window.clipboardMate.clearConnection();
          setSnapshot(disconnected);
          setApiUrl("");
          setSettingsOpen(false);
          setDraft("");
          setEditBaseRevision(undefined);
          setHistoryOpen(false);
          setHistory([]);
        }}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Clipboard Mate</p>
          <h1>Shared relay</h1>
        </div>
        <div className={`sync-status ${snapshot.connection}`} title={snapshot.error ?? ""}>
          <span className="status-dot" />
          {connectionLabel}
        </div>
      </header>

      <section className="state-section" aria-label="Current shared clipboard">
        <div className="section-heading">
          <span>Current shared state</span>
          <button
            className="icon-button"
            aria-label="Refresh shared state"
            title="Refresh shared state"
            disabled={busy === "refresh"}
            onClick={() =>
              void run("refresh", async () => {
                setSnapshot(await window.clipboardMate.refresh());
              })
            }
          >
            ↻
          </button>
        </div>

        <article className="state-card" key={snapshot.state.revision}>
          {current ? (
            <>
              <div className="relay-route" aria-label={`From ${current.origin.name} to shared`}>
                <span className="route-node" />
                <span>{current.origin.name}</span>
                <span className="route-line" />
                <span>Shared · r{snapshot.state.revision}</span>
              </div>
              <pre className={`shared-content ${current.content === "" ? "empty" : ""}`}>
                {current.content === "" ? "Empty text" : current.content}
              </pre>
              <p className="timestamp">Updated {relativeTime(current.updatedAt)}</p>
            </>
          ) : (
            <div className="empty-state">
              <p>Nothing is shared yet.</p>
              <span>Publish a note or your current local clipboard.</span>
            </div>
          )}
        </article>

        <div className="state-actions">
          <button
            className="button primary grow"
            disabled={!current || busy !== null}
            onClick={() =>
              void run("copy", async () => {
                await window.clipboardMate.copyShared();
                setMessage("Copied to this device");
              })
            }
          >
            {busy === "copy" ? "Copying…" : "Copy to this device"}
          </button>
          <button
            className="button secondary"
            disabled={!current || busy !== null}
            onClick={() => {
              if (!current) return;
              setDraft(current.content);
              setEditBaseRevision(snapshot.state.revision);
            }}
          >
            Edit
          </button>
        </div>
        <div className="danger-action-row">
          <button
            type="button"
            className="text-button danger-text"
            disabled={!current || busy !== null}
            aria-expanded={clearConfirmOpen}
            aria-controls="clear-shared-confirmation"
            onClick={() => setClearConfirmOpen(true)}
          >
            Clear shared state
          </button>
        </div>
        {clearConfirmOpen && (
          <div
            id="clear-shared-confirmation"
            className="confirm-panel"
            role="alertdialog"
            aria-labelledby="clear-confirm-title"
            aria-describedby="clear-confirm-copy"
          >
            <div className="confirm-route" aria-hidden="true">
              <span>Shared · r{snapshot.state.revision}</span>
              <span className="confirm-route-line" />
              <span>Empty</span>
            </div>
            <strong id="clear-confirm-title">Clear the shared state?</strong>
            <p id="clear-confirm-copy">
              Every connected device will see an empty shared state. Revision
              history stays available, and no local clipboard is changed.
            </p>
            <div className="confirm-actions">
              <button
                ref={clearCancelRef}
                type="button"
                className="button ghost"
                disabled={busy === "clear"}
                onClick={() => setClearConfirmOpen(false)}
              >
                Keep shared state
              </button>
              <button
                type="button"
                className="button danger"
                disabled={busy === "clear"}
                onClick={() => void clearShared()}
              >
                {busy === "clear" ? "Clearing…" : "Clear shared state"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="publish-section">
        <div className="section-heading">
          <label htmlFor="relay-draft">
            {editBaseRevision === undefined ? "Add or replace" : `Editing revision ${editBaseRevision}`}
          </label>
          {editBaseRevision !== undefined && (
            <button
              className="text-button"
              onClick={() => {
                setDraft("");
                setEditBaseRevision(undefined);
              }}
            >
              Cancel edit
            </button>
          )}
        </div>
        <textarea
          id="relay-draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type something for your other devices…"
          spellCheck={false}
        />
        <div className="publish-actions">
          <button
            className="button ink grow"
            disabled={busy !== null}
            onClick={() => void publishDraft()}
          >
            {busy === "text" ? "Publishing…" : "Publish text"}
          </button>
          <button
            className="button clipboard-button"
            disabled={busy !== null}
            title="Reads the local clipboard only now"
            onClick={() =>
              void run("clipboard", async () => {
                setSnapshot(await window.clipboardMate.publishClipboard());
                setMessage("Local clipboard published");
              })
            }
          >
            {busy === "clipboard" ? "Publishing…" : "Publish local clipboard"}
          </button>
        </div>
      </section>

      <section className="history-section">
        <button className="history-toggle" onClick={() => void loadHistory()}>
          <span>{historyOpen ? "▾" : "▸"} Recent revisions</span>
          <span>{busy === "history" ? "Loading…" : "History"}</span>
        </button>
        {historyOpen && (
          <div className="history-list">
            {history.map((entry) => (
              <article className="history-row" key={entry.revision}>
                <div>
                  <span className="history-revision">r{entry.revision}</span>
                  <span>{entry.origin.name}</span>
                </div>
                <p>{entry.kind === "clear" ? "Shared state cleared" : entry.content || "Empty text"}</p>
                {entry.kind === "text" && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setDraft(entry.content ?? "");
                      setEditBaseRevision(undefined);
                    }}
                  >
                    Use as draft
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <footer>
        <button className="text-button" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
        <span>
          {snapshot.lastSyncedAt
            ? `Checked ${relativeTime(snapshot.lastSyncedAt)}`
            : "Using cached state"}
        </span>
      </footer>

      {(message || error) && (
        <div className={`toast ${error ? "error" : ""}`} role="status">
          {error ?? message}
        </div>
      )}
    </main>
  );
};
