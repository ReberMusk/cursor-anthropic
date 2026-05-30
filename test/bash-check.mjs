import { callCursor } from "../src/gateway/executor.js";
import { claudeToCursor, buildAnthropicMessage } from "../src/gateway/translate.js";

const creds = { accessToken: process.env.CURSOR_ACCESS_TOKEN, machineId: process.env.CURSOR_MACHINE_ID, ghostMode: true };
const MODEL = process.env.CURSOR_MODEL || "claude-4-sonnet";
const CC_TOOLS = [
  { name: "Bash", description: "Execute a shell command and return its output", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];
const body = {
  model: "claude-sonnet-4", max_tokens: 512, tools: CC_TOOLS,
  messages: [{ role: "user", content: "Find out the current git branch of this repo by running the appropriate shell command. You must use the Bash tool to run it." }],
};
const { messages, tools, supportedIds, thinkingLevel } = claudeToCursor(body);
const decoded = await callCursor({ messages, model: MODEL, tools, supportedIds, thinkingLevel, forceAgentMode: true }, creds);
const msg = buildAnthropicMessage(decoded, body.model);
const tu = (msg.content || []).filter((b) => b.type === "tool_use");
console.log("tool_uses:", JSON.stringify(tu, null, 1));
console.log("text:", JSON.stringify((msg.content.find((b) => b.type === "text") || {}).text?.slice(0, 120) || ""));
