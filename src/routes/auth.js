/** Admin auth routes: login / logout / me / change-password. */
import { Router } from "express";
import { admins } from "../db/repos.js";
import { login, requireAdmin, setSessionCookie, clearSessionCookie, hashPassword, verifyPassword } from "../auth/admin.js";

const router = Router();

router.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  const result = await login(username, password);
  if (!result) return res.status(401).json({ error: "invalid credentials" });
  setSessionCookie(res, result.token);
  res.json({ ok: true, admin: result.admin });
});

router.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/api/auth/me", requireAdmin, async (req, res) => {
  const admin = await admins.getByUsername(req.admin.username);
  res.json({ id: admin?.id, username: admin?.username, mustChange: !!admin?.must_change });
});

router.post("/api/auth/change-password", requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: "new password too short (min 6)" });
  const admin = await admins.getByUsername(req.admin.username);
  if (!admin) return res.status(404).json({ error: "admin not found" });
  // allow skipping current-password check only when a forced change is pending
  if (!admin.must_change && !verifyPassword(currentPassword || "", admin.password_hash)) {
    return res.status(401).json({ error: "current password incorrect" });
  }
  await admins.setPassword(admin.id, hashPassword(newPassword));
  res.json({ ok: true });
});

export default router;
