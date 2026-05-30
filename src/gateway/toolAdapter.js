/**
 * Cursor native-tool <-> Claude Code tool adapter.
 *
 * Cursor does NOT surface arbitrary custom tools to the model; it offers its own
 * native palette (read_file, run_terminal_cmd, ...), gated by the supported_tools
 * enum-id list. So we:
 *   - request:  map the CC tools present -> native ClientSideToolV2 ids (supported_tools)
 *   - response: map a native tool CALL -> a CC tool_use block (name + remapped input)
 *
 * Mapping is best-effort. read/bash/ls/search/web are clean; edit/write are lossy
 * (Cursor's edit_file uses a "// ...existing code..." diff format, not old/new_string).
 */

// Claude Code tool name -> Cursor native tool
const CC_TO_NATIVE = {
  Read:      { id: 5,  native: "read_file" },
  Bash:      { id: 4,  native: "run_terminal_cmd" },
  LS:        { id: 6,  native: "list_dir" },
  Glob:      { id: 8,  native: "file_search" },
  Grep:      { id: 3,  native: "ripgrep_search" },
  Write:     { id: 10, native: "create_file" },
  Edit:      { id: 7,  native: "edit_file" },
  MultiEdit: { id: 7,  native: "edit_file" },
  WebSearch: { id: 18, native: "web_search" },
};

// Native tool name -> Claude Code tool name
const NATIVE_TO_CC = {
  read_file: "Read",
  run_terminal_cmd: "Bash",
  list_dir: "LS",
  file_search: "Glob",
  ripgrep_search: "Grep",
  create_file: "Write",
  edit_file: "Edit",
  web_search: "WebSearch",
};

// Cursor's model only behaves correctly when it sees a near-complete native tool
// palette; declaring a partial subset makes it claim "no tool available". So when
// the caller sends ANY tools (agent mode), we enable the full native set and map
// back whatever native tool the model actually calls.
const FULL_NATIVE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16, 17, 18, 19, 20];

/**
 * From the Claude Code tools[] in the request, compute the Cursor supported_tools
 * enum ids. Any recognized CC tool -> enable the full native palette. [] otherwise.
 */
export function supportedIdsFromClaudeTools(tools = []) {
  const hasKnown = (tools || []).some((t) => CC_TO_NATIVE[t?.name || t?.function?.name]);
  return hasKnown ? [...FULL_NATIVE_IDS] : [];
}

/**
 * Remap a native tool call's args to the Claude Code tool's input schema.
 */
function remapArgs(nativeName, args) {
  const a = args && typeof args === "object" ? args : {};
  switch (nativeName) {
    case "read_file": {
      const out = { file_path: a.target_file || a.path || a.file_path };
      if (Number.isInteger(a.start_line_one_indexed)) out.offset = a.start_line_one_indexed;
      if (Number.isInteger(a.start_line)) out.offset = a.start_line;
      if (Number.isInteger(a.end_line_one_indexed) && out.offset) out.limit = a.end_line_one_indexed - out.offset + 1;
      return out;
    }
    case "run_terminal_cmd":
      return { command: a.command, ...(a.is_background ? { run_in_background: true } : {}) };
    case "list_dir":
      return { path: a.relative_workspace_path || a.path || "." };
    case "file_search":
      return { pattern: a.query || a.pattern || "" };
    case "ripgrep_search":
      return { pattern: a.query || a.pattern || a.regex || "" };
    case "create_file":
      return { file_path: a.target_file || a.file_path, content: a.contents || a.content || a.code || "" };
    case "edit_file":
      // Lossy: Cursor's code_edit is a diff-marker blob, not old/new_string.
      // Pass it through under new_string so the caller at least sees the intent.
      return { file_path: a.target_file || a.file_path, _cursor_code_edit: a.code_edit, _cursor_instructions: a.instructions };
    case "web_search":
      return { query: a.search_term || a.query || "" };
    default:
      return a;
  }
}

/**
 * Convert a decoded Cursor tool call ({id, function:{name, arguments}}) into a
 * Claude Code tool_use block { id, name, input }. Falls back to the raw name if
 * the native tool is unknown.
 */
export function nativeCallToClaudeToolUse(tc) {
  const rawName = tc.function?.name || "";
  // strip any mcp_custom_ prefix just in case
  const cleaned = rawName.startsWith("mcp_custom_") ? rawName.slice("mcp_custom_".length) : rawName;
  const ccName = NATIVE_TO_CC[cleaned] || cleaned;

  let parsed = {};
  try { parsed = JSON.parse(tc.function?.arguments || "{}"); } catch {}
  // drop Cursor's chatty "explanation" field — not part of CC schemas
  if (parsed && typeof parsed === "object") delete parsed.explanation;

  const input = NATIVE_TO_CC[cleaned] ? remapArgs(cleaned, parsed) : parsed;
  return { id: tc.id, name: ccName, input };
}

/**
 * Resolve a Claude Code tool name -> { id, native } for native encoding.
 * Falls back to read_file if unknown (least harmful).
 */
export function ccToolToNative(ccName) {
  return CC_TO_NATIVE[ccName] || { id: 5, native: "read_file" };
}

export const _maps = { CC_TO_NATIVE, NATIVE_TO_CC };
