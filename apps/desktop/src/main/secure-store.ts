import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";

interface StoredEnvelope {
  version: 1;
  ciphertext: string;
}

export class SecureStore {
  readonly #directory: string;
  readonly #writeQueues = new Map<string, Promise<void>>();

  constructor() {
    this.#directory = path.join(app.getPath("userData"), "secure");
  }

  async #assertAvailable(): Promise<void> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("OS-backed encrypted storage is unavailable.");
    }
  }

  #path(name: string): string {
    if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid secure-store key.");
    return path.join(this.#directory, `${name}.json`);
  }

  async read<T>(name: string): Promise<T | null> {
    await this.#assertAvailable();
    try {
      const envelope = JSON.parse(
        await fs.readFile(this.#path(name), "utf8"),
      ) as StoredEnvelope;
      if (envelope.version !== 1 || typeof envelope.ciphertext !== "string") {
        throw new Error("Unsupported encrypted state format.");
      }
      const decrypted = await safeStorage.decryptStringAsync(
        Buffer.from(envelope.ciphertext, "base64"),
      );
      if (decrypted.shouldReEncrypt) {
        await this.write(name, JSON.parse(decrypted.result));
      }
      return JSON.parse(decrypted.result) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(name: string, value: unknown): Promise<void> {
    return this.#enqueueWrite(name, () => this.#writeNow(name, value));
  }

  async #writeNow(name: string, value: unknown): Promise<void> {
    await this.#assertAvailable();
    await fs.mkdir(this.#directory, { recursive: true });
    const ciphertext = await safeStorage.encryptStringAsync(JSON.stringify(value));
    const envelope: StoredEnvelope = {
      version: 1,
      ciphertext: ciphertext.toString("base64"),
    };
    const destination = this.#path(name);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 });
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await fs.rm(destination, { force: true });
      await fs.rename(temporary, destination);
    }
  }

  remove(name: string): Promise<void> {
    return this.#enqueueWrite(name, async () => {
      await fs.rm(this.#path(name), { force: true });
    });
  }

  #enqueueWrite(name: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#writeQueues.get(name) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    this.#writeQueues.set(name, run);
    void run.finally(() => {
      if (this.#writeQueues.get(name) === run) this.#writeQueues.delete(name);
    }).catch(() => undefined);
    return run;
  }
}
