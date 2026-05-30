/**
 * Cursor executor: sends the protobuf body over HTTP/2 to api2.cursor.sh and
 * decodes the ConnectRPC frame stream.
 *
 * Two modes:
 *  - callCursor()    buffers the whole response → { status, text, thinking, toolCalls, error }
 *  - streamCursor()  async generator that yields normalized events as frames
 *                    arrive (true token-by-token streaming).
 *
 * Cursor's endpoint REQUIRES HTTP/2 (gRPC/ConnectRPC), so we use node:http2
 * directly — undici/fetch is HTTP/1.1 only and will not work here.
 */
import zlib from "zlib";
import { buildCursorHeaders } from "./checksum.js";
import { generateCursorBody, extractTextFromResponse } from "./protobuf.js";
import { CURSOR } from "./constants.js";
import { connectHttp2 } from "../lib/proxyAgent.js";

const HTTP2_TIMEOUT_MS = 120000;

async function makeHttp2Request(headers, body, proxyUrl = null) {
  const client = await connectHttp2(CURSOR.HOST, proxyUrl);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let responseHeaders = {};
    let settled = false;

    const finish = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      fn(...args);
    };
    const timer = setTimeout(finish(() => reject(new Error("HTTP/2 request timed out"))), HTTP2_TIMEOUT_MS);

    client.on("error", finish(reject));

    const req = client.request({
      ":method": "POST",
      ":path": CURSOR.CHAT_PATH,
      ":authority": CURSOR.HOST,
      ":scheme": "https",
      ...headers,
    });

    req.on("response", (h) => { responseHeaders = h; });
    req.on("data", (c) => chunks.push(c));
    req.on("end", finish(() => resolve({
      status: responseHeaders[":status"],
      body: Buffer.concat(chunks),
    })));
    req.on("error", finish(reject));

    req.write(Buffer.from(body));
    req.end();
  });
}

function decompressPayload(payload, flags) {
  if (payload.length > 0 && payload[0] === 0x7b) return payload; // JSON, don't decompress
  if (flags === 0x00) return payload;
  try { return zlib.gunzipSync(payload); }
  catch {
    try { return zlib.inflateSync(payload); }
    catch {
      try { return zlib.inflateRawSync(payload); }
      catch { return payload; }
    }
  }
}

/**
 * Incremental ConnectRPC frame decoder for streaming. Feed it raw bytes via
 * push(chunk); it buffers partial frames across chunk boundaries and returns an
 * array of normalized events for each complete frame:
 *   { type:"text", text }            incremental text delta
 *   { type:"thinking", text }        incremental thinking delta (not forwarded)
 *   { type:"tool_call", id, type:"function", function:{name, arguments} }
 *   { type:"error", status, error, retryable }
 * Tool-call args arrive as cumulative snapshots, so a tool_call event is only
 * emitted once (when finalized / on flush) with the most complete args.
 */
