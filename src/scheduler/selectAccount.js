/**
 * Account selection for the request main loop.
 *
 * Strategies:
 *  - fill-first  : always take the highest-priority available account (stick to
 *                  one until it's rate-limited, then fail over). Default.
 *  - round-robin : spread load across available accounts with a small sticky
 *                  window so we don't thrash on every single request.
 *
 * "available" = is_active=1, not expired, and not currently in cooldown.
 */
import { accounts, settings, SCHED_DEFAULTS } from "../db/repos.js";

async function cfg() {
  return { ...SCHED_DEFAULTS, ...((await settings.get("scheduler")) || {}) };
}

const tms = (iso) => (iso ? new Date(iso).getTime() : 0);

/**
 * @param {{ strategy?:string, exclude?:Set<string> }} opts
 * @returns {Promise<{ account?:object, allUnavailable?:boolean, retryAfter?:string|null, reason?:string }>}
 */
export async function selectAccount({ strategy, exclude = new Set() } = {}) {
  const c = await cfg();
  strategy = strategy || c.strategy || "fill-first";
  const now = Date.now();

  const all = await accounts.activeForScheduling();
  if (!all.length) return { allUnavailable: true, retryAfter: null, reason: "no_accounts" };

  const available = all.filter(
    (a) =>
      !exclude.has(a.id) &&
      a.status !== "expired" &&
      !(a.cooldown_until && tms(a.cooldown_until) > now)
  );

  if (!available.length) {
    const soonest = all
      .map((a) => a.cooldown_until)
      .filter(Boolean)
      .sort()[0] || null;
    return { allUnavailable: true, retryAfter: soonest, reason: "all_cooling_down" };
  }

  if (strategy === "round-robin") {
    const sticky = c.stickyLimit || 3;
    // most-recently-used among available
    const mru = [...available].sort((a, b) => tms(b.last_used_at) - tms(a.last_used_at))[0];
    if (mru?.last_used_at && (mru.consecutive_use_count || 0) < sticky) {
      return { account: await accounts.touch(mru.id, { consecutive_use_count: (mru.consecutive_use_count || 0) + 1 }) };
    }
    // otherwise pick least-recently-used and reset its sticky counter
    const lru = [...available].sort((a, b) => tms(a.last_used_at) - tms(b.last_used_at))[0];
    return { account: await accounts.touch(lru.id, { consecutive_use_count: 1 }) };
  }

  // fill-first: available is already priority-ordered
  const acc = available[0];
  return { account: await accounts.touch(acc.id, { consecutive_use_count: (acc.consecutive_use_count || 0) + 1 }) };
}

/** Resolve the proxy URL for an account: explicit proxy_url > pool > global env. */
export async function resolveProxyForAccount(acc, proxyPools) {
  if (acc.proxy_url) return acc.proxy_url;
  if (acc.proxy_pool_id) {
    const p = await proxyPools.nextProxy(acc.proxy_pool_id);
    if (p) return p;
  }
  return process.env.ALL_PROXY || process.env.HTTPS_PROXY || null;
}
