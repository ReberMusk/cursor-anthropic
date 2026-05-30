/** Account management routes (admin-protected). */
import { Router } from "express";
import { accounts, proxyPools } from "../db/repos.js";
import { requireAdmin } from "../auth/admin.js";
import { importAccount, bulkImport, publicAccount } from "../lib/accountService.js";
import { callCursor } from "../gateway/executor.js";
import { resolveProxyForAccount } from "../scheduler/selectAccount.js";
import { markUnavailable, markSuccess } from "../scheduler/fallback.js";
import { generateCursorIds } from "../lib/machineId.js";

const router = Router();
router.use("/api/accounts", requireAdmin);

router.get("/api/accounts", async (req, res) => {
  const list = await accounts.list();
  res.json({ accounts: list.map(publicAccount) });
});

router.post("/api/accounts", async (req, res) => {
  try {
    const { account, created } = await importAccount(req.body || {});
    res.status(created ? 201 : 200).json({ account: publicAccount(account), created });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/api/accounts/bulk-import", async (req, res) => {
  // body may be { text } | { accounts:[...] } | a raw array
  const payload = Array.isArray(req.body) ? req.body : (req.body?.text ?? req.body);
  const summary = await bulkImport(payload);
  res.json(summary);
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

router.delete("/api/accounts/:id", async (req, res) => {
  await accounts.remove(req.params.id);
  res.json({ ok: true });
});

export default router;
