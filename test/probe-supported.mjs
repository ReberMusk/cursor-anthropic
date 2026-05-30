// Find which supported_tools id list makes Cursor surface our CUSTOM MCP tool.
// supportedToolIds() reads process.env.CURSOR_SUPPORTED_TOOLS at encode time,
// so we mutate it between calls.
import { callCursor } from "../src/gateway/executor.js";
import { claudeToCursor } from "../src/gateway/translate.js";

const creds = { accessToken: process.env.CURSOR_ACCESS_TOKEN, machineId: process.env.CURSOR_MACHINE_ID, ghostMode: true };
const model = process.env.CURSOR_MODEL || "claude-4-sonnet";

const tool = { name: "get_weather", description: "Get current weather for a city.", input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } };
const { messages, tools } = claudeToCursor({
  tools: [tool],
  messages: [{ role: "user", content: "What's the weather in Tokyo? You have a get_weather tool — call it with location=Tokyo." }],
});

const candidates = ["1", "19", "1,19", "1,2,3,4,5,6,7,8,9,10,11", "1,2,3,4,5,6,7,8,9,10,11,15,16,17,18,19,20"];

for (const ids of candidates) {
  process.env.CURSOR_SUPPORTED_TOOLS = ids;
  try {
    const r = await callCursor({ messages, model, tools, thinkingLevel: null, forceAgentMode: true }, creds);
    const names = r.toolCalls.map((t) => t.function.name);
    const gotWeather = names.includes("get_weather") || names.includes("mcp_custom_get_weather");
    console.log(`supported=[${ids}]  → toolCalls=${JSON.stringify(names)}  ${gotWeather ? "✅ get_weather!" : ""}  ${r.error ? "ERR:" + r.error : ""}`);
    if (!names.length) console.log(`           text: ${JSON.stringify((r.text || "").slice(0, 90))}`);
  } catch (e) {
    console.log(`supported=[${ids}]  → THROW: ${e.message}`);
  }
}
