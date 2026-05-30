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
// Cursor enables "Max mode" via a `-max` suffix on the model name (exactly like
// the editor). We must PRESERVE that suffix — otherwise models that require Max
// reply with "Max Mode Required". So a request for `claude-4-sonnet-max` maps to
// the canonical Cursor model + `-max`.
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
