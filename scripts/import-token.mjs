#!/usr/bin/env node
/**
 * Extract Cursor accessToken + machineId from the local Cursor SQLite store.
 * Uses the `sqlite3` CLI (no npm deps). Install it if missing:
 *   macOS: brew install sqlite ; Linux: apt-get install sqlite3
 *
 *   node scripts/import-token.mjs
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import os from "os";
import path from "path";

const HOME = os.homedir();
const candidates =
  process.platform === "darwin"
    ? [path.join(HOME, "Library/Application Support/Cursor/User/globalStorage/state.vscdb")]
    : process.platform === "win32"
    ? [path.join(process.env.APPDATA || "", "Cursor/User/globalStorage/state.vscdb")]
    : [path.join(HOME, ".config/Cursor/User/globalStorage/state.vscdb")];

const dbPath = candidates.find(existsSync);
if (!dbPath) {
  console.error("Could not find Cursor state.vscdb. Looked in:\n  " + candidates.join("\n  "));
  process.exit(1);
}

function query(key) {
  try {
    const out = execFileSync(
      "sqlite3",
      [dbPath, `SELECT value FROM ItemTable WHERE key='${key}';`],
      { encoding: "utf-8" }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

const accessToken =
  query("cursorAuth/accessToken") || query("cursorAuth/token");
const machineId =
  query("storage.serviceMachineId") || query("storage.machineId") || query("telemetry.machineId");

if (!accessToken || !machineId) {
  console.error("Failed to read token/machineId. Is `sqlite3` installed and Cursor logged in?");
  console.error(`  accessToken: ${accessToken ? "ok" : "MISSING"}  machineId: ${machineId ? "ok" : "MISSING"}`);
  process.exit(1);
}

console.log("Add these to your .env:\n");
console.log(`CURSOR_ACCESS_TOKEN=${accessToken}`);
console.log(`CURSOR_MACHINE_ID=${machineId}`);
