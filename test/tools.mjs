/**
 * Live tool-calling stress test against the real Cursor API.
 * Mimics what Claude Code does. Requires creds in env:
 *   CURSOR_ACCESS_TOKEN=... CURSOR_MACHINE_ID=... [CURSOR_MODEL=gpt-4o] node test/tools.mjs
 */
import { callCursor } from "../src/gateway/executor.js";
import { claudeToCursor, buildAnthropicMessage } from "../src/gateway/translate.js";

const creds = {
  accessToken: process.env.CURSOR_ACCESS_TOKEN,
  machineId: process.env.CURSOR_MACHINE_ID,
  ghostMode: true,
};
const MODEL = process.env.CURSOR_MODEL || "gpt-4o";

// Full server-side path: Anthropic body -> Cursor -> Anthropic message object
async function runAnthropic(body) {
  const { messages, tools, thinkingLevel } = claudeToCursor(body);
  const decoded = await callCursor(
    { messages, model: MODEL, tools, thinkingLevel, forceAgentMode: true },
    creds
  );
  const msg = body.stream === false || true ? buildAnthropicMessage(decoded, body.model || MODEL) : null;
  return { decoded, msg };
}

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  input_schema: {
    type: "object",
    properties: { location: { type: "string", description: "City name" } },
    required: ["location"],
  },
};
const CALC_TOOL = {
  name: "calculator",
  description: "Evaluate an arithmetic expression.",
  input_schema: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  },
};

function toolUses(msg) {
  return (msg?.content || []).filter((b) => b.type === "tool_use");
}
function textOf(msg) {
  return (msg?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
function line(label, pass, detail) {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log(`\n=== Tool-calling tests (model=${MODEL}) ===\n`);

// A) single tool call
try {
  const { msg } = await runAnthropic({
    model: "claude-sonnet-4",
    max_tokens: 512,
    tools: [WEATHER_TOOL],
    messages: [{ role: "user", content: "What's the weather in Paris right now? Use the get_weather tool." }],
  });
  const tus = toolUses(msg);
  const tu = tus[0];
  line("A. single tool_use emitted", tus.length >= 1, JSON.stringify(tus.map((t) => t.name)));
  if (tu) {
    line("A. tool name round-trips to get_weather", tu.name === "get_weather", `got "${tu.name}"`);
    line("A. input is an object with location", tu.input && typeof tu.input === "object", JSON.stringify(tu.input));
    line("A. tool_use has id", !!tu.id, tu.id);
    line("A. stop_reason=tool_use", msg.stop_reason === "tool_use", msg.stop_reason);
  }
  console.log("    text:", JSON.stringify(textOf(msg).slice(0, 80)));
} catch (e) { line("A. (threw)", false, e.message); }

// B) multi-turn: feed tool_result back, expect coherent final answer
try {
  const firstId = "toolu_" + Math.random().toString(16).slice(2, 10);
  const { msg } = await runAnthropic({
    model: "claude-sonnet-4",
    max_tokens: 512,
    tools: [WEATHER_TOOL],
    messages: [
      { role: "user", content: "What's the weather in Paris? Use the tool." },
      { role: "assistant", content: [{ type: "tool_use", id: firstId, name: "get_weather", input: { location: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: firstId, content: "15°C, sunny" }] },
    ],
  });
  const t = textOf(msg).toLowerCase();
  const tus = toolUses(msg);
  line("B. final turn produced text answer", textOf(msg).length > 0, JSON.stringify(textOf(msg).slice(0, 100)));
  line("B. answer references tool result (15/sunny)", t.includes("15") || t.includes("sunny"), "");
  line("B. did NOT loop into another tool_use", tus.length === 0, tus.length ? `looped: ${tus.map(x=>x.name)}` : "clean");
} catch (e) { line("B. (threw)", false, e.message); }

// C) two tools available, prompt clearly needs the calculator
try {
  const { msg } = await runAnthropic({
    model: "claude-sonnet-4",
    max_tokens: 512,
    tools: [WEATHER_TOOL, CALC_TOOL],
    messages: [{ role: "user", content: "Compute 23*19 using the calculator tool." }],
  });
  const tu = toolUses(msg)[0];
  line("C. picked a tool", !!tu, tu?.name);
  line("C. picked the calculator (not weather)", tu?.name === "calculator", tu?.name || "none");
  if (tu) console.log("    args:", JSON.stringify(tu.input));
} catch (e) { line("C. (threw)", false, e.message); }

// D) tools available but plain chat — should NOT force a tool call
try {
  const { msg } = await runAnthropic({
    model: "claude-sonnet-4",
    max_tokens: 256,
    tools: [WEATHER_TOOL, CALC_TOOL],
    messages: [{ role: "user", content: "Say hello in one word." }],
  });
  const tus = toolUses(msg);
  line("D. no spurious tool call on plain chat", tus.length === 0, tus.length ? tus.map(x=>x.name).join() : "text-only");
  console.log("    text:", JSON.stringify(textOf(msg).slice(0, 60)));
} catch (e) { line("D. (threw)", false, e.message); }

// E) ask for two tool calls at once (Claude Code does parallel calls)
try {
  const { msg } = await runAnthropic({
    model: "claude-sonnet-4",
    max_tokens: 512,
    tools: [WEATHER_TOOL],
    messages: [{ role: "user", content: "Get the weather for BOTH Paris and Tokyo. Call get_weather for each." }],
  });
  const tus = toolUses(msg);
  line("E. emitted >=1 tool_use", tus.length >= 1, `count=${tus.length}: ${JSON.stringify(tus.map(t=>t.input))}`);
  line("E. (info) multiple parallel calls", tus.length >= 2, tus.length >= 2 ? "parallel ok" : "single only (Cursor may serialize)");
} catch (e) { line("E. (threw)", false, e.message); }

console.log("\nDone.\n");
