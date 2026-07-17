import { ClipboardDatabase, TokenScope } from "../database.js";
import { loadConfig } from "../config.js";

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};

const name = argument("--name");
if (!name) {
  console.error('Usage: pnpm device:create -- --name "Device name"');
  process.exit(1);
}

const config = loadConfig();
const database = new ClipboardDatabase(config.dbPath, config.historyLimit);
try {
  const created = database.createDevice(name, TokenScope.Read | TokenScope.Write);
  console.log(`Device ID: ${created.deviceId}`);
  console.log(`Device token: ${created.token}`);
  console.log("The token is shown once. Store it in the device client now.");
} finally {
  database.close();
}

