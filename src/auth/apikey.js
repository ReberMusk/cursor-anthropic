/**
 * Outbound API-key ("sk-...") management + verification for /v1/messages.
 *
 * Keys are shown in full exactly once at creation time; only a salted hash and a
 * short prefix are stored. Clients authenticate with `x-api-key: sk-...` (or
 * `Authorization: Bearer sk-...`).
 *
 * If no keys exist AND no GATEWAY_API_KEY env is set, the endpoint is open
 * (handy for local testing) — the admin UI warns about this.
 */
import crypto from "crypto";
import { apiKeys } from "../db/repos.js";

const PREFIX = "sk-ca-";

const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

/** Generate a new key, persist its hash, and return the plaintext ONCE. */
export async function generateKey(name) {
  const secret = crypto.randomBytes(24).toString("base64url");
  const key = PREFIX + secret;
  const rec = await apiKeys.create({ name, keyHash: hashKey(key), keyPrefix: key.slice(0, 12) });
  return { key, record: rec };
}

function extractKey(req) {
  const x = req.headers["x-api-key"];
  if (x) return Array.isArray(x) ? x[0] : x;
  const auth = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "");
  return null;
}

/**
 * Verify the inbound key. Returns { ok, keyId? }.
 * Order of precedence:
 *  1. env GATEWAY_API_KEY (single shared key, if set)
 *  2. DB api_keys table
 *  3. open (only when neither env key nor any DB key exists)
 */
export async function verifyApiKey(req) {
  const provided = extractKey(req);
  const envKey = process.env.GATEWAY_API_KEY || "";
  const dbKeys = await apiKeys.activeList();

  if (!envKey && dbKeys.length === 0) return { ok: true, keyId: null, open: true };

  if (envKey && provided === envKey) return { ok: true, keyId: null };

  if (provided) {
    const h = hashKey(provided);
    const match = dbKeys.find((k) => k.key_hash === h);
    if (match) {
      apiKeys.markUsed(match.id).catch(() => {});
      return { ok: true, keyId: match.id };
    }
  }
  return { ok: false };
}

/** Express middleware guarding the public /v1 endpoints. */
export async function requireApiKey(req, res, next) {
  try {
    const r = await verifyApiKey(req);
    if (!r.ok) {
      return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
    }
    req.apiKeyId = r.keyId || null;
    next();
  } catch (e) {
    next(e);
  }
}
