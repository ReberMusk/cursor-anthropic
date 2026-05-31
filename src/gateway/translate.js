/**
 * Direct Anthropic <-> Cursor translation (no OpenAI intermediate).
 *
 *  request:  claudeToCursor(body)  -> { messages, tools, supportedIds, thinkingLevel }
 *  response: buildAnthropicSSE / buildAnthropicMessage  (buffered)
 *            createSSEStream(...)                        (true token streaming)
 *
 * tool_use/tool_result are paired and encoded as Cursor's NATIVE ToolResult so
 * the model recognizes the loop instead of re-calling (see toolAdapter.js).
 */
import crypto from "crypto";
import { supportedIdsFromClaudeTools, nativeCallToClaudeToolUse, ccToolToNative } from "./toolAdapter.js";
import { buildToolSystemPrompt, renderToolUseMarker, renderToolResult } from "./toolSim.js";

function escapeXml(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Strip non-printable control chars (keep \t \n \r) — avoids backend errors on
// tool-result text. Kept as a defensive helper.
function sanitize(t) {
  return String(t).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

// Anthropic content -> plain text
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        if (b.type === "text") return b.text || "";
        if (b.type === "tool_result") return flattenContent(b.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Tool-simulation translation: Cursor never surfaces client tools to the model,
 * so we describe them in the prompt and run Cursor as a plain Chat (no native
 * tools injected). The model emits marker blocks that the response side parses
 * back into Anthropic tool_use. Prior tool_use/tool_result turns are rendered
 * back into the transcript so multi-turn tool loops stay coherent.
 *
 * Returns { messages, tools:[], supportedIds:[], thinkingLevel, simulate:true }.
 */
function claudeToCursorSimulated(body) {
  const out = [];

  // id -> tool name, so tool_result blocks can name their tool.
  const nameById = new Map();
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === "tool_use") nameById.set(b.id, b.name);
  }

  // Leading system message: injected tool instructions + the client's system.
  const sysParts = [buildToolSystemPrompt(body.tools)];
  if (body.system) {
    const s = typeof body.system === "string" ? body.system : flattenContent(body.system);
    if (s.trim()) sysParts.push(s);
  }
  out.push({ role: "user", content: `[System Instructions]\n${sysParts.filter(Boolean).join("\n\n")}` });

  for (const m of body.messages || []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") {
      if (m.content) out.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    const parts = [];
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "tool_use") parts.push(renderToolUseMarker(b));
      else if (b.type === "tool_result") parts.push(renderToolResult(b, nameById));
    }
    const joined = parts.filter(Boolean).join("\n");
    if (joined) out.push({ role, content: joined });
  }

  let thinkingLevel = null;
  if (body.thinking?.type === "enabled") {
    thinkingLevel = (body.thinking.budget_tokens || 0) >= 8000 ? "high" : "medium";
  }
  return { messages: out, tools: [], supportedIds: [], thinkingLevel, simulate: true };
}

export function claudeToCursor(body, opts = {}) {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (opts.simulate && hasTools) return claudeToCursorSimulated(body);

  const out = [];

  // Collect tool_use id -> {name, input} and tool_result id -> resultText.
  const toolUses = new Map();
  const toolResultText = new Map();
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type === "tool_use") toolUses.set(b.id, { name: b.name, input: b.input });
      if (b?.type === "tool_result") toolResultText.set(b.tool_use_id, flattenContent(b.content));
    }
  }

  // top-level system -> leading user message
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system : flattenContent(body.system);
    if (sys.trim()) out.push({ role: "user", content: `[System Instructions]\n${sys}` });
  }

  for (const m of body.messages || []) {
    const role = m.role === "assistant" ? "assistant" : "user";

    if (typeof m.content === "string") {
      if (m.content) out.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    const parts = [];
    const toolResults = []; // native ToolResult[] attached to this (assistant) message
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "tool_use") {
        // a completed tool call: pair it with its result (from a later tool_result) and
        // encode natively so Cursor's model recognizes the loop instead of re-calling.
        const { id, native } = ccToolToNative(b.name);
        const resultText = toolResultText.get(b.id);
        if (resultText !== undefined) {
          toolResults.push({
            toolCallId: b.id,
            nativeName: native,
            enumId: id,
            resultText,
            path: b.input?.file_path || b.input?.path || null,
            toolIndex: toolResults.length + 1,
          });
        }
      }
      // tool_result blocks are consumed via the matching tool_use above — skip here.
    }
    const joined = parts.filter(Boolean).join("\n");

    // Skip user messages that carried ONLY tool_results (now attached to the assistant turn).
    if (!joined && toolResults.length === 0 && role === "user") continue;

    const msg = { role, content: joined };
    if (toolResults.length) msg.toolResults = toolResults;
    out.push(msg);
  }

  let thinkingLevel = null;
  if (body.thinking?.type === "enabled") {
    thinkingLevel = (body.thinking.budget_tokens || 0) >= 8000 ? "high" : "medium";
  }

  // Cursor ignores custom MCP tool declarations; instead we enable the matching
  // NATIVE tools via supported_tools ids derived from the CC tools[] present.
  const supportedIds = supportedIdsFromClaudeTools(body.tools || []);

  // Do NOT encode CC tools as MCP tools (proven not to surface). Agent mode is
  // driven purely by supportedIds.
  return { messages: out, tools: [], supportedIds, thinkingLevel, simulate: false };
}

