/**
 * Repositories over the DB driver (SQLite or MySQL). All methods are async and
 * use positional `?` placeholders so the same SQL runs on both backends.
 * Timestamps are ISO strings; booleans are stored as 0|1.
 */
import crypto from "crypto";
import { getDriver } from "./driver.js";
import { cacheGet, cacheSet, cacheDel } from "../cache/index.js";

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const db = () => getDriver();

// ---------------- Accounts ----------------
export const accounts = {
  async create(a) {
    const d = db();
    const id = a.id || uid();
    const ts = now();
    const row = await d.get("SELECT COALESCE(MAX(priority),0) AS m FROM cursor_accounts");
    const maxP = row?.m || 0;
    const priority = Number.isInteger(a.priority) && a.priority > 0 ? a.priority : maxP + 1;
    await d.run(
      `INSERT INTO cursor_accounts
        (id, name, email, user_id, access_token, machine_id, mac_machine_id, ghost_mode,
         priority, is_active, status, expires_at, proxy_pool_id, proxy_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,'active',?,?,?,?,?)`,
      [
        id, a.name || null, a.email || null, a.user_id || null, a.access_token,
        a.machine_id, a.mac_machine_id || null, a.ghost_mode === false ? 0 : 1,
        priority, a.expires_at || null, a.proxy_pool_id || null, a.proxy_url || null, ts, ts,
      ]
    );
    return this.get(id);
  },
  async get(id) { return db().get("SELECT * FROM cursor_accounts WHERE id=?", [id]); },
  async getByEmail(email) {
    if (!email) return null;
    return db().get("SELECT * FROM cursor_accounts WHERE email=?", [email]);
  },
  async getByUserId(userId) {
    if (!userId) return null;
    return db().get("SELECT * FROM cursor_accounts WHERE user_id=?", [userId]);
  },
  async getByToken(token) { return db().get("SELECT * FROM cursor_accounts WHERE access_token=?", [token]); },
  async list() { return db().all("SELECT * FROM cursor_accounts ORDER BY priority ASC, created_at ASC"); },
  async activeForScheduling() {
    return db().all("SELECT * FROM cursor_accounts WHERE is_active=1 ORDER BY priority ASC, created_at ASC");
  },
  async update(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return this.get(id);
    const set = cols.map((c) => `${c}=?`).join(", ");
    const params = cols.map((c) => fields[c]);
    await db().run(`UPDATE cursor_accounts SET ${set}, updated_at=? WHERE id=?`, [...params, now(), id]);
    return this.get(id);
  },
  async touch(id, fields = {}) { return this.update(id, { last_used_at: now(), ...fields }); },
  async bumpUsage(id) {
    const t = now();
    await db().run("UPDATE cursor_accounts SET total_requests=total_requests+1, last_used_at=?, updated_at=? WHERE id=?", [t, t, id]);
  },
  async remove(id) { await db().run("DELETE FROM cursor_accounts WHERE id=?", [id]); },
  async setActive(id, active) { return this.update(id, { is_active: active ? 1 : 0, status: active ? "active" : "disabled" }); },
};

// ---------------- Proxy pools ----------------
export const proxyPools = {
  async create(p) {
    const id = p.id || uid();
    const ts = now();
    await db().run(
      `INSERT INTO proxy_pools (id, name, strategy, proxies, is_active, created_at, updated_at)
       VALUES (?,?,?,?,1,?,?)`,
      [id, p.name, p.strategy || "round-robin", JSON.stringify(p.proxies || []), ts, ts]
    );
    return this.get(id);
  },
  async get(id) { return db().get("SELECT * FROM proxy_pools WHERE id=?", [id]); },
  async list() { return db().all("SELECT * FROM proxy_pools ORDER BY created_at ASC"); },
  async update(id, fields) {
    const f = { ...fields };
    if (Array.isArray(f.proxies)) f.proxies = JSON.stringify(f.proxies);
    const cols = Object.keys(f);
    if (!cols.length) return this.get(id);
    const set = cols.map((c) => `${c}=?`).join(", ");
    await db().run(`UPDATE proxy_pools SET ${set}, updated_at=? WHERE id=?`, [...cols.map((c) => f[c]), now(), id]);
    return this.get(id);
  },
  async remove(id) { await db().run("DELETE FROM proxy_pools WHERE id=?", [id]); },
  /** Pick the next proxy URL from a pool, advancing its round-robin cursor. */
  async nextProxy(id) {
    const pool = await this.get(id);
    if (!pool || !pool.is_active) return null;
    let list = [];
    try { list = JSON.parse(pool.proxies || "[]"); } catch { list = []; }
    if (!list.length) return null;
    if (pool.strategy === "random") return list[Math.floor(Math.random() * list.length)];
    const idx = (pool.cursor || 0) % list.length;
    await db().run("UPDATE proxy_pools SET `cursor`=? WHERE id=?", [(idx + 1) % list.length, id]);
    return list[idx];
  },
};

