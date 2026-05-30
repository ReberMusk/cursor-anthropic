// Probe which Cursor model ids this account can use.
import { callCursor } from "../src/gateway/executor.js";

const creds = {
  accessToken: process.env.CURSOR_ACCESS_TOKEN,
  machineId: process.env.CURSOR_MACHINE_ID,
  ghostMode: true,
};

const models = [
  "claude-3.5-sonnet",
  "claude-3.7-sonnet",
  "claude-3.7-sonnet-thinking",
  "claude-4-sonnet",
  "claude-4.5-sonnet",
  "claude-4-sonnet-thinking",
  "gpt-4o",
  "gpt-4.1",
  "auto",
  "default",
  "cursor-small",
];

for (const model of models) {
  try {
    const r = await callCursor(
      { messages: [{ role: "user", content: "Say: ok" }], model, tools: [], thinkingLevel: null, forceAgentMode: false },
      creds
    );
    const status = r.error ? `ERR(${r.status}): ${r.error}` : `OK text="${(r.text || "").slice(0, 40)}"`;
    console.log(`${model.padEnd(28)} → ${status}`);
  } catch (e) {
    console.log(`${model.padEnd(28)} → THROW: ${e.message}`);
  }
}
