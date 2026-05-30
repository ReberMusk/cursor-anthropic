// Central place for Cursor protocol constants that drift across Cursor releases.
export const CURSOR = {
  HOST: "api2.cursor.sh",
  CHAT_PATH: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
  CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || "3.1.0",
  PROTOBUF_SCHEMA_VERSION: "1.1.3",
};

// Resolve the model name to send to Cursor. Override entirely with CURSOR_MODEL.
//
// Cursor model ids are `claude-<version>-<family>` (e.g. claude-4-sonnet,
// claude-4-opus). We fold any incoming model containing a known family word onto
// the canonical Cursor id — this is necessary because Anthropic-style ids
// (claude-3-5-sonnet-20241022) and made-up ids (claude-opus-4-8) are rejected by
// Cursor as "AI Model Not Found".
//
// "Max mode": on the wire it is NOT a name suffix — `encodeModel` strips a
// trailing `-max` and sets the dedicated ModelDetails.max_mode flag (field 8).
// We keep `-max` here so it survives down to encodeModel. Opus on Cursor REQUIRES
// Max mode (otherwise: "Max Mode Required"), so we force it for opus.
export function mapModel(anthropicModel) {
  if (process.env.CURSOR_MODEL) return process.env.CURSOR_MODEL;
  const raw = String(anthropicModel || "").trim();
  if (!raw) return "claude-4-sonnet";

  const explicitMax = /[-_\s]max$/i.test(raw);
  const c = raw.toLowerCase();

  // Canonical, currently-valid Cursor ids (verified live against the API).
  let base;
  let forceMax = false;
  if (c.includes("haiku")) base = "claude-4.5-haiku";
  else if (c.includes("opus")) { base = "claude-4.1-opus"; forceMax = true; } // opus requires Max
  else if (c.includes("sonnet")) base = "claude-4.5-sonnet";
  // Unknown family — pass through (drop a trailing -max; re-added below if asked).
  else base = raw.replace(/[-_\s]max$/i, "") || "claude-4.5-sonnet";

  return (explicitMax || forceMax) ? `${base}-max` : base;
}
