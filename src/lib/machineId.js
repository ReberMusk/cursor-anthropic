/**
 * Cursor machine-identifier generator.
 *
 * Cursor (like VS Code) stores a set of telemetry identifiers in
 * globalStorage/storage.json. They are NOT derived from hardware — they are
 * plain random values in fixed formats, which is exactly why "machine id reset"
 * tools simply regenerate them:
 *
 *   telemetry.machineId      64-char lowercase hex   (sha256 length)
 *   telemetry.macMachineId   64-char lowercase hex
 *   telemetry.devDeviceId    UUID v4 (lowercase, hyphenated)
 *   telemetry.sqmId          "{UPPERCASE-UUID}"
 *   storage.serviceMachineId UUID v4
 *
 * For the gateway, the only value that matters on the wire is `machineId`
 * (appended to x-cursor-checksum), and Cursor accepts a 64-hex string there.
 *
 * So callers no longer need to supply a machineId when importing an account:
 * we generate a complete, well-formed identity set automatically.
 */
import crypto from "crypto";

const hex64 = () => crypto.randomBytes(32).toString("hex");

/** Lowercase, hyphenated UUID v4. */
export const uuidV4 = () => crypto.randomUUID();

/** Cursor's sqmId form: braces + uppercase UUID. */
export const sqmId = () => `{${crypto.randomUUID().toUpperCase()}}`;

/**
 * Generate a fresh, well-formed Cursor identity set.
 * When `seed` (the access token) is given, every id is derived deterministically
 * from it so the SAME account always presents the SAME device identity — even
 * across restarts, DB wipes, or re-imports. This is what prevents Cursor's
 * "Too many computers" error: one token ⇒ one stable device.
 * @returns {{machineId:string, macMachineId:string, devDeviceId:string, sqmId:string, serviceMachineId:string}}
 */
export function generateCursorIds(seed = null) {
  if (seed) {
    return {
      machineId: deriveMachineId(seed, "machineId"),
      macMachineId: deriveMachineId(seed, "macMachineId"),
      devDeviceId: deriveUuid(seed, "devDeviceId"),
      sqmId: `{${deriveUuid(seed, "sqmId").toUpperCase()}}`,
      serviceMachineId: deriveUuid(seed, "serviceMachineId"),
    };
  }
  return {
    machineId: hex64(),
    macMachineId: hex64(),
    devDeviceId: uuidV4(),
    sqmId: sqmId(),
    serviceMachineId: uuidV4(),
  };
}

/**
 * Deterministically derive a stable 64-hex machineId from a token (or any seed).
 * Useful when you want the same account to always present the same machine id
 * across restarts without persisting it. Matches the legacy checksum fallback.
 */
export function deriveMachineId(seed, salt = "machineId") {
  return crypto.createHash("sha256").update(String(seed) + salt).digest("hex");
}

/** Deterministically derive a stable UUID-v4-shaped string from a seed. */
export function deriveUuid(seed, salt = "") {
  const h = crypto.createHash("sha256").update(String(seed) + salt).digest("hex");
  // Shape the first 32 hex chars into a v4 UUID (version nibble = 4, variant = 8..b).
  const b = h.slice(0, 32).split("");
  b[12] = "4";
  b[16] = ((parseInt(b[16], 16) & 0x3) | 0x8).toString(16);
  const s = b.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Resolve the machineId to use for an account at import time.
 * - If the caller supplied one, keep it.
 * - Otherwise derive a STABLE one from the access token (default), or a random
 *   64-hex one when mode='random' is explicitly requested.
 */
export function resolveMachineId(provided, { token, mode = "derive" } = {}) {
  if (provided && String(provided).trim()) return String(provided).trim();
  if (mode === "random" || !token) return hex64();
  return deriveMachineId(token);
}

export const isHex64 = (s) => /^[a-f0-9]{64}$/i.test(String(s || ""));
export const looksLikeMachineId = (s) => isHex64(s) || /^[a-f0-9-]{32,}$/i.test(String(s || ""));
