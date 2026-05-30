// End-to-end as Claude Code would use it: CC tools in, Anthropic tool_use out,
// with native<->CC adapter. Full server path (claudeToCursor -> callCursor -> message).
import { callCursor } from "../src/gateway/executor.js";
import { claudeToCursor, buildAnthropicMessage } from "../src/gateway/translate.js";

const creds = { accessToken: process.env.CURSOR_ACCESS_TOKEN, machineId: process.env.CURSOR_MACHINE_ID, ghostMode: true };
const MODEL = process.env.CURSOR_MODEL || "claude-4-sonnet";

// The tool set Claude Code actually sends (trimmed)
const CC_TOOLS = [
  { name: "Read", description: "Read a file from disk", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "LS", description: "List a directory", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "Grep", description: "Search file contents", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];

async function run(body) {
  const { messages, tools, supportedIds, thinkingLevel } = claudeToCursor(body);
  const decoded = await callCursor({ messages, model: MODEL, tools, supportedIds, thinkingLevel, forceAgentMode: true }, creds);
  return { decoded, msg: buildAnthropicMessage(decoded, body.model || MODEL) };
}
const toolUses = (m) => (m?.content || []).filter((b) => b.type === "tool_use");
const textOf = (m) => (m?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
const line = (ok, label, detail) => console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);

console.log(`\n=== Claude Code E2E (model=${MODEL}) ===\n`);

// 1) Read → expect tool_use name=Read, input.file_path
let firstReadId = null;
try {
  const { msg } = await run({ model: "claude-sonnet-4", max_tokens: 512, tools: CC_TOOLS, messages: [{ role: "user", content: "Read the file ./package.json and summarize it." }] });
  const tu = toolUses(msg)[0];
  line(tu?.name === "Read", "Read → CC tool_use name=Read", tu ? `name=${tu.name}` : "no tool_use");
  line(!!tu?.input?.file_path, "  input remapped to file_path", JSON.stringify(tu?.input));
  firstReadId = tu?.id;
} catch (e) { line(false, "Read", e.message); }

// 2) Bash → expect name=Bash, input.command
try {
  const { msg } = await run({ model: "claude-sonnet-4", max_tokens: 512, tools: CC_TOOLS, messages: [{ role: "user", content: "Run the shell command `echo hi` to show output." }] });
  const tu = toolUses(msg)[0];
  line(tu?.name === "Bash", "Bash → CC tool_use name=Bash", tu ? `name=${tu.name}` : "no tool_use");
  line(!!tu?.input?.command, "  input remapped to command", JSON.stringify(tu?.input));
} catch (e) { line(false, "Bash", e.message); }

// 3) Round-trip: model asked to Read, we return file contents, expect a text answer (no loop stall)
try {
  const id = firstReadId || "toolu_test1";
  const { msg } = await run({
    model: "claude-sonnet-4", max_tokens: 512, tools: CC_TOOLS,
    messages: [
      { role: "user", content: "Read ./package.json and tell me the \"name\" field." },
      { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: "./package.json" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: '{ "name": "cursor-anthropic", "version": "0.1.0" }' }] },
    ],
  });
  const t = textOf(msg);
  line(t.includes("cursor-anthropic"), "round-trip: model used the file result", JSON.stringify(t.slice(0, 90)));
  line(toolUses(msg).length === 0, "round-trip: no spurious re-call", toolUses(msg).map((x) => x.name).join() || "clean");
} catch (e) { line(false, "round-trip", e.message); }

console.log("\nDone.\n");
