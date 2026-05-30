/**
 * Optional cache layer. Used to accelerate the hot read paths that run on every
 * /v1/messages call (scheduler settings + active API keys), which would
 * otherwise hit the DB several times per request.
 *
 * Backend:
 *   - REDIS_URL set  -> Redis (ioredis), shared across gateway instances.
 *   - otherwise      -> in-process Map with TTL (single instance).
 *
 * All values are JSON-serialized. Reads fall back gracefully to the DB on any
 * cache error, so the cache is never on the critical path for correctness.
 */
let redis = null;
const mem = new Map(); // key -> { v, exp }

export async function initCache() {
  if (!process.env.REDIS_URL) return { backend: "memory" };
  try {
    const { default: Redis } = await import("ioredis");
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    redis.on("error", (e) => {
      // Don't crash on transient Redis hiccups; we degrade to DB reads.
      if (!redis.__warned) { console.warn(`[cache] redis error: ${e.message} — degrading to DB`); redis.__warned = true; }
    });
    return { backend: "redis" };
  } catch (e) {
    console.warn(`[cache] ioredis unavailable (${e.message}) — using memory cache`);
    return { backend: "memory" };
  }
}

export async function closeCache() {
  if (redis) { try { await redis.quit(); } catch {} redis = null; }
  mem.clear();
}

const PREFIX = "ca:";

export async function cacheGet(key) {
  const k = PREFIX + key;
  if (redis) {
    try { const v = await redis.get(k); return v ? JSON.parse(v) : null; }
    catch { /* fall through to memory */ }
  }
  const e = mem.get(k);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(k); return null; }
  return e.v;
}

export async function cacheSet(key, value, ttlMs = 5000) {
  const k = PREFIX + key;
  if (redis) {
    try { await redis.set(k, JSON.stringify(value), "PX", ttlMs); return; }
    catch { /* fall through to memory */ }
  }
  mem.set(k, { v: value, exp: ttlMs ? Date.now() + ttlMs : 0 });
}

export async function cacheDel(key) {
  const k = PREFIX + key;
  if (redis) { try { await redis.del(k); } catch {} }
  mem.delete(k);
}

/** Read-through helper: return cached value or compute+cache it. */
export async function cacheWrap(key, ttlMs, compute) {
  const hit = await cacheGet(key);
  if (hit !== null && hit !== undefined) return hit;
  const val = await compute();
  if (val !== null && val !== undefined) await cacheSet(key, val, ttlMs);
  return val;
}
