/** Account management routes (admin-protected). */
import { Router } from "express";
import { accounts, proxyPools } from "../db/repos.js";
import { requireAdmin } from "../auth/admin.js";
import { importAccount, bulkImport, publicAccount } from "../lib/accountService.js";
import { callCursor } from "../gateway/executor.js";
import { resolveProxyForAccount } from "../scheduler/selectAccount.js";
import { markUnavailable, markSuccess } from "../scheduler/fallback.js";
import { generateCursorIds } from "../lib/machineId.js";
import { fetchUsageSummary } from "../lib/cursorUsage.js";

/** A request opts a token check IN unless it explicitly passes check:false. */
const wantsCheck = (body) => body?.check !== false && body?.checkToken !== false;

const router = Router();
router.use("/api/accounts", requireAdmin);

router.get("/api/accounts", async (req, res) => {
  const list = await accounts.list();
  res.json({ accounts: list.map(publicAccount) });
});

router.post("/api/accounts", async (req, res) => {
  try {
    const body = req.body || {};
    const { account, created, usage } = await importAccount(body, { check: wantsCheck(body) });
    res.status(created ? 201 : 200).json({ account: publicAccount(account), created, usage: usage || null });
  } catch (e) {
    // token-validation failures are a 422 so the UI can distinguish them
    res.status(e.tokenInvalid ? 422 : 400).json({ error: e.message, tokenInvalid: !!e.tokenInvalid });
  }
});

router.post("/api/accounts/bulk-import", async (req, res) => {
  // body may be { text } | { accounts:[...] } | a raw array
  const payload = Array.isArray(req.body) ? req.body : (req.body?.text ?? req.body);
  const check = Array.isArray(req.body) ? true : wantsCheck(req.body);
  const summary = await bulkImport(payload, { check });
  res.json(summary);
});

// Apply an action to many accounts at once: delete | activate | deactivate | reset-cooldown.
router.post("/api/accounts/bulk-action", async (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids required" });
  const valid = new Set(["delete", "activate", "deactivate", "reset-cooldown"]);
  if (!valid.has(action)) return res.status(400).json({ error: `unknown action: ${action}` });

  let affected = 0;
  for (const id of ids) {
    const a = await accounts.get(id);
    if (!a) continue;
    if (action === "delete") await accounts.remove(id);
    else if (action === "activate") await accounts.setActive(id, true);
    else if (action === "deactivate") await accounts.setActive(id, false);
    else if (action === "reset-cooldown") {
      await accounts.update(id, { status: "active", cooldown_until: null, backoff_level: 0, last_error: null });
    }
    affected++;
  }
  res.json({ ok: true, affected });
});

router.get("/api/accounts/:id", async (req, res) => {
  const a = await accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json({ account: publicAccount(a) });
});

router.patch("/api/accounts/:id", async (req, res) => {
  const a = await accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  const allowed = {};
  const b = req.body || {};
  if (b.name !== undefined) allowed.name = b.name;
  if (b.priority !== undefined) allowed.priority = Number(b.priority);
  if (b.ghost_mode !== undefined) allowed.ghost_mode = b.ghost_mode ? 1 : 0;
  if (b.proxy_url !== undefined) allowed.proxy_url = b.proxy_url || null;
  if (b.proxy_pool_id !== undefined) allowed.proxy_pool_id = b.proxy_pool_id || null;
  if (b.machine_id !== undefined && b.machine_id) allowed.machine_id = b.machine_id;
  if (b.is_active !== undefined) { allowed.is_active = b.is_active ? 1 : 0; allowed.status = b.is_active ? "active" : "disabled"; }
  res.json({ account: publicAccount(await accounts.update(req.params.id, allowed)) });
});

router.post("/api/accounts/:id/activate", async (req, res) => {
  const a = await accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json({ account: publicAccount(await accounts.setActive(req.params.id, true)) });
});

router.post("/api/accounts/:id/deactivate", async (req, res) => {
  const a = await accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json({ account: publicAccount(await accounts.setActive(req.params.id, false)) });
});

router.post("/api/accounts/:id/reset-cooldown", async (req, res) => {
  const a = await accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json({ account: publicAccount(await accounts.update(req.params.id, { status: "active", cooldown_until: null, backoff_level: 0, last_error: null })) });
});

router.post("/api/accounts/:id/regenerate-machine-id", async (req, res) => {
  const a = await accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  // Re-derive deterministically from the token so it stays stable thereafter.
  const ids = generateCursorIds(a.access_token);
  res.json({ account: publicAccount(await accounts.update(req.params.id, { machine_id: ids.machineId, mac_machine_id: ids.macMachineId })) });
});

// Live test: send a tiny probe to Cursor with this account.
router.post("/api/accounts/:id/test", async (req, res) => {
  const a = await accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  const proxyUrl = await resolveProxyForAccount(a, proxyPools);
  const model = req.body?.model || process.env.CURSOR_MODEL || "claude-4-sonnet";
  try {
    const decoded = await callCursor(
      { messages: [{ role: "user", content: "Reply with the single word: ok" }], model, tools: [], supportedIds: null, thinkingLevel: null, forceAgentMode: false },
      { accessToken: a.access_token, machineId: a.machine_id, ghostMode: !!a.ghost_mode, proxyUrl }
    );
    if (decoded.error && !decoded.text) {
      await markUnavailable(a.id, decoded.status || 500, decoded.error);
      return res.json({ ok: false, status: decoded.status, error: decoded.error, account: publicAccount(await accounts.get(a.id)) });
    }
    await markSuccess(a.id);
    res.json({ ok: true, model, text: (decoded.text || "").slice(0, 200), account: publicAccount(await accounts.get(a.id)) });
  } catch (e) {
    await markUnavailable(a.id, 502, e.message);
    res.json({ ok: false, error: e.message, account: publicAccount(await accounts.get(a.id)) });
  }
});

// Refresh an account's last-30-day usage (also re-validates the token).
router.post("/api/accounts/:id/usage", async (req, res) => {
  const a = await accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  const proxyUrl = await resolveProxyForAccount(a, proxyPools);
  const usage = await fetchUsageSummary({ accessToken: a.access_token, userId: a.user_id, proxyUrl });
  if (!usage.ok) {
    return res.json({ ok: false, status: usage.status, error: usage.error, account: publicAccount(a) });
  }
  const updated = await accounts.update(a.id, {
    usage_cents: usage.totalCents ?? null,
    usage_events: usage.includedEvents ?? null,
    usage_checked_at: new Date().toISOString(),
    last_active_at: usage.lastActiveAt || null,
  });
  res.json({ ok: true, usage, account: publicAccount(updated) });
});

router.delete("/api/accounts/:id", async (req, res) => {
  await accounts.remove(req.params.id);
  res.json({ ok: true });
});

export default router;
