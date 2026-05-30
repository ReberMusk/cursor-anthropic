// Central place for Cursor protocol constants that drift across Cursor releases.
export const CURSOR = {
  HOST: "api2.cursor.sh",
  CHAT_PATH: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
  CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || "3.1.0",
  PROTOBUF_SCHEMA_VERSION: "1.1.3",
};

// Resolve the model name to send to Cursor. Override entirely with CURSOR_MODEL.
//
// IMPORTANT: do NOT clobber explicit Cursor model ids. A request for
// `claude-opus-4-8` must reach Cursor as `claude-opus-4-8` — mapping it to a
// family alias like `claude-4-opus` sends the wrong/older model and breaks it.
// So we PASS THROUGH the requested model unchanged, and only fold the classic
// GENERIC Anthropic aliases (a bare family word, or a dated / `-latest` id that
// Cursor doesn't recognize) onto Cursor's canonical family names.
//
// A trailing `-max` requests "Max mode". On the wire that is NOT a name suffix:
// `encodeModel` strips `-max` and sets the dedicated ModelDetails.max_mode
// boolean (field 8). We keep the `-max` here so it survives down to encodeModel.
export function mapModel(anthropicModel) {
  if (process.env.CURSOR_MODEL) return process.env.CURSOR_MODEL;
  const raw = String(anthropicModel || "").trim();
  if (!raw) return "claude-4-sonnet";

  const maxSuffix = /[-_\s]max$/i.test(raw) ? "-max" : "";
  const core = maxSuffix ? raw.replace(/[-_\s]max$/i, "") : raw;
  const c = core.toLowerCase();

  // Only remap "generic" Anthropic ids: a bare family word, or an id ending in a
  // date (-YYYYMMDD) or -latest. Specific Cursor ids (e.g. claude-opus-4-8) and
  // everything else pass through untouched.
  const generic = /-(\d{8}|latest)$/i.test(c) || /^(claude-)?(3[-.]5-)?(haiku|sonnet|opus)$/i.test(c);
  let mapped = core;
  if (generic) {
    if (c.includes("haiku")) mapped = "claude-3.5-haiku";
    else if (c.includes("opus")) mapped = "claude-4-opus";
    else if (c.includes("sonnet")) mapped = "claude-4-sonnet";
  }
  return mapped + maxSuffix;
}
