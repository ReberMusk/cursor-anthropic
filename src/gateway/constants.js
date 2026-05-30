// Central place for Cursor protocol constants that drift across Cursor releases.
export const CURSOR = {
  HOST: "api2.cursor.sh",
  CHAT_PATH: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
  CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || "3.1.0",
  PROTOBUF_SCHEMA_VERSION: "1.1.3",
};

// Map an incoming Anthropic model id to a model name your Cursor account supports.
// Override entirely with CURSOR_MODEL env, or extend this map.
//
// A trailing `-max` requests Cursor "Max mode". We PRESERVE that marker on the
// mapped name here; the protobuf layer (encodeModel) is what actually turns it
// into Cursor's real signal: it strips the suffix and sets the dedicated
// ModelDetails.max_mode boolean (field 8). Sending the `-max` name alone (no
// flag) makes Cursor reply "Max Mode Required". So `claude-4-sonnet-max` maps to
// the canonical Cursor model + `-max`, which becomes `claude-4-sonnet` + max_mode.
export function mapModel(anthropicModel) {
  if (process.env.CURSOR_MODEL) return process.env.CURSOR_MODEL;
  const raw = String(anthropicModel || "").trim();
  const m = raw.toLowerCase();
  const wantsMax = /[-_\s]max$/.test(m);

  let base;
  if (m.includes("haiku")) base = "claude-3.5-haiku";
  else if (m.includes("opus")) base = "claude-4-opus";
  else if (m.includes("sonnet")) base = "claude-4-sonnet";
  // Unknown — pass through (strip a trailing -max; we re-add it below).
  else base = raw.replace(/[-_\s]max$/i, "") || "claude-4-sonnet";

  return wantsMax ? `${base}-max` : base;
}
