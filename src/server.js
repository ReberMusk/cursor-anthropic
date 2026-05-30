/**
 * cursor-anthropic server.
 *
 * - POST /v1/messages         Anthropic-compatible endpoint (sk API-key auth),
 *                             backed by a scheduled pool of Cursor accounts.
 * - /api/*                    Admin REST API (JWT cookie auth).
 * - everything else           Serves the HeroUI admin SPA (web/dist) if built.
 */
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { initDb } from "./db/index.js";
import { initCache } from "./cache/index.js";
import { ensureAdmin } from "./auth/admin.js";

import messagesRouter from "./routes/messages.js";
import authRouter from "./routes/auth.js";
import accountsRouter from "./routes/accounts.js";
import proxiesRouter from "./routes/proxies.js";
import keysRouter from "./routes/keys.js";
import settingsRouter from "./routes/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const WEB_DIST = path.resolve(__dirname, "../web/dist");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "25mb" }));
app.use(express.text({ type: "text/plain", limit: "25mb" }));

// health
app.get("/health", (req, res) => res.json({ ok: true, service: "cursor-anthropic" }));

// public API
app.use(messagesRouter);

// admin API
app.use(authRouter);
app.use(accountsRouter);
app.use(proxiesRouter);
app.use(keysRouter);
app.use(settingsRouter);

// static admin SPA (if built)
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^(?!\/(api|v1|health)).*/, (req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.type("html").send(
      `<h1>cursor-anthropic</h1><p>API is running. Admin UI not built yet — run <code>npm run build</code> then restart, or use <code>npm run web:dev</code> for the dev server.</p>`
    );
  });
}

// error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: { type: "api_error", message: err.message } });
});

async function boot() {
  const cache = await initCache();
  const driver = await initDb();
  const seed = await ensureAdmin();
  console.log(`storage: ${driver.dialect}   cache: ${cache.backend}`);
  if (seed.created) {
    console.log("──────────────────────────────────────────────");
    console.log("  Initial admin account created:");
    console.log(`    username: ${seed.username}`);
    if (seed.generatedPassword) {
      console.log(`    password: ${seed.generatedPassword}   (generated — change it after first login)`);
    } else {
      console.log(`    password: (from ADMIN_PASSWORD env)`);
    }
    console.log("──────────────────────────────────────────────");
  }

  app.listen(PORT, () => {
    console.log(`cursor-anthropic listening on http://localhost:${PORT}`);
    console.log(`  POST /v1/messages      (Anthropic API, x-api-key: sk-..., true streaming)`);
    console.log(`  admin UI / REST        http://localhost:${PORT}/`);
    console.log(`  cursor model           ${process.env.CURSOR_MODEL || "(auto-mapped from request)"}`);
    if (!fs.existsSync(WEB_DIST)) console.log(`  (admin UI not built — run: npm run build)`);
  });
}

boot().catch((e) => {
  console.error("boot failed:", e);
  process.exit(1);
});
