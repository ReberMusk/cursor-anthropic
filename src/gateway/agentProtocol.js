/**
 * cursor-agent CLI protocol (route C): agent.v1.AgentService/Run
 *
 * Reverse-engineered by capturing the real cursor-agent CLI traffic. Unlike the
 * IDE path (api2.cursor.sh StreamUnifiedChatWithTools), the CLI talks to
 *   POST https://agentn.global.api5.cursor.sh/agent.v1.AgentService/Run
 * over HTTP/2 + ConnectRPC (application/connect+proto), authenticated with just
 * `Authorization: Bearer <accessToken>` — NO x-cursor-checksum / x-client-key.
 *
 * Request (RunRequest), minimal shape observed on the wire:
 *   #1 {                          ← outer wrapper
 *     #1: <empty>
 *     #2 { #1 { #1 {              ← conversation input → message → bubble
 *       #1: <user text>
 *       #2: <message uuid>
 *       #3: <empty>
 *       #4: 1                     ← role (1=user)
 *     }}}
 *     #4: <empty>
 *     #5: <conversation uuid>
 *     #9 {                        ← ModelDetails
 *       #1: <model name, e.g. "claude-opus-4-8">
 *       #3 { #1:<key> #2:<val> }  ← repeated string options (thinking/effort/…)
 *     }
 *     #12: 0
 *     #16: <conversation uuid>
 *   }
 *
 * Response stream (RunResponse frames, ConnectRPC enveloped):
 *   each frame = [1B flags][4B len][payload]; flags&1 = gzip, flags&2 = trailer(JSON)
 *   StreamEvent lives under top-level field #1:
 *     #1 → #1 → #1 : text delta
 *     #1 → #4 → #1 : thinking delta
 *     #1 → #7      : tool call  { #1:callId, #2:args(tool-specific), #4:modelCallId }
 *     #1 → #8 → #1 : status code (ignored)
 *   top-level #2/#3/#4 = conversation/checkpoint replay (ignored for streaming).
 */
import zlib from "zlib";
import { encodeField, decodeField, decodeMessage, wrapConnectRPCFrame } from "./protobuf.js";
import { uuidv4 } from "./uuid.js";

const LEN = 2;
const VARINT = 0;
const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();
const dec = (v) => new TextDecoder().decode(v);

export const AGENT = {
  HOST: process.env.CURSOR_AGENT_HOST || "agentn.global.api5.cursor.sh",
  PATH: "/agent.v1.AgentService/Run",
  // cursor-agent sends x-cursor-client-version: cli-<version>; overridable.
  CLIENT_VERSION: process.env.CURSOR_AGENT_CLIENT_VERSION || "cli-2026.05.28-a70ca7c",
};

function concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/** ModelDetails (#9): model name + repeated {key,value} string options. */
function encodeModelDetails(modelName, options = []) {
  const opts = options
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) =>
      encodeField(3, LEN, concat(encodeField(1, LEN, String(k)), encodeField(2, LEN, String(v))))
    );
  return concat(encodeField(1, LEN, modelName || "auto"), ...opts);
}

/** A single user bubble: { #1 text, #2 msgId, #3 empty, #4 role }. */
function encodeBubble(text, role = 1) {
  return concat(
    encodeField(1, LEN, text || ""),
    encodeField(2, LEN, uuidv4()),
    encodeField(3, LEN, EMPTY),
    encodeField(4, VARINT, role)
  );
}

/**
 * Build the ConnectRPC request frame for AgentService/Run.
 * v1 collapses the whole conversation into a single user bubble (the captured
 * shape), which is enough for text/thinking chat. Structured multi-bubble
 * history can be layered on later.
 *
 * @param {{ prompt:string, model:string, options?:Array<[string,string]> }} req
 * @returns {Uint8Array} framed body ready to write to the h2 stream
 */
export function encodeRunRequest(req) {
  const convId = uuidv4();
  const body = concat(
    encodeField(1, LEN, EMPTY),
    encodeField(2, LEN, encodeField(1, LEN, encodeField(1, LEN, encodeBubble(req.prompt, 1)))),
    encodeField(4, LEN, EMPTY),
    encodeField(5, LEN, convId),
    encodeField(9, LEN, encodeModelDetails(req.model, req.options || [])),
    encodeField(12, VARINT, 0),
    encodeField(16, LEN, convId)
  );
  const payload = encodeField(1, LEN, body);
  return wrapConnectRPCFrame(payload, false);
}

// ----------------------- response decoding -----------------------

function gunzip(buf) {
  try { return zlib.gunzipSync(buf); }
  catch { try { return zlib.inflateSync(buf); } catch { return buf; } }
}

/** First-of(fieldNum) raw value from a decoded field map, or null. */
const first = (fields, n) => (fields.has(n) ? fields.get(n)[0].value : null);

/**
 * Decode one StreamEvent payload into a normalized event, or null if it's a
 * replay/metadata frame we don't surface.
 *   { type:"text", text } | { type:"thinking", text }
 *   { id, type:"tool_call", function:{ name, arguments } }
 */
