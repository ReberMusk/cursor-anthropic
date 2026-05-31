/**
 * Route C executor: drives the cursor-agent CLI protocol over HTTP/2 directly
 * (no subprocess), reusing the account pool. POSTs a connect+proto RunRequest to
 * agentn.global.api5.cursor.sh/agent.v1.AgentService/Run and decodes the
 * streamed RunResponse into the SAME normalized events the protobuf executor
 * emits, so routes/messages.js consumes both identically.
 *
 * Auth is just `Authorization: Bearer <accessToken>` — no checksum/client-key.
 */
import crypto from "crypto";
import { connectHttp2 } from "../lib/proxyAgent.js";
import { AGENT, encodeRunRequest, AgentStreamDecoder } from "./agentProtocol.js";

const H2_TIMEOUT_MS = 120000;

function buildAgentHeaders(accessToken, ghostMode = true) {
  const token = accessToken.includes("::") ? accessToken.split("::")[1] : accessToken;
  const rid = crypto.randomUUID();
  const trace = `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-01`;
  return {
    authorization: `Bearer ${token}`,
    "connect-protocol-version": "1",
    "connect-accept-encoding": "gzip,br",
    "content-type": "application/connect+proto",
    "user-agent": "connect-es/1.6.1",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": AGENT.CLIENT_VERSION,
    "x-ghost-mode": ghostMode ? "true" : "false",
    "x-request-id": rid,
    "x-original-request-id": rid,
    traceparent: trace,
    "backend-traceparent": trace,
  };
}

/**
 * Streaming round-trip. Yields normalized events; the first event tells
 * routes/messages.js whether it can still fail over (error+retryable) or is
 * committed (any content event), then text/thinking/tool_call, then done.
 *
 * @param {{prompt, model, options?}} reqArgs
 * @param {{accessToken, ghostMode, proxyUrl}} creds
 */
export async function* streamAgentRun(reqArgs, creds) {
  const body = encodeRunRequest({ prompt: reqArgs.prompt, model: reqArgs.model, options: reqArgs.options || [] });
  const client = await connectHttp2(AGENT.HOST, creds.proxyUrl || null);
  let stream;
  try {
    stream = client.request({
      ":method": "POST",
      ":path": AGENT.PATH,
      ":authority": AGENT.HOST,
      ":scheme": "https",
      ...buildAgentHeaders(creds.accessToken, creds.ghostMode !== false),
    });
    stream.write(Buffer.from(body));
    stream.end();

    const status = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("agent HTTP/2 request timed out")), H2_TIMEOUT_MS);
      stream.once("response", (h) => { clearTimeout(to); resolve(Number(h[":status"])); });
      stream.once("error", (e) => { clearTimeout(to); reject(e); });
      client.once("error", (e) => { clearTimeout(to); reject(e); });
    });

    if (status !== 200) {
      let errBuf = Buffer.alloc(0);
      try { for await (const c of stream) { errBuf = Buffer.concat([errBuf, c]); if (errBuf.length > 8192) break; } } catch {}
      yield { type: "error", status, error: `[${status}] ${errBuf.toString() || "agent API error"}`, retryable: true };
      return;
    }

    const decoder = new AgentStreamDecoder();
    for await (const chunk of stream) {
      for (const ev of decoder.push(chunk)) yield ev;
      if (decoder.stopped) break;
    }
    yield { type: "done", stopReason: decoder.toolEmitted ? "tool_use" : "end_turn" };
  } finally {
    try { client.close(); } catch {}
  }
}

/** Buffered round-trip. Same shape as the protobuf executor's callCursor(). */
export async function callAgentRun(reqArgs, creds) {
  let text = "";
  let thinking = "";
  const toolCalls = [];
  let error = null;
  let status = 200;
  for await (const ev of streamAgentRun(reqArgs, creds)) {
    if (ev.type === "error") { error = ev.error; status = ev.status || 500; break; }
    else if (ev.type === "text") text += ev.text;
    else if (ev.type === "thinking") thinking += ev.text;
    else if (ev.type === "tool_call") toolCalls.push({ id: ev.id, type: "function", function: { ...ev.function } });
  }
  return { status, error, text, thinking, toolCalls };
}
