import {
  historyResponseSchema,
  mutationResponseSchema,
  sharedStateSchema,
  stateChangedEventSchema,
  type DesktopConnection,
  type HistoryResponse,
  type MutationResponse,
  type SharedState,
} from "@clipboard-mate/contracts";

export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly details: unknown,
  ) {
    super(
      typeof details === "object" &&
        details !== null &&
        "message" in details &&
        typeof details.message === "string"
        ? details.message
        : `Clipboard Mate API returned HTTP ${status}.`,
    );
  }
}

const pause = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    // Cover an abort that raced with listener registration.
    if (signal.aborted) finish();
  });

export class ApiClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #cloudflareAccess: DesktopConnection["cloudflareAccess"];

  constructor(connection: DesktopConnection) {
    this.#baseUrl = connection.apiUrl.replace(/\/+$/, "");
    this.#token = connection.deviceToken;
    this.#cloudflareAccess = connection.cloudflareAccess;
  }

  async #request(
    pathname: string,
    init: RequestInit = {},
    timeoutMs: number | null = 10_000,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#token}`);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (this.#cloudflareAccess) {
      headers.set("cf-access-client-id", this.#cloudflareAccess.clientId);
      headers.set("cf-access-client-secret", this.#cloudflareAccess.clientSecret);
    }
    const timeoutSignal = timeoutMs === null
      ? null
      : AbortSignal.timeout(timeoutMs);
    const signal = init.signal && timeoutSignal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : init.signal ?? timeoutSignal ?? undefined;
    const response = await fetch(`${this.#baseUrl}${pathname}`, {
      ...init,
      headers,
      redirect: "error",
      signal,
    });
    if (!response.ok && response.status !== 304) {
      const details = await response.json().catch(() => null);
      throw new ApiHttpError(response.status, details);
    }
    return response;
  }

  async getState(etag?: string): Promise<SharedState | null> {
    const response = await this.#request("/v1/state", {
      headers: etag ? { "if-none-match": etag } : undefined,
    });
    if (response.status === 304) return null;
    return sharedStateSchema.parse(await response.json());
  }

  async publish(
    content: string,
    expectedRevision?: number,
  ): Promise<MutationResponse> {
    const response = await this.#request("/v1/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mutationId: crypto.randomUUID(),
        content,
        ...(expectedRevision === undefined
          ? { force: true }
          : { expectedRevision }),
      }),
    });
    return mutationResponseSchema.parse(await response.json());
  }

  async clear(): Promise<MutationResponse> {
    const response = await this.#request("/v1/state/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationId: crypto.randomUUID(), force: true }),
    });
    return mutationResponseSchema.parse(await response.json());
  }

  async getHistory(limit = 10): Promise<HistoryResponse> {
    const response = await this.#request(`/v1/history?limit=${limit}`);
    return historyResponseSchema.parse(await response.json());
  }

  async runEventLoop(
    initialRevision: number,
    onRevision: (revision: number) => Promise<void>,
    onConnected: () => void,
    onConnectionError: (error: Error) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let lastRevision = initialRevision;
    while (!signal.aborted) {
      try {
        const response = await this.#request(
          "/v1/events",
          {
            headers: {
              accept: "text/event-stream",
              "last-event-id": String(lastRevision),
            },
            signal,
          },
          null,
        );
        if (!response.body) throw new Error("The event stream returned no body.");
        onConnected();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffered += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
          let boundary = buffered.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            const dataLine = frame
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (dataLine) {
              const event = stateChangedEventSchema.parse(
                JSON.parse(dataLine.slice("data: ".length)),
              );
              if (event.revision > lastRevision) {
                lastRevision = event.revision;
                await onRevision(event.revision);
              }
            }
            boundary = buffered.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        onConnectionError(
          error instanceof Error ? error : new Error("Event stream disconnected."),
        );
      }
      await pause(2_500, signal);
    }
  }
}
