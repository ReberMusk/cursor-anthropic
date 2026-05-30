import { initDb, getDriver, closeDb } from "../src/db/index.js";
import { callCursor } from "../src/gateway/executor.js";

await initDb();
const d = getDriver();
const a = await d.get("SELECT * FROM cursor_accounts WHERE status='active' AND is_active=1 ORDER BY priority LIMIT 1");
const creds = { accessToken: a.access_token, machineId: a.machine_id, ghostMode: !!a.ghost_mode };

for (const model of process.argv.slice(2)) {
  try {
    const r = await callCursor(
      { messages: [{ role: "user", content: "Reply with the single word: ok" }], model, tools: [], thinkingLevel: null, forceAgentMode: true },
      creds
    );
    console.log(`raw="${model}"  status=${r.status}  error=${r.error || "none"}`);
  } catch (e) { console.log(`raw="${model}"  THROW ${e.message}`); }
}
await closeDb();
