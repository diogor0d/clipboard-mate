import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceEnvPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
if (existsSync(workspaceEnvPath)) process.loadEnvFile(workspaceEnvPath);

export interface ApiConfig {
  host: string;
  port: number;
  dbPath: string;
  historyLimit: number;
  maxTextBytes: number;
  allowedOrigin: string | null;
}

const positiveInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
};

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig => ({
  host: environment.CLIPBOARD_MATE_HOST || "127.0.0.1",
  port: positiveInteger(
    environment.CLIPBOARD_MATE_PORT,
    43_120,
    "CLIPBOARD_MATE_PORT",
  ),
  dbPath: path.resolve(
    environment.CLIPBOARD_MATE_DB_PATH || "./data/clipboard-mate.sqlite",
  ),
  historyLimit: positiveInteger(
    environment.CLIPBOARD_MATE_HISTORY_LIMIT,
    250,
    "CLIPBOARD_MATE_HISTORY_LIMIT",
  ),
  maxTextBytes: positiveInteger(
    environment.CLIPBOARD_MATE_MAX_TEXT_BYTES,
    256 * 1024,
    "CLIPBOARD_MATE_MAX_TEXT_BYTES",
  ),
  allowedOrigin: environment.CLIPBOARD_MATE_ALLOWED_ORIGIN || null,
});