const newMsgId = () => "msg_" + crypto.randomBytes(12).toString("hex");
const estTokens = (s) => Math.max(1, Math.ceil((s || "").length / 4));

// ---- Streaming (Anthropic SSE) — buffered: built from a fully decoded result ----
export function buildAnthropicSSE(decoded, model, inputText = "") {
  const id = newMsgId();
  const chunks = [];
  const ev = (type, data) => chunks.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  ev("message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: estTokens(inputText), output_tokens: 1 },
    },
  });

  let index = 0;
  const emitText = (text) => {
    ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    if (text) ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
    ev("content_block_stop", { type: "content_block_stop", index });
    index++;
  };

  if (decoded.text) emitText(decoded.text);

  for (const tc of decoded.toolCalls || []) {
    const { id, name, input } = nativeCallToClaudeToolUse(tc);
    ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
    ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    ev("content_block_stop", { type: "content_block_stop", index });
    index++;
  }

  if (index === 0) emitText(""); // always emit at least one block

  const stop = (decoded.toolCalls || []).length ? "tool_use" : "end_turn";
  ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: estTokens(decoded.text) } });
  ev("message_stop", { type: "message_stop" });

  return chunks.join("");
}

// ---- Non-streaming (single Anthropic message object) ----
export function buildAnthropicMessage(decoded, model, inputText = "", opts = {}) {
  const content = [];
  if (opts.emitThinking && decoded.thinking) content.push({ type: "thinking", thinking: decoded.thinking });
  if (decoded.text) content.push({ type: "text", text: decoded.text });
  for (const tc of decoded.toolCalls || []) {
    const { id, name, input } = nativeCallToClaudeToolUse(tc);
    content.push({ type: "tool_use", id, name, input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: newMsgId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: (decoded.toolCalls || []).length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: estTokens(inputText), output_tokens: estTokens(decoded.text) },
  };
}

// ---- True streaming emitter (Anthropic SSE, token-by-token) ----
// Consumes normalized events from executor.streamCursor() and produces SSE
// strings to write incrementally. Manages content-block indices + open/close.
// opts.emitThinking → forward Cursor thinking as Anthropic thinking blocks.
export function createSSEStream(model, inputText = "", opts = {}) {
  const emitThinking = !!opts.emitThinking;
  const id = newMsgId();
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let index = 0;
  let open = null; // 'text' | 'thinking'
  let sawTool = false;
  let outputChars = 0;

  const closeCurrent = () => {
    if (!open) return "";
    open = null;
    const out = ev("content_block_stop", { type: "content_block_stop", index });
    index++;
    return out;
  };

  const openBlock = (kind, block) => {
    let out = "";
    if (open !== kind) {
      out += closeCurrent();
      out += ev("content_block_start", { type: "content_block_start", index, content_block: block });
      open = kind;
    }
    return out;
  };

  return {
    start() {
      return ev("message_start", {
        type: "message_start",
        message: {
          id, type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: estTokens(inputText), output_tokens: 1 },
        },
      });
    },
    thinking(delta) {
      if (!emitThinking || !delta) return "";
      let out = openBlock("thinking", { type: "thinking", thinking: "" });
      out += ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: delta } });
      return out;
    },
    text(delta) {
      if (!delta) return "";
      outputChars += delta.length;
      let out = openBlock("text", { type: "text", text: "" });
      out += ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: delta } });
      return out;
    },
    // tc: { id, function:{ name, arguments } } (from StreamDecoder)
    toolCall(tc) {
      let out = closeCurrent();
      sawTool = true;
      const { id: tid, name, input } = nativeCallToClaudeToolUse(tc);
      out += ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: tid, name, input: {} } });
      out += ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      out += ev("content_block_stop", { type: "content_block_stop", index });
      index++;
      return out;
    },
    end(stopReason) {
      let out = closeCurrent();
      if (index === 0) {
        out += ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        out += ev("content_block_stop", { type: "content_block_stop", index });
        index++;
      }
      const stop = stopReason || (sawTool ? "tool_use" : "end_turn");
      out += ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.ceil(outputChars / 4)) } });
      out += ev("message_stop", { type: "message_stop" });
      return out;
    },
  };
}

export { sanitize, escapeXml };
