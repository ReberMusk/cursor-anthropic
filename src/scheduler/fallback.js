/**
 * Error classification + cooldown/backoff for the account pool.
 *
 * On a failed Cursor call we mark the account unavailable with an appropriate
 * cooldown so the scheduler skips it and fails over to the next account. On a
 * success we reset its backoff. Region errors ("not available in your region",
 * region-gated models) are treated as longer cooldowns, not transient.
 */
import { accounts, settings, SCHED_DEFAULTS, DEFAULT_ACCOUNT_ERROR_KEYWORDS } from "../db/repos.js";

async function cfg() {
  return { ...SCHED_DEFAULTS, ...((await settings.get("scheduler")) || {}) };
}

/** Normalize the configured account-error keyword list (array or newline text). */
export function accountErrorKeywords(gateway) {
  const raw = gateway?.accountErrorKeywords;
  let list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\r?\n/) : [];
  list = list.map((s) => String(s).trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ACCOUNT_ERROR_KEYWORDS;
}

/**
 * Decide whether a Cursor error is ACCOUNT-LEVEL (cool down + fail over) or just
 * a request/parameter error (return to the client, keep the account healthy).
 *
 * Hard protocol signals (401 auth, 429 rate-limit) are always account-level.
 * 403 is intentionally NOT hard-coded — Cursor returns 403 for request-level
 * issues too (e.g. "Max Mode Required", model not permitted), so we let the
 * keyword list decide. Real account-level 403s ("blocked"/"suspicious
 * activity") are covered by the default keywords. Anything unmatched is a
 * request error and must NOT disable the token.
 */
export function isAccountError(httpStatus, errorText, gateway) {
  if (httpStatus === 401 || httpStatus === 429) return true;
  const s = (typeof errorText === "string" ? errorText : JSON.stringify(errorText || "")).toLowerCase();
  if (!s) return false;
  return accountErrorKeywords(gateway).some((kw) => s.includes(kw.toLowerCase()));
}

const ERROR_RULES = [
  { test: (s) => s.includes("resource_exhausted"), kind: "backoff", status: "rate_limited" },
  { test: (s) => s.includes("rate limit") || s.includes("too many requests"), kind: "backoff", status: "rate_limited" },
  { test: (s) => s.includes("quota") || s.includes("usage limit") || s.includes("you've reached"), kind: "backoff", status: "rate_limited" },
  // region gating — model/region not available; cool the account for a while
  { test: (s) => s.includes("not available in your") || s.includes("region") || s.includes("unsupported_country"), cooldownMs: 10 * 60 * 1000, status: "error" },
  { test: (s) => s.includes("unauthorized") || s.includes("invalid token") || s.includes("expired"), cooldownMs: 5 * 60 * 1000, status: "expired" },
  { byStatus: 429, kind: "backoff", status: "rate_limited" },
  { byStatus: 401, cooldownMs: 5 * 60 * 1000, status: "expired" },
  { byStatus: 403, cooldownMs: 10 * 60 * 1000, status: "error" },
];

export async function classifyError(httpStatus, errorText, backoffLevel = 0) {
  const c = await cfg();
  const s = (typeof errorText === "string" ? errorText : JSON.stringify(errorText || "")).toLowerCase();

  const quotaCooldown = (level) =>
    Math.min(c.backoffBaseMs * 2 ** Math.max(0, level - 1), c.backoffMaxMs);

  for (const r of ERROR_RULES) {
    const hit = (r.test && r.test(s)) || (r.byStatus && r.byStatus === httpStatus);
    if (!hit) continue;
    if (r.kind === "backoff") {
      const lvl = Math.min(backoffLevel + 1, c.backoffMaxLevel);
      return { cooldownMs: quotaCooldown(lvl), newLevel: lvl, status: r.status };
    }
    return { cooldownMs: r.cooldownMs, newLevel: backoffLevel, status: r.status };
  }
  // unknown/transient
  return { cooldownMs: c.transientCooldownMs, newLevel: backoffLevel, status: "error" };
}

/** Mark an account unavailable, applying cooldown + backoff. Returns the decision. */
export async function markUnavailable(accountId, httpStatus, errorText) {
  const acc = await accounts.get(accountId);
  if (!acc) return null;
  const { cooldownMs, newLevel, status } = await classifyError(httpStatus, errorText, acc.backoff_level || 0);
  await accounts.update(accountId, {
    status,
    cooldown_until: new Date(Date.now() + cooldownMs).toISOString(),
    backoff_level: newLevel,
    last_error: String(errorText).slice(0, 300),
    error_code: httpStatus || null,
    last_error_at: new Date().toISOString(),
    total_errors: (acc.total_errors || 0) + 1,
  });
  return { cooldownMs, status, newLevel };
}

/** Reset an account to healthy after a successful call. */
export async function markSuccess(accountId) {
  await accounts.update(accountId, {
    status: "active",
    cooldown_until: null,
    backoff_level: 0,
    last_error: null,
    error_code: null,
  });
}
