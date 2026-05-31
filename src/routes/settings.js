/** Settings + dashboard routes (admin-protected). */
import { Router } from "express";
import { settings, accounts, apiKeys, proxyPools, usage, SCHED_DEFAULTS, GATEWAY_DEFAULTS } from "../db/repos.js";
import { requireAdmin } from "../auth/admin.js";

const router = Router();

router.get("/api/settings", requireAdmin, async (req, res) => {
  res.json({
    scheduler: { ...SCHED_DEFAULTS, ...((await settings.get("scheduler")) || {}) },
    gateway: { ...GATEWAY_DEFAULTS, ...((await settings.get("gateway")) || {}) },
    defaults: { scheduler: SCHED_DEFAULTS, gateway: GATEWAY_DEFAULTS },
  });
});

router.put("/api/settings/gateway", requireAdmin, async (req, res) => {
  const cur = { ...GATEWAY_DEFAULTS, ...((await settings.get("gateway")) || {}) };
  const b = req.body || {};
  const next = { ...cur };
  if (b.emitThinking !== undefined) next.emitThinking = !!b.emitThinking;
  if (b.cursorMode !== undefined && ["agent", "ask", "auto"].includes(b.cursorMode)) next.cursorMode = b.cursorMode;
  if (b.toolMode !== undefined && ["simulate", "native"].includes(b.toolMode)) next.toolMode = b.toolMode;
  if (b.accountErrorKeywords !== undefined) {
    const raw = b.accountErrorKeywords;
    const arr = Array.isArray(raw) ? raw : String(raw).split(/\r?\n/);
    next.accountErrorKeywords = arr.map((s) => String(s).trim()).filter(Boolean);
  }
  await settings.set("gateway", next);
  res.json({ gateway: next });
});

router.put("/api/settings/scheduler", requireAdmin, async (req, res) => {
  const cur = { ...SCHED_DEFAULTS, ...((await settings.get("scheduler")) || {}) };
  const b = req.body || {};
  const next = { ...cur };
  if (b.strategy && ["fill-first", "round-robin"].includes(b.strategy)) next.strategy = b.strategy;
  for (const k of ["stickyLimit", "backoffBaseMs", "backoffMaxMs", "backoffMaxLevel", "transientCooldownMs"]) {
    if (b[k] !== undefined && Number.isFinite(Number(b[k]))) next[k] = Number(b[k]);
  }
  await settings.set("scheduler", next);
  res.json({ scheduler: next });
});

router.get("/api/dashboard", requireAdmin, async (req, res) => {
  const list = await accounts.list();
  const byStatus = list.reduce((m, a) => {
    const s = a.is_active ? a.status : "disabled";
    m[s] = (m[s] || 0) + 1;
    return m;
  }, {});
  const now = Date.now();
  const cooling = list.filter((a) => a.cooldown_until && new Date(a.cooldown_until).getTime() > now).length;
  const [activeKeys, pools, usage24h] = await Promise.all([apiKeys.activeList(), proxyPools.list(), usage.stats()]);
  res.json({
    accounts: {
      total: list.length,
      active: list.filter((a) => a.is_active && a.status === "active").length,
      rate_limited: byStatus.rate_limited || 0,
      error: byStatus.error || 0,
      expired: byStatus.expired || 0,
      disabled: list.filter((a) => !a.is_active).length,
      cooling,
    },
    apiKeys: activeKeys.length,
    proxyPools: pools.length,
    usage24h,
  });
});

export default router;
