/**
 * Public Anthropic endpoint: POST /v1/messages
 *
 * Wraps the single-account gateway core with the multi-account scheduler:
 * select account -> translate -> call Cursor (optionally via proxy) -> on
 * failure mark cooldown + fail over to the next account -> on success translate
 * the response back to Anthropic SSE/JSON.
 */
import { Router } from "express";
import { callCursor, streamCursor } from "../gateway/executor.js";
import { claudeToCursor, buildAnthropicMessage, buildAnthropicSSE, createSSEStream } from "../gateway/translate.js";
import { parseToolMarkers } from "../gateway/toolSim.js";
import { mapModel } from "../gateway/constants.js";
import { selectAccount, resolveProxyForAccount } from "../scheduler/selectAccount.js";
import { markUnavailable, markSuccess, isAccountError } from "../scheduler/fallback.js";
import { accounts, proxyPools, usage, settings, GATEWAY_DEFAULTS } from "../db/repos.js";
import { requireApiKey } from "../auth/apikey.js";

const router = Router();

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}] [messages]`, ...a);
const logWarn = (...a) => console.warn(`[${ts()}] [messages]`, ...a);
const logErr = (...a) => console.error(`[${ts()}] [messages]`, ...a);
const short = (s, n = 200) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };

function anthropicError(res, status, type, message, extra = {}) {
  res.status(status).json({ type: "error", error: { type, message, ...extra } });
}

function inputTextOf(body) {
  try { return JSON.stringify(body.messages || []) + JSON.stringify(body.system || ""); }
  catch { return ""; }
}

router.post("/v1/messages", requireApiKey, async (req, res) => {
  const body = req.body || {};
  if (!body.messages) return anthropicError(res, 400, "invalid_request_error", "Missing 'messages'");

  const stream = body.stream !== false;
  const ua = req.headers["user-agent"] || "";

  const model = mapModel(body.model);
  const inputText = inputTextOf(body);
  const strategy = ((await settings.get("scheduler")) || {}).strategy;
  const gateway = { ...GATEWAY_DEFAULTS, ...((await settings.get("gateway")) || {}) };

  // Tool calling: Cursor's backend never exposes client-declared tools to the
  // model (verified: they're dropped, and the model calls a native tool that
  // leaks to the client). So when the request carries tools we SIMULATE function
  // calling via prompt engineering — describe the tools, run Cursor in plain Chat
  // mode (no native tools injected), and parse the model's marker output back
  // into Anthropic tool_use. "native" keeps the legacy native-mapping behavior.
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const toolMode = gateway.toolMode || "simulate";
  const simulate = hasTools && toolMode !== "native";

  const { messages, tools, supportedIds, thinkingLevel } = claudeToCursor(body, { simulate });

  // Cursor conversation mode. Default "agent" so the model actually calls tools;
  // otherwise a plain prompt (no tools) lands in Ask mode and Cursor refuses to
  // write files / run commands. "auto" keeps the old UA-sniffing behavior.
  // Simulation MUST run in AGENT mode: in Ask mode Cursor's own system prompt
  // makes the model refuse "write" tools ("switch to agent mode"). In Agent mode
  // — with NO native tool ids enabled (supportedIds=[]) and our marker
  // instructions — the model emits our tool-call markers and does NOT touch
  // Cursor's native tools (verified live).
  const cursorMode = gateway.cursorMode || "agent";
  const forceAgentMode = simulate
    ? true
    : cursorMode === "agent" ? true
    : cursorMode === "ask" ? false
    : /claude-cli|claude-code/i.test(ua);

  // Tool simulation can't stream (a marker block must be parsed whole), so buffer.
  const buffered = !stream || simulate;

  const startedAt = Date.now();
  log(`→ model=${body.model || "?"}→${model} mode=${simulate ? "simulate" : cursorMode} stream=${stream} tools=${(body.tools || []).length}`);

  const exclude = new Set();
  let lastError = null;
  let lastStatus = 500;

  const fail = async (acc, status, errText) => {
    lastError = errText; lastStatus = status || 500;
    exclude.add(acc.id);
    logWarn(`✗ account=${acc.name || acc.user_id || acc.id} status=${status || 500} error="${short(errText)}" — failing over`);
    await markUnavailable(acc.id, status || 500, errText);
    await usage.record({ accountId: acc.id, apiKeyId: req.apiKeyId, model, status: status || 500, ok: false });
  };
  const succeed = async (acc) => {
    log(`✓ account=${acc.name || acc.user_id || acc.id} model=${model} ${Date.now() - startedAt}ms`);
    await markSuccess(acc.id);
    await accounts.bumpUsage(acc.id);
    await usage.record({ accountId: acc.id, apiKeyId: req.apiKeyId, model, status: 200, ok: true });
  };
  // A request/parameter error (not the account's fault, e.g. "Max Mode
  // Required"): record it but DO NOT cool down / disable the account.
  const requestError = async (acc, status, errText) => {
    logWarn(`✗ request error (not account-level) account=${acc.name || acc.user_id || acc.id} status=${status} error="${short(errText)}" — returning to client`);
    await usage.record({ accountId: acc.id, apiKeyId: req.apiKeyId, model, status: status || 400, ok: false });
  };
  // Request/parameter errors are client problems, not server failures — surface
  // them as 400 (invalid_request_error) regardless of the upstream status.
  const httpFor = () => 400;

  // try accounts until one succeeds or all are exhausted
  for (let attempt = 0; attempt < 50; attempt++) {
    const pick = await selectAccount({ strategy, exclude });
    if (pick.allUnavailable) {
      if (lastError) {
        logErr(`✗✗ all accounts exhausted after ${attempt} attempt(s); last status=${lastStatus} error="${short(lastError)}"`);
        return anthropicError(res, lastStatus === 429 ? 429 : 502,
          lastStatus === 429 ? "rate_limit_error" : "api_error",
          `All Cursor accounts exhausted. Last error: ${lastError}`,
          pick.retryAfter ? { retry_after: pick.retryAfter } : {});
      }
      if (pick.reason === "no_accounts") {
        logErr("✗✗ no Cursor accounts configured");
        return anthropicError(res, 503, "api_error", "No Cursor accounts configured");
      }
      // accounts exist but are all cooling down — treat as a rate limit so clients
      // back off using retry_after instead of hammering.
      logWarn(`✗ all accounts cooling down (rate-limited); retry_after=${pick.retryAfter || "?"}`);
      return anthropicError(res, 429, "rate_limit_error",
        "All Cursor accounts are cooling down (rate-limited)",
        pick.retryAfter ? { retry_after: pick.retryAfter } : {});
    }

    const acc = pick.account;
    const proxyUrl = await resolveProxyForAccount(acc, proxyPools);
    const creds = { accessToken: acc.access_token, machineId: acc.machine_id, ghostMode: !!acc.ghost_mode, proxyUrl };
    const reqArgs = { messages, model, tools, supportedIds, thinkingLevel, forceAgentMode };

    if (!buffered) {
      // True streaming. Fail over is only possible before the first byte is sent
      // to the client; the generator's first event tells us if it's retryable.
      const gen = streamCursor(reqArgs, creds);
      let first;
      try { first = await gen.next(); }
      catch (e) { await fail(acc, 502, e.message); continue; }

      const ev0 = first.value;
      if (!first.done && ev0?.type === "error" && ev0.retryable) {
        try { await gen.return(); } catch {}
        if (isAccountError(ev0.status, ev0.error, gateway)) {
          await fail(acc, ev0.status, ev0.error);
          continue;
        }
        // request/parameter error — keep the account healthy, return to client
        await requestError(acc, ev0.status, ev0.error);
        return anthropicError(res, httpFor(ev0.status), "invalid_request_error", ev0.error || "Cursor request error");
      }

      // committed to this account
      await succeed(acc);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-cursor-account": acc.id,
      });
      const emitter = createSSEStream(body.model, inputText, { emitThinking: gateway.emitThinking });
      res.write(emitter.start());

      const handle = (ev) => {
        if (ev?.type === "text") res.write(emitter.text(ev.text));
        else if (ev?.type === "thinking") res.write(emitter.thinking(ev.text));
        else if (ev?.type === "tool_call") res.write(emitter.toolCall(ev));
      };

      let stopReason;
      if (!first.done) {
        if (ev0.type === "done") stopReason = ev0.stopReason;
        else handle(ev0);
      }
      if (stopReason === undefined) {
        try {
          for await (const ev of gen) {
            if (ev.type === "done") { stopReason = ev.stopReason; break; }
            if (ev.type === "error") break; // mid-stream error after content — just end cleanly
            handle(ev);
          }
        } catch { /* connection dropped mid-stream */ }
      }
      res.write(emitter.end(stopReason));
      return res.end();
    }

    // non-streaming (buffered)
    let decoded;
    try { decoded = await callCursor(reqArgs, creds); }
    catch (e) { await fail(acc, 502, e.message); continue; }

    const hasContent = decoded.text || (decoded.toolCalls || []).length;
    if (decoded.error && !hasContent) {
      if (isAccountError(decoded.status || 500, decoded.error, gateway)) {
        await fail(acc, decoded.status || 500, decoded.error);
        continue;
      }
      // request/parameter error — keep the account healthy, return to client
      await requestError(acc, decoded.status, decoded.error);
      return anthropicError(res, httpFor(decoded.status), "invalid_request_error", decoded.error);
    }

    // Tool simulation: parse the model's marker output into real tool_use calls
    // (correct client tool names + structured input), strip markers from text.
    if (simulate) {
      const parsed = parseToolMarkers(decoded.text || "");
      decoded.text = parsed.text;
      decoded.toolCalls = parsed.toolCalls.map((tc) => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
    }

    await succeed(acc);
    if (stream) {
      // Buffered-but-client-wanted-stream (tool simulation): emit the whole
      // Anthropic SSE sequence at once from the decoded result.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-cursor-account": acc.id,
      });
      res.write(buildAnthropicSSE(decoded, body.model, inputText));
      return res.end();
    }
    res.setHeader("x-cursor-account", acc.id);
    return res.json(buildAnthropicMessage(decoded, body.model, inputText, { emitThinking: gateway.emitThinking }));
  }

  logErr(`✗✗ retry loop exhausted; last error="${short(lastError) || "unknown"}"`);
  return anthropicError(res, 502, "api_error", `Exhausted all accounts. Last error: ${lastError || "unknown"}`);
});

// Token counting (rough estimate; Claude Code calls this)
router.post("/v1/messages/count_tokens", requireApiKey, (req, res) => {
  const est = Math.max(1, Math.ceil(inputTextOf(req.body || {}).length / 4));
  res.json({ input_tokens: est });
});

export default router;