export function decodeStreamEvent(payload) {
  let top;
  try { top = decodeMessage(payload); } catch { return null; }
  const evRaw = first(top, 1);
  if (!evRaw) return null; // #2/#3/#4 are replay/checkpoint frames
  let ev;
  try { ev = decodeMessage(evRaw); } catch { return null; }

  // text delta: #1 → #1 → #1
  if (ev.has(1)) {
    try {
      const inner = decodeMessage(first(ev, 1));
      const t = first(inner, 1);
      if (t != null) return { type: "text", text: dec(t) };
    } catch {}
  }
  // thinking delta: #4 → #1
  if (ev.has(4)) {
    try {
      const inner = decodeMessage(first(ev, 4));
      const t = first(inner, 1);
      if (t != null) return { type: "thinking", text: dec(t) };
    } catch {}
  }
  // tool call: #7 → { #1 callId, #2 args, #4 modelCallId }
  if (ev.has(7)) {
    try {
      const tc = decodeMessage(first(ev, 7));
      const id = tc.has(1) ? dec(first(tc, 1)) : "";
      const { name, args } = extractToolArgs(tc.has(2) ? first(tc, 2) : null);
      if (id) return { id, type: "tool_call", function: { name: name || "tool", arguments: args } };
    } catch {}
  }
  return null;
}

/**
 * Tool args are encoded per-tool as a nested protobuf. We surface a best-effort
 * { name, arguments(JSON string) } by scanning for the first string field that
 * looks like a path/command and any nested string values. Full per-tool schemas
 * can be mapped later; this keeps tool_use visible to clients meanwhile.
 */
function extractToolArgs(argsBuf) {
  if (!argsBuf || !argsBuf.length) return { name: "", args: "{}" };
  // The args container holds one sub-message keyed by the tool's field number
  // (e.g. read=#8). Grab the first LEN sub-field and pull printable strings.
  try {
    const fields = decodeMessage(argsBuf);
    for (const [, entries] of fields) {
      for (const e of entries) {
        if (e.value instanceof Uint8Array && e.value.length) {
          const strings = pullStrings(e.value);
          if (strings.length) return { name: "", args: JSON.stringify({ value: strings[0] }) };
        }
      }
    }
  } catch {}
  return { name: "", args: "{}" };
}

function pullStrings(buf) {
  const out = [];
  let cur = [];
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) cur.push(b);
    else { if (cur.length >= 3) out.push(Buffer.from(cur).toString("utf8")); cur = []; }
  }
  if (cur.length >= 3) out.push(Buffer.from(cur).toString("utf8"));
  return out;
}

/**
 * Incremental ConnectRPC frame decoder for the Run response stream. Feed raw
 * bytes via push(chunk); yields normalized events as full frames arrive.
 * Mirrors the protobuf executor's StreamDecoder so messages.js consumes it
 * identically: { type:"text"|"thinking"|"tool_call"|"error", ... }.
 */
export class AgentStreamDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.hasContent = false;
    this.toolEmitted = false;
    this.stopped = false;
    this.trailerError = null;
  }

  push(chunk) {
    if (this.stopped) return [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const events = [];
    let offset = 0;

    while (offset + 5 <= this.buf.length) {
      const flags = this.buf[offset];
      const length = this.buf.readUInt32BE(offset + 1);
      if (offset + 5 + length > this.buf.length) break;
      let payload = this.buf.slice(offset + 5, offset + 5 + length);
      offset += 5 + length;

      if (flags & 0x02) {
        // end-of-stream trailer (JSON): may carry an error
        try {
          const j = JSON.parse(payload.toString("utf8") || "{}");
          if (j.error) {
            const msg = j.error?.message || j.error || "agent stream error";
            if (!this.hasContent) events.push({ type: "error", status: 400, error: String(msg), retryable: true });
          }
        } catch {}
        continue;
      }
      if (flags & 0x01) payload = gunzip(payload);

      const evt = decodeStreamEvent(new Uint8Array(payload));
      if (!evt) continue;
      if (evt.type === "tool_call") { this.hasContent = true; this.toolEmitted = true; events.push(evt); }
      else if (evt.type === "text") { this.hasContent = true; events.push(evt); }
      else if (evt.type === "thinking") { this.hasContent = true; events.push(evt); }
    }

    this.buf = offset > 0 ? this.buf.slice(offset) : this.buf;
    return events;
  }
}

/** Map an Anthropic request body to a single CLI prompt transcript. */
export function buildAgentPrompt(body) {
  const flatten = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((b) => {
        if (!b || typeof b !== "object") return "";
        if (b.type === "text") return b.text || "";
        if (b.type === "thinking") return b.thinking || "";
        if (b.type === "tool_result") return `[Tool Result ${b.tool_use_id || ""}]\n${flatten(b.content)}`;
        if (b.type === "tool_use") return `[Tool Call ${b.name}]\n${JSON.stringify(b.input || {})}`;
        return "";
      }).filter(Boolean).join("\n");
    }
    return "";
  };
  const parts = [];
  if (body.system) {
    const s = typeof body.system === "string" ? body.system : flatten(body.system);
    if (s.trim()) parts.push(`SYSTEM: ${s}`);
  }
  for (const m of body.messages || []) {
    const role = m.role === "assistant" ? "ASSISTANT" : "USER";
    const t = flatten(m.content);
    if (t.trim()) parts.push(`${role}: ${t}`);
  }
  return parts.join("\n\n").trim();
}

export const _internals = { concat, encodeModelDetails, encodeBubble, extractToolArgs, pullStrings };
