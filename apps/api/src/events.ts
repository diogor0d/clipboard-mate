import type { ServerResponse } from "node:http";

export class StateEventHub {
  readonly #clients = new Set<ServerResponse>();
  readonly #heartbeat: NodeJS.Timeout;

  constructor() {
    this.#heartbeat = setInterval(() => {
      for (const response of this.#clients) {
        this.#write(response, ": keep-alive\n\n");
      }
    }, 20_000);
    this.#heartbeat.unref();
  }

  add(response: ServerResponse): () => void {
    this.#clients.add(response);
    const remove = () => {
      this.#clients.delete(response);
      response.off("error", remove);
    };
    response.once("error", remove);
    return remove;
  }

  send(response: ServerResponse, revision: number): void {
    this.#write(
      response,
      `id: ${revision}\nevent: state.changed\ndata: ${JSON.stringify({
        type: "state.changed",
        revision,
      })}\n\n`,
    );
  }

  broadcast(revision: number): void {
    for (const response of this.#clients) this.send(response, revision);
  }

  close(): void {
    clearInterval(this.#heartbeat);
    for (const response of this.#clients) response.end();
    this.#clients.clear();
  }

  #write(response: ServerResponse, payload: string): void {
    if (response.destroyed || response.writableEnded) {
      this.#clients.delete(response);
      return;
    }
    try {
      response.write(payload);
    } catch {
      this.#clients.delete(response);
      response.destroy();
    }
  }
}