export class StreamDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.toolCallsMap = new Map();
    this.finalized = new Set();
    this.hasContent = false;
    this.toolEmitted = false;
    this.stopped = false;
  }

  push(chunk) {
    if (this.stopped) return [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const events = [];
    let offset = 0;

    while (offset + 5 <= this.buf.length) {
      const flags = this.buf[offset];
      const length = this.buf.readUInt32BE(offset + 1);
      if (offset + 5 + length > this.buf.length) break; // wait for the rest of this frame

      let payload = this.buf.slice(offset + 5, offset + 5 + length);
      offset += 5 + length;
      payload = decompressPayload(payload, flags);

      // JSON error frame
      if (payload.length > 0 && payload[0] === 0x7b) {
        try {
          const t = payload.toString("utf-8");
          if (t.includes('"error"')) {
            if (this.hasContent) { this.stopped = true; break; }
            const j = JSON.parse(t);
            const isRate = j?.error?.code === "resource_exhausted";
            const msg = j?.error?.details?.[0]?.debug?.details?.title || j?.error?.message || "Cursor API error";
            events.push({ type: "error", status: isRate ? 429 : 400, error: msg, retryable: true });
            this.stopped = true;
            break;
          }
        } catch {}
      }

      const result = extractTextFromResponse(new Uint8Array(payload));
      if (result.toolCall) {
        const tc = result.toolCall;
        const existing = this.toolCallsMap.get(tc.id);
        if (existing) {
          if ((tc.function.arguments || "").length >= (existing.function.arguments || "").length) {
            existing.function.arguments = tc.function.arguments;
          }
          if (tc.function.name) existing.function.name = tc.function.name;
        } else {
          this.toolCallsMap.set(tc.id, { ...tc, function: { ...tc.function } });
        }
        if (tc.isLast && !this.finalized.has(tc.id)) {
          this.finalized.add(tc.id);
          const f = this.toolCallsMap.get(tc.id);
          this.hasContent = true;
          this.toolEmitted = true;
          events.push({ id: f.id, type: "tool_call", function: { ...f.function } });
        }
      }
      if (result.text) { this.hasContent = true; events.push({ type: "text", text: result.text }); }
      if (result.thinking) { this.hasContent = true; events.push({ type: "thinking", text: result.thinking }); }
    }

    this.buf = offset > 0 ? this.buf.slice(offset) : this.buf;
    return events;
  }

  /** Emit any tool calls that never received isLast. */
  flush() {
    const events = [];
    for (const [id, tc] of this.toolCallsMap.entries()) {
      if (!this.finalized.has(id)) {
        this.toolEmitted = true;
        events.push({ id: tc.id, type: "tool_call", function: { ...tc.function } });
      }
    }
    return events;
  }
}

/**
 * Decode a buffered ConnectRPC frame stream into a normalized result.
 */
export function decodeCursorBuffer(buffer) {
  let offset = 0;
  let text = "";
  let thinking = "";
  const toolCallsMap = new Map();
  const finalized = new Set();
  const toolCalls = [];

  while (offset < buffer.length) {
    if (offset + 5 > buffer.length) break;
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    if (offset + 5 + length > buffer.length) break;

    let payload = buffer.slice(offset + 5, offset + 5 + length);
    offset += 5 + length;
    payload = decompressPayload(payload, flags);

    // JSON error frame
    if (payload.length > 0 && payload[0] === 0x7b) {
      try {
        const t = payload.toString("utf-8");
        if (t.includes('"error"')) {
          if (text || toolCalls.length || toolCallsMap.size) break; // already have content
          const j = JSON.parse(t);
          const isRate = j?.error?.code === "resource_exhausted";
          const msg =
            j?.error?.details?.[0]?.debug?.details?.title ||
            j?.error?.message ||
            "Cursor API error";
          return { status: isRate ? 429 : 400, error: msg, text, thinking, toolCalls };
        }
      } catch {}
    }

    const result = extractTextFromResponse(new Uint8Array(payload));
    if (result.toolCall) {
      const tc = result.toolCall;
      if (process.env.CURSOR_FRAME_DEBUG === "1") {
        console.error(`[FRAME] toolCall id=${tc.id} name=${tc.function.name} isLast=${tc.isLast} args=${JSON.stringify(tc.function.arguments)}`);
      }
      if (toolCallsMap.has(tc.id)) {
        // Cursor streams CUMULATIVE snapshots of the args (each frame = full args
        // so far), NOT deltas. Keep the longest/most-complete snapshot instead of
        // concatenating (which would duplicate the JSON).
        const existing = toolCallsMap.get(tc.id);
        if ((tc.function.arguments || "").length >= (existing.function.arguments || "").length) {
          existing.function.arguments = tc.function.arguments;
        }
        if (tc.function.name) existing.function.name = tc.function.name;
      } else {
        toolCallsMap.set(tc.id, { ...tc, function: { ...tc.function } });
      }
      if (tc.isLast && !finalized.has(tc.id)) {
        finalized.add(tc.id);
        const f = toolCallsMap.get(tc.id);
        toolCalls.push({ id: f.id, type: "function", function: { ...f.function } });
      }
    }
    if (result.text) text += result.text;
    if (result.thinking) thinking += result.thinking;
  }

  // finalize any tool calls that never got isLast
  for (const [id, tc] of toolCallsMap.entries()) {
    if (!finalized.has(id)) {
      toolCalls.push({ id: tc.id, type: "function", function: { ...tc.function } });
    }
  }

  return { status: 200, error: null, text, thinking, toolCalls };
}

