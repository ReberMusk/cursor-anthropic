/**
 * Decode a Cursor access token (a JWT) WITHOUT verifying its signature — we only
 * need to read the public claims (subject/user id, issuer, expiry) for display
 * and for setting an accurate `expires_at` on imported accounts.
 *
 * Cursor tokens look like:
 *   header.payload.signature   (base64url)
 * with payload claims: { sub: "auth0|user_...", time, randomness, exp, iss, ... }
 */

/**
 * Normalize a raw token string into just the JWT.
 * Cursor dumps often prefix the JWT with the user id and a URL-encoded "::"
 * separator, e.g. "user_01J...%3A%3AeyJhbGci..." (decodes to "user_...::eyJ...").
 * We URL-decode when needed and keep only the part after "::".
 */
export function extractAccessToken(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (/%[0-9a-fA-F]{2}/.test(s)) {
    try { s = decodeURIComponent(s); } catch { /* keep the raw value */ }
  }
  if (s.includes("::")) s = s.split("::").pop();
  return s.trim();
}

function b64urlToJson(part) {
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} token Cursor access token (optionally "wid::jwt").
 * @returns {{ userId:string|null, sub:string|null, email:string|null,
 *            iss:string|null, expSeconds:number|null, expiresAt:string|null,
 *            raw:object|null }}
 */
export function parseCursorToken(token) {
  const clean = extractAccessToken(token);
  const parts = clean.split(".");
  const empty = { userId: null, sub: null, email: null, iss: null, expSeconds: null, expiresAt: null, raw: null };
  if (parts.length < 2) return empty;

  const payload = b64urlToJson(parts[1]);
  if (!payload) return empty;

  const sub = payload.sub || null;
  // sub is like "auth0|user_01JV..." — keep the user_ part as a readable id
  let userId = sub;
  if (typeof sub === "string" && sub.includes("|")) userId = sub.split("|").pop();

  const expSeconds = Number.isFinite(payload.exp) ? payload.exp : null;
  const expiresAt = expSeconds ? new Date(expSeconds * 1000).toISOString() : null;

  return {
    userId,
    sub,
    email: payload.email || null,
    iss: payload.iss || null,
    expSeconds,
    expiresAt,
    raw: payload,
  };
}

/** True if the token's exp claim is in the past. */
export function isTokenExpired(token, skewSeconds = 0) {
  const { expSeconds } = parseCursorToken(token);
  if (!expSeconds) return false; // unknown — assume valid
  return expSeconds * 1000 <= Date.now() + skewSeconds * 1000;
}
