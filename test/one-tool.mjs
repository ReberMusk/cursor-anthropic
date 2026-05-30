import { callCursor } from "../src/gateway/executor.js";
import { claudeToCursor } from "../src/gateway/translate.js";

const creds = { accessToken: process.env.CURSOR_ACCESS_TOKEN, machineId: process.env.CURSOR_MACHINE_ID, ghostMode: true };
const tool = { name: "get_weather", description: "Get current weather for a city. You MUST call this to answer weather questions.", input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } };

for (const model of ["gpt-4o", "gpt-4.1", "cursor-small"]) {
  const { messages, tools } = claudeToCursor({
    tools: [tool],
    messages: [{ role: "user", content: "Weather in Tokyo. You have a get_weather tool available; call it. Do not answer from memory." }],
  });
  try {
    const r = await callCursor({ messages, model, tools, thinkingLevel: null, forceAgentMode: true }, creds);
    console.log(`\n[${model}] error=${r.error || "none"}`);
    console.log(`  text: ${JSON.stringify((r.text || "").slice(0, 120))}`);
    console.log(`  toolCalls: ${JSON.stringify(r.toolCalls.map((t) => ({ name: t.function.name, args: t.function.arguments })))}`);
  } catch (e) {
    console.log(`\n[${model}] THROW: ${e.message}`);
  }
}