/**
 * Full round-trip: build protobuf, call Cursor, decode.
 * @param {{messages, model, tools, thinkingLevel, forceAgentMode}} req
 * @param {{accessToken, machineId, ghostMode}} creds
 */
export async function callCursor(req, creds) {
  const body = generateCursorBody(
    req.messages,
    req.model,
    req.tools || [],
    req.thinkingLevel || null,
    !!req.forceAgentMode,
    req.supportedIds || null
  );
  const headers = buildCursorHeaders(creds.accessToken, creds.machineId, creds.ghostMode !== false);

  const res = await makeHttp2Request(headers, body, creds.proxyUrl || null);
  if (res.status !== 200) {
    const txt = res.body?.toString() || "Unknown error";
    return { status: res.status, error: `[${res.status}] ${txt}`, text: "", thinking: "", toolCalls: [] };
  }
  return decodeCursorBuffer(res.body);
}

/**
 * Streaming round-trip: yields normalized events as Cursor frames arrive.
 * The FIRST yielded event tells the caller whether it can still fail over:
 *   - { type:"error", retryable:true }  → nothing has been emitted yet, safe to
 *                                          try another account
 *   - any content event                 → committed to this account
 * Followed by text / tool_call events and finally { type:"done", stopReason }.
 *
 * @param {{messages, model, tools, thinkingLevel, supportedIds, forceAgentMode}} req
 * @param {{accessToken, machineId, ghostMode, proxyUrl}} creds
 */
export async function* streamCursor(req, creds) {
  const body = generateCursorBody(
    req.messages, req.model, req.tools || [], req.thinkingLevel || null,
    !!req.forceAgentMode, req.supportedIds || null
  );
  const headers = buildCursorHeaders(creds.accessToken, creds.machineId, creds.ghostMode !== false);

  const client = await connectHttp2(CURSOR.HOST, creds.proxyUrl || null);
  let stream;
  try {
    stream = client.request({
      ":method": "POST",
      ":path": CURSOR.CHAT_PATH,
      ":authority": CURSOR.HOST,
      ":scheme": "https",
      ...headers,
    });
    stream.write(Buffer.from(body));
    stream.end();

    // wait for response headers (status) before deciding anything
    const status = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("HTTP/2 request timed out")), HTTP2_TIMEOUT_MS);
      stream.once("response", (h) => { clearTimeout(to); resolve(Number(h[":status"])); });
      stream.once("error", (e) => { clearTimeout(to); reject(e); });
      client.once("error", (e) => { clearTimeout(to); reject(e); });
    });

    if (status !== 200) {
      let errBuf = Buffer.alloc(0);
      try {
        for await (const c of stream) { errBuf = Buffer.concat([errBuf, c]); if (errBuf.length > 8192) break; }
      } catch {}
      yield { type: "error", status, error: `[${status}] ${errBuf.toString() || "Cursor API error"}`, retryable: true };
      return;
    }

    const dec = new StreamDecoder();
    for await (const chunk of stream) {
      for (const ev of dec.push(chunk)) yield ev;
      if (dec.stopped) break;
    }
    for (const ev of dec.flush()) yield ev;
    yield { type: "done", stopReason: dec.toolEmitted ? "tool_use" : "end_turn" };
  } finally {
    try { client.close(); } catch {}
  }
}
