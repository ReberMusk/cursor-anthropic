// Decisive test: does Cursor's model emit its NATIVE tool calls (read_file,
// run_terminal_command, list_dir, edit_file...) when given a coding task and
// NO custom tools declared? If yes -> the viable path is a native<->CC adapter.
import { callCursor } from "../src/gateway/executor.js";

const creds = { accessToken: process.env.CURSOR_ACCESS_TOKEN, machineId: process.env.CURSOR_MACHINE_ID, ghostMode: true };
const model = process.env.CURSOR_MODEL || "claude-4-sonnet";

const cases = [
  { label: "read file", content: "Read the file ./package.json and tell me the project name. Use your file-reading tool." },
  { label: "run command", content: "Run `ls -la` in the terminal and show me the output." },
  { label: "list dir", content: "List the files in the current directory." },
];

for (const c of cases) {
  // forceAgentMode true, NO custom tools — let Cursor offer its native palette
  try {
    const r = await callCursor(
      { messages: [{ role: "user", content: c.content }], model, tools: [], thinkingLevel: null, forceAgentMode: true },
      creds
    );
    console.log(`\n[${c.label}] error=${r.error || "none"}`);
    console.log(`  text: ${JSON.stringify((r.text || "").slice(0, 100))}`);
    console.log(`  toolCalls: ${JSON.stringify(r.toolCalls.map((t) => ({ name: t.function.name, args: (t.function.arguments || "").slice(0, 120) })))}`);
  } catch (e) {
    console.log(`\n[${c.label}] THROW: ${e.message}`);
  }
}
