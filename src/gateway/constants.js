// Central place for Cursor protocol constants that drift across Cursor releases.
export const CURSOR = {
  HOST: "api2.cursor.sh",
  CHAT_PATH: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
  CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || "3.1.0",
  PROTOBUF_SCHEMA_VERSION: "1.1.3",
};

// Map an incoming Anthropic model id to a model name your Cursor account supports.
// Override entirely with CURSOR_MODEL env, or extend this map.
export function mapModel(anthropicModel) {
  if (process.env.CURSOR_MODEL) return process.env.CURSOR_MODEL;
  const m = String(anthropicModel || "").toLowerCase();
  if (m.includes("haiku")) return "claude-3.5-haiku";
  if (m.includes("opus")) return "claude-4-opus";
  if (m.includes("sonnet")) return "claude-4-sonnet";
  // Unknown — pass through (let Cursor reject if unsupported).
  return anthropicModel || "claude-4-sonnet";
}
