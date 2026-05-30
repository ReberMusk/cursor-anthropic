import { initDb, getDriver, closeDb } from "../src/db/index.js";
import { callCursor } from "../src/gateway/executor.js";
import { mapModel } from "../src/gateway/constants.js";

await initDb();
const d = getDriver();
const a = await d.get("SELECT * FROM cursor_accounts WHERE status='active' AND is_active=1 ORDER BY priority LIMIT 1");
if (!a) { console.log("no active account"); await closeDb(); process.exit(0); }
console.log("using account:", a.name || a.user_id, "mid:", (a.machine_id || "").slice(0, 10));
const creds = { accessToken: a.access_token, machineId: a.machine_id, ghostMode: !!a.ghost_mode };

const models = process.argv.slice(2);
if (!models.length) models.push("claude-opus-4-8", "claude-opus-4-8-max");

for (const reqModel of models) {
  const model = mapModel(reqModel);
  console.log(`\n=== request="${reqModel}" -> mapped="${model}" ===`);
  try {
    const r = await callCursor(
      { messages: [{ role: "user", content: "Reply with the single word: ok" }], model, tools: [], thinkingLevel: null, forceAgentMode: true },
      creds
    );
    console.log("status:", r.status, "error:", r.error || "none");
    console.log("text:", JSON.stringify((r.text || "").slice(0, 100)));
  } catch (e) { console.log("THROW:", e.message); }
}
await closeDb();
