// Discover Cursor's native tool names + exact arg schemas, so we can build the
// Cursor-native <-> Claude Code tool adapter. One call per prompt.
import { callCursor } from "../src/gateway/executor.js";

const creds = { accessToken: process.env.CURSOR_ACCESS_TOKEN, machineId: process.env.CURSOR_MACHINE_ID, ghostMode: true };
const model = process.env.CURSOR_MODEL || "claude-4-sonnet";
process.env.CURSOR_SUPPORTED_TOOLS = process.env.CURSOR_SUPPORTED_TOOLS || "1,2,3,4,5,6,7,8,9,10,11,15,16,17,18,19,20";

const prompts = {
  read_file: "Read the file ./package.json and tell me what's in it.",
  run_terminal: "Run the shell command `echo hello` and show the output.",
  list_dir: "List the files in the current directory.",
  grep_search: "Search the codebase for the text TODO.",
  file_search: "Find a file named server.js in this project.",
  edit_file: "Add a comment line // hi to the top of src/server.js.",
  web_search: "Search the web for the current Cursor app version.",
};

for (const [label, content] of Object.entries(prompts)) {
  try {
    const r = await callCursor(
      { messages: [{ role: "user", content }], model, tools: [], thinkingLevel: null, forceAgentMode: true },
      creds
    );
    const calls = r.toolCalls.map((t) => ({ name: t.function.name, args: t.function.arguments }));
    console.log(`\n### ${label}`);
    if (calls.length) {
      for (const c of calls) console.log(`  name=${c.name}\n  args=${c.args}`);
    } else {
      console.log(`  (no tool call) text=${JSON.stringify((r.text || "").slice(0, 100))}  ${r.error ? "ERR:" + r.error : ""}`);
    }
  } catch (e) {
    console.log(`\n### ${label}\n  THROW: ${e.message}`);
  }
}
