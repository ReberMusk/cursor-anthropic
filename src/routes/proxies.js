/** Proxy-pool management routes (admin-protected). */
import { Router } from "express";
import { proxyPools } from "../db/repos.js";
import { requireAdmin } from "../auth/admin.js";
import { testProxy } from "../lib/proxyAgent.js";

const router = Router();
router.use("/api/proxy-pools", requireAdmin);

const pub = (p) => ({
  id: p.id, name: p.name, strategy: p.strategy,
  proxies: (() => { try { return JSON.parse(p.proxies || "[]"); } catch { return []; } })(),
  count: (() => { try { return JSON.parse(p.proxies || "[]").length; } catch { return 0; } })(),
  is_active: !!p.is_active, created_at: p.created_at, updated_at: p.updated_at,
});

router.get("/api/proxy-pools", async (req, res) => {
  const list = await proxyPools.list();
  res.json({ pools: list.map(pub) });
});

router.post("/api/proxy-pools", async (req, res) => {
  const { name, strategy, proxies } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const pool = await proxyPools.create({ name, strategy, proxies: Array.isArray(proxies) ? proxies : [] });
  res.status(201).json({ pool: pub(pool) });
});

router.patch("/api/proxy-pools/:id", async (req, res) => {
  const p = await proxyPools.get(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) fields.name = b.name;
  if (b.strategy !== undefined) fields.strategy = b.strategy;
  if (b.proxies !== undefined) fields.proxies = Array.isArray(b.proxies) ? b.proxies : [];
  if (b.is_active !== undefined) fields.is_active = b.is_active ? 1 : 0;
  res.json({ pool: pub(await proxyPools.update(req.params.id, fields)) });
});

router.delete("/api/proxy-pools/:id", async (req, res) => {
  await proxyPools.remove(req.params.id);
  res.json({ ok: true });
});

// Test a single proxy URL or every proxy in a pool.
router.post("/api/proxy-pools/test", async (req, res) => {
  const { proxyUrl, poolId } = req.body || {};
  if (proxyUrl) return res.json({ results: [{ proxyUrl, ...(await testProxy(proxyUrl)) }] });
  if (poolId) {
    const p = await proxyPools.get(poolId);
    if (!p) return res.status(404).json({ error: "pool not found" });
    let list = []; try { list = JSON.parse(p.proxies || "[]"); } catch {}
    const results = [];
    for (const url of list) results.push({ proxyUrl: url, ...(await testProxy(url)) });
    return res.json({ results });
  }
  res.status(400).json({ error: "proxyUrl or poolId required" });
});

export default router;