// ---------------- Admins ----------------
export const admins = {
  async create(username, passwordHash, mustChange = 0) {
    const id = uid();
    await db().run("INSERT INTO admins (id, username, password_hash, must_change, created_at) VALUES (?,?,?,?,?)",
      [id, username, passwordHash, mustChange ? 1 : 0, now()]);
    return this.getByUsername(username);
  },
  async getByUsername(username) { return db().get("SELECT * FROM admins WHERE username=?", [username]); },
  async count() { const r = await db().get("SELECT COUNT(*) AS c FROM admins"); return r?.c || 0; },
  async setPassword(id, passwordHash) {
    await db().run("UPDATE admins SET password_hash=?, must_change=0 WHERE id=?", [passwordHash, id]);
  },
};

// ---------------- API keys (sk-...) ----------------
const API_KEYS_CACHE = "apikeys:active";
export const apiKeys = {
  async create({ name, keyHash, keyPrefix }) {
    const id = uid();
    await db().run(`INSERT INTO api_keys (id, name, key_hash, key_prefix, is_active, total_requests, created_at)
                    VALUES (?,?,?,?,1,0,?)`, [id, name || null, keyHash, keyPrefix || null, now()]);
    await cacheDel(API_KEYS_CACHE);
    return this.get(id);
  },
  async get(id) { return db().get("SELECT * FROM api_keys WHERE id=?", [id]); },
  async list() {
    return db().all("SELECT id,name,key_prefix,is_active,last_used_at,total_requests,created_at FROM api_keys ORDER BY created_at ASC");
  },
  /** Active keys, cached briefly (read on every public request). */
  async activeList() {
    const hit = await cacheGet(API_KEYS_CACHE);
    if (hit) return hit;
    const rows = await db().all("SELECT * FROM api_keys WHERE is_active=1");
    await cacheSet(API_KEYS_CACHE, rows, 5000);
    return rows;
  },
  async setActive(id, active) {
    await db().run("UPDATE api_keys SET is_active=? WHERE id=?", [active ? 1 : 0, id]);
    await cacheDel(API_KEYS_CACHE);
    return this.get(id);
  },
  async remove(id) { await db().run("DELETE FROM api_keys WHERE id=?", [id]); await cacheDel(API_KEYS_CACHE); },
  async markUsed(id) {
    await db().run("UPDATE api_keys SET last_used_at=?, total_requests=total_requests+1 WHERE id=?", [now(), id]);
  },
  async count() { const r = await db().get("SELECT COUNT(*) AS c FROM api_keys WHERE is_active=1"); return r?.c || 0; },
};

// ---------------- Settings (key/value, cached) ----------------
const SETTINGS_CACHE = "settings:all";
export const settings = {
  async all() {
    const hit = await cacheGet(SETTINGS_CACHE);
    if (hit) return hit;
    const rows = await db().all("SELECT `key`,`value` FROM settings");
    const out = {};
    for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; } }
    await cacheSet(SETTINGS_CACHE, out, 5000);
    return out;
  },
  async get(key, fallback = null) {
    const all = await this.all();
    return key in all ? all[key] : fallback;
  },
  async set(key, value) {
    const d = db();
    const json = JSON.stringify(value);
    if (d.dialect === "mysql") {
      await d.run("INSERT INTO settings (`key`,`value`) VALUES (?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)", [key, json]);
    } else {
      await d.run("INSERT INTO settings (`key`,`value`) VALUES (?,?) ON CONFLICT(`key`) DO UPDATE SET `value`=excluded.`value`", [key, json]);
    }
    await cacheDel(SETTINGS_CACHE);
    return value;
  },
};

// ---------------- Usage log ----------------
export const usage = {
  async record({ accountId, apiKeyId, model, status, ok }) {
    await db().run(`INSERT INTO usage_log (account_id, api_key_id, model, status, ok, created_at)
                    VALUES (?,?,?,?,?,?)`, [accountId || null, apiKeyId || null, model || null, status || null, ok ? 1 : 0, now()]);
  },
  async stats(sinceMs = 24 * 60 * 60 * 1000) {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const d = db();
    const total = (await d.get("SELECT COUNT(*) AS c FROM usage_log WHERE created_at>=?", [since]))?.c || 0;
    const ok = (await d.get("SELECT COUNT(*) AS c FROM usage_log WHERE created_at>=? AND ok=1", [since]))?.c || 0;
    return { total, ok, errors: total - ok, since };
  },
};

export const SCHED_DEFAULTS = {
  strategy: "fill-first", // fill-first | round-robin
  stickyLimit: 3,
  backoffBaseMs: 2000,
  backoffMaxMs: 5 * 60 * 1000,
  backoffMaxLevel: 8,
  transientCooldownMs: 30 * 1000,
};

export const GATEWAY_DEFAULTS = {
  // Emit Cursor's `thinking` as Anthropic thinking blocks. OFF by default because
  // these blocks carry no Anthropic signature and some clients reject them.
  emitThinking: false,
};
