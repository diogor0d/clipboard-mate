import { ClipboardDatabase } from "../database.js";
import { loadConfig } from "../config.js";

const index = process.argv.indexOf("--id");
const deviceId = index >= 0 ? process.argv[index + 1] : null;
if (!deviceId) {
  console.error("Usage: pnpm --filter @clipboard-mate/api device:revoke -- --id <device-id>");
  process.exit(1);
}

const config = loadConfig();
const database = new ClipboardDatabase(config.dbPath, config.historyLimit);
try {
  if (!database.revokeDevice(deviceId)) {
    console.error("No active device matched that ID.");
    process.exitCode = 1;
  } else {
    console.log(`Revoked device ${deviceId}.`);
  }
} finally {
  database.close();
}

