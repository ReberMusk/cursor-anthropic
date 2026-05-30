/** Outbound API-key (sk-...) management routes (admin-protected). */
import { Router } from "express";
import { apiKeys } from "../db/repos.js";
import { requireAdmin } from "../auth/admin.js";
import { generateKey } from "../auth/apikey.js";

const router = Router();
router.use("/api/keys", requireAdmin);

router.get("/api/keys", async (req, res) => {
  res.json({ keys: await apiKeys.list(), envKeySet: !!process.env.GATEWAY_API_KEY });
});

router.post("/api/keys", async (req, res) => {
  const { name } = req.body || {};
  const { key, record } = await generateKey(name);
  // plaintext key returned ONCE
  res.status(201).json({ key, record });
});

router.post("/api/keys/:id/activate", async (req, res) => {
  res.json({ key: await apiKeys.setActive(req.params.id, true) });
});

router.post("/api/keys/:id/deactivate", async (req, res) => {
  res.json({ key: await apiKeys.setActive(req.params.id, false) });
});

router.delete("/api/keys/:id", async (req, res) => {
  await apiKeys.remove(req.params.id);
  res.json({ ok: true });
});

export default router;
