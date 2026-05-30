/**
 * Account import service: validate a Cursor token, auto-generate a machine id if
 * one wasn't supplied, parse JWT claims (email/userId/expiry), and upsert.
 * Also parses the various bulk-import formats.
 */
import { accounts } from "../db/repos.js";
import { parseCursorToken } from "./jwt.js";
import { resolveMachineId, generateCursorIds, looksLikeMachineId } from "./machineId.js";

const cleanTok = (t) => (String(t || "").includes("::") ? String(t).split("::")[1] : String(t || "")).trim();

/** Validate + normalize a single account record for import. Throws on invalid. */
export function buildAccountRecord(input) {
  const token = cleanTok(input.accessToken || input.access_token || input.token);
  if (!token || token.length < 50) throw new Error("access token missing or too short");

  const claims = parseCursorToken(token);

  // Device identity is DERIVED from the token by default so it is stable across
  // restarts / re-imports / DB wipes (one token ⇒ one device ⇒ no "Too many
  // computers"). A caller may still pin an explicit machineId; mode='random'
  // opts into a one-off random identity.
  const provided = input.machineId || input.machine_id;
  const mode = (input.machineIdMode || "derive").toLowerCase();
  const ids = generateCursorIds(mode === "random" ? null : token);
  let machineId;
  if (provided && looksLikeMachineId(provided)) {
    machineId = String(provided).trim();
  } else {
    machineId = resolveMachineId(null, { token, mode });
  }

  const expiresAt = claims.expiresAt || new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  return {
    name: input.name || claims.email || claims.userId || null,
    email: claims.email || null,
    user_id: claims.userId || null,
    access_token: token,
    machine_id: machineId,
    mac_machine_id: input.macMachineId || ids.macMachineId,
    ghost_mode: input.ghostMode === false ? false : true,
    priority: Number.isInteger(input.priority) ? input.priority : undefined,
    expires_at: expiresAt,
    proxy_pool_id: input.proxyPoolId || null,
    proxy_url: input.proxyUrl || null,
  };
}

/**
 * Import or update a single account. Idempotent: dedupe by the Cursor user id
 * (JWT `sub`, stable for the lifetime of the account) first, then email, then
 * the raw token. On update we KEEP the existing device identity so re-importing
 * the same account never spawns a new "computer" on Cursor's side.
 */
export async function importAccount(input) {
  const rec = buildAccountRecord(input);
  const existing =
    (rec.user_id && (await accounts.getByUserId(rec.user_id))) ||
    (rec.email && (await accounts.getByEmail(rec.email))) ||
    (await accounts.getByToken(rec.access_token));
  if (existing) {
    const explicitMachine = input.machineId || input.machine_id;
    const updated = await accounts.update(existing.id, {
      access_token: rec.access_token,
      // Never rotate a known device id. Only set one if it's somehow missing,
      // or if the caller explicitly pinned a new machineId.
      ...(explicitMachine && looksLikeMachineId(explicitMachine)
        ? { machine_id: rec.machine_id, mac_machine_id: rec.mac_machine_id }
        : (existing.machine_id ? {} : { machine_id: rec.machine_id, mac_machine_id: rec.mac_machine_id })),
      email: rec.email,
      user_id: rec.user_id,
      expires_at: rec.expires_at,
      status: "active",
      cooldown_until: null,
      backoff_level: 0,
      ...(rec.name ? { name: rec.name } : {}),
      ...(rec.proxy_url ? { proxy_url: rec.proxy_url } : {}),
      ...(rec.proxy_pool_id ? { proxy_pool_id: rec.proxy_pool_id } : {}),
    });
    return { account: updated, created: false };
  }
  return { account: await accounts.create(rec), created: true };
}

/**
 * Parse bulk-import payloads. Accepts:
 *  - a JSON array of objects
 *  - newline text: `token----machineId`, `token,machineId`, or just `token`
 * Returns an array of raw input objects to feed importAccount.
 */
export function parseBulk(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.accounts)) return payload.accounts;

  const text = typeof payload === "string" ? payload : String(payload?.text || "");
  const trimmed = text.trim();
  if (!trimmed) return [];

  // try JSON first
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.accounts)) return parsed.accounts;
    } catch { /* fall through to line parsing */ }
  }

  const out = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    let token = l, machineId = null;
    if (l.includes("----")) [token, machineId] = l.split("----");
    else if (l.includes(",")) [token, machineId] = l.split(",");
    else if (/\s+/.test(l) && l.split(/\s+/).length === 2) [token, machineId] = l.split(/\s+/);
    out.push({ accessToken: token.trim(), machineId: machineId ? machineId.trim() : undefined });
  }
  return out;
}

/** Run a bulk import, returning a summary. */
export async function bulkImport(payload) {
  const items = parseBulk(payload);
  const result = { total: items.length, imported: 0, updated: 0, skipped: 0, errors: [] };
  for (let i = 0; i < items.length; i++) {
    try {
      const { created } = await importAccount(items[i]);
      if (created) result.imported++; else result.updated++;
    } catch (e) {
      result.skipped++;
      result.errors.push({ line: i + 1, reason: e.message });
    }
  }
  return result;
}

/** Strip secrets from an account row for API responses. */
export function publicAccount(a) {
  if (!a) return a;
  const token = a.access_token || "";
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    user_id: a.user_id,
    token_preview: token ? `${token.slice(0, 12)}…${token.slice(-6)}` : null,
    machine_id: a.machine_id,
    mac_machine_id: a.mac_machine_id,
    ghost_mode: !!a.ghost_mode,
    priority: a.priority,
    is_active: !!a.is_active,
    status: a.status,
    last_used_at: a.last_used_at,
    cooldown_until: a.cooldown_until,
    backoff_level: a.backoff_level,
    last_error: a.last_error,
    error_code: a.error_code,
    last_error_at: a.last_error_at,
    expires_at: a.expires_at,
    proxy_pool_id: a.proxy_pool_id,
    proxy_url: a.proxy_url,
    total_requests: a.total_requests,
    total_errors: a.total_errors,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}
