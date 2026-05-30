/**
 * Cursor Protobuf Encoder/Decoder (ConnectRPC wire format).
 * Ported from 9router open-sse/utils/cursorProtobuf.js (uuid dep removed).
 */
import { uuidv4 } from "./uuid.js";
import zlib from "zlib";

const DEBUG = process.env.CURSOR_PROTOBUF_DEBUG === "1";
const log = (tag, ...args) => DEBUG && console.log(`[PROTOBUF:${tag}]`, ...args);

const WIRE_TYPE = { VARINT: 0, FIXED64: 1, LEN: 2, FIXED32: 5 };
const ROLE = { USER: 1, ASSISTANT: 2 };
const UNIFIED_MODE = { CHAT: 1, AGENT: 2 };
const THINKING_LEVEL = { UNSPECIFIED: 0, MEDIUM: 1, HIGH: 2 };
const CLIENT_SIDE_TOOL_V2_MCP = 19;

const FIELD = {
  REQUEST: 1,
  MESSAGES: 1, UNKNOWN_2: 2, INSTRUCTION: 3, UNKNOWN_4: 4, MODEL: 5, WEB_TOOL: 8,
  UNKNOWN_13: 13, CURSOR_SETTING: 15, UNKNOWN_19: 19, CONVERSATION_ID: 23, METADATA: 26,
  IS_AGENTIC: 27, SUPPORTED_TOOLS: 29, MESSAGE_IDS: 30, MCP_TOOLS: 34, LARGE_CONTEXT: 35,
  UNKNOWN_38: 38, UNIFIED_MODE: 46, UNKNOWN_47: 47, SHOULD_DISABLE_TOOLS: 48,
  THINKING_LEVEL: 49, UNKNOWN_51: 51, UNKNOWN_53: 53, UNIFIED_MODE_NAME: 54,

  MSG_CONTENT: 1, MSG_ROLE: 2, MSG_ID: 13, MSG_TOOL_RESULTS: 18, MSG_IS_AGENTIC: 29,
  MSG_SERVER_BUBBLE_ID: 32, MSG_UNIFIED_MODE: 47, MSG_SUPPORTED_TOOLS: 51,

  TOOL_RESULT_CALL_ID: 1, TOOL_RESULT_NAME: 2, TOOL_RESULT_INDEX: 3, TOOL_RESULT_RAW_ARGS: 5,
  TOOL_RESULT_RESULT: 8, TOOL_RESULT_TOOL_CALL: 11, TOOL_RESULT_MODEL_CALL_ID: 12,

  CV2R_TOOL: 1, CV2R_MCP_RESULT: 28, CV2R_CALL_ID: 35, CV2R_MODEL_CALL_ID: 48, CV2R_TOOL_INDEX: 49,
  MCPR_SELECTED_TOOL: 1, MCPR_RESULT: 2,
  CV2C_TOOL: 1, CV2C_MCP_PARAMS: 27, CV2C_CALL_ID: 3, CV2C_NAME: 9, CV2C_RAW_ARGS: 10,
  CV2C_TOOL_INDEX: 48, CV2C_MODEL_CALL_ID: 49,

  MODEL_NAME: 1, MODEL_AZURE_STATE: 4, MODEL_ENABLE_SLOW_POOL: 5, MODEL_MAX_MODE: 8,
  INSTRUCTION_TEXT: 1,
  SETTING_PATH: 1, SETTING_UNKNOWN_3: 3, SETTING_UNKNOWN_6: 6, SETTING_UNKNOWN_8: 8, SETTING_UNKNOWN_9: 9,
  SETTING6_FIELD_1: 1, SETTING6_FIELD_2: 2,
  META_PLATFORM: 1, META_ARCH: 2, META_VERSION: 3, META_CWD: 4, META_TIMESTAMP: 5,
  MSGID_ID: 1, MSGID_SUMMARY: 2, MSGID_ROLE: 3,
  MCP_TOOL_NAME: 1, MCP_TOOL_DESC: 2, MCP_TOOL_PARAMS: 3, MCP_TOOL_SERVER: 4,

  // response
  TOOL_CALL: 1, RESPONSE: 2,
  TOOL_ID: 3, TOOL_NAME: 9, TOOL_RAW_ARGS: 10, TOOL_IS_LAST: 11, TOOL_MCP_PARAMS: 27,
  MCP_TOOLS_LIST: 1, MCP_NESTED_NAME: 1, MCP_NESTED_PARAMS: 3,
  RESPONSE_TEXT: 1, THINKING: 25, THINKING_TEXT: 1,
};

// ===================== ENCODING =====================

export function encodeVarint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

function concatArrays(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function encodeField(fieldNum, wireType, value) {
  const tag = (fieldNum << 3) | wireType;
  const tagBytes = encodeVarint(tag);

  if (wireType === WIRE_TYPE.VARINT) {
    return concatArrays(tagBytes, encodeVarint(value));
  }
  if (wireType === WIRE_TYPE.LEN) {
    const data =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
        ? value
        : Buffer.isBuffer(value)
        ? new Uint8Array(value)
        : new Uint8Array(0);
    return concatArrays(tagBytes, encodeVarint(data.length), data);
  }
  return new Uint8Array(0);
}

function formatToolName(name) {
  const base = typeof name === "string" && name.length > 0 ? name : "tool";
  if (base.startsWith("mcp__")) {
    const rest = base.slice(5);
    const i = rest.indexOf("__");
    if (i >= 0) return `mcp_${rest.slice(0, i) || "custom"}_${rest.slice(i + 2) || "tool"}`;
    return `mcp_custom_${rest || "tool"}`;
  }
  if (base.startsWith("mcp_")) return base;
  return `mcp_custom_${base}`;
}

// Pack a list of ClientSideToolV2 enum ids as a length-delimited packed varint field.
function packVarints(ids) {
  return concatArrays(...ids.map((id) => encodeVarint(id)));
}

// Which tool enum ids the client declares it can execute. The model ONLY emits
// calls for tools in this list. Override via CURSOR_SUPPORTED_TOOLS=comma,list.
// 19 = MCP (custom tools); 1..11 = native (read_file, run_terminal_command, ...).
export function supportedToolIds(override) {
  if (Array.isArray(override) && override.length) return override;
  const env = process.env.CURSOR_SUPPORTED_TOOLS;
  if (env) return env.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
  return [1];
}

// ---- Native ClientSideToolV2 tool-result encoding ----
// ClientSideToolV2Result field numbers (per reverse-engineered aiserver.proto):
const CV2R_FIELD = {
  TOOL: 1,
  RUN_TERMINAL: 5,
  READ_FILE: 6,
  ERROR: 8,
  LIST_DIR: 9,
  EDIT_FILE: 10,
  FILE_SEARCH: 11,
};

function encodeReadFileResult(text, path) {
  return concatArrays(
    encodeField(1, WIRE_TYPE.LEN, text || ""),            // contents
    ...(path ? [encodeField(9, WIRE_TYPE.LEN, path)] : []) // relative_workspace_path
  );
}
function encodeRunTerminalResult(text) {
  return concatArrays(
    encodeField(1, WIRE_TYPE.LEN, text || ""), // output
    encodeField(2, WIRE_TYPE.VARINT, 0)        // exit_code
  );
}

function encodeClientSideToolV2Result(enumId, nativeName, text, path) {
  const parts = [encodeField(CV2R_FIELD.TOOL, WIRE_TYPE.VARINT, enumId)];
  if (nativeName === "read_file") parts.push(encodeField(CV2R_FIELD.READ_FILE, WIRE_TYPE.LEN, encodeReadFileResult(text, path)));
  else if (nativeName === "run_terminal_cmd") parts.push(encodeField(CV2R_FIELD.RUN_TERMINAL, WIRE_TYPE.LEN, encodeRunTerminalResult(text)));
  // other tools: rely on ToolResult.content (field 7) below
  return concatArrays(...parts);
}

/**
 * Encode a completed native tool call+result as ConversationMessage.ToolResult.
 * @param {{toolCallId, nativeName, enumId, resultText, path, toolIndex}} tr
 */
export function encodeNativeToolResult(tr) {
  const idx = tr.toolIndex && tr.toolIndex > 0 ? tr.toolIndex : 1;
  return concatArrays(
    encodeField(FIELD.TOOL_RESULT_CALL_ID, WIRE_TYPE.LEN, tr.toolCallId || ""),  // 1 tool_call_id
    encodeField(FIELD.TOOL_RESULT_NAME, WIRE_TYPE.LEN, tr.nativeName || "tool"), // 2 tool_name
    encodeField(FIELD.TOOL_RESULT_INDEX, WIRE_TYPE.VARINT, idx),                  // 3 tool_index
    encodeField(7, WIRE_TYPE.LEN, tr.resultText || ""),                           // 7 content (generic)
    encodeField(FIELD.TOOL_RESULT_RESULT, WIRE_TYPE.LEN,                          // 8 result
      encodeClientSideToolV2Result(tr.enumId, tr.nativeName, tr.resultText, tr.path))
  );
}

export function encodeMessage(content, role, messageId, isLast = false, isAgentic = false, supportedIds = null, toolResults = []) {
  const ids = supportedToolIds(supportedIds);
  const hasResults = Array.isArray(toolResults) && toolResults.length > 0;
  return concatArrays(
    encodeField(FIELD.MSG_CONTENT, WIRE_TYPE.LEN, content || ""),
    encodeField(FIELD.MSG_ROLE, WIRE_TYPE.VARINT, role),
    encodeField(FIELD.MSG_ID, WIRE_TYPE.LEN, messageId),
    ...(hasResults ? toolResults.map((tr) => encodeField(FIELD.MSG_TOOL_RESULTS, WIRE_TYPE.LEN, encodeNativeToolResult(tr))) : []),
    encodeField(FIELD.MSG_IS_AGENTIC, WIRE_TYPE.VARINT, isAgentic ? 1 : 0),
    encodeField(FIELD.MSG_UNIFIED_MODE, WIRE_TYPE.VARINT, isAgentic ? UNIFIED_MODE.AGENT : UNIFIED_MODE.CHAT),
    // tools the client supports this turn — required on the last message or the model stays in ask mode
    ...(isLast && isAgentic ? [encodeField(FIELD.MSG_SUPPORTED_TOOLS, WIRE_TYPE.LEN, packVarints(ids))] : [])
  );
}

export function encodeInstruction(text) {
  return text ? encodeField(FIELD.INSTRUCTION_TEXT, WIRE_TYPE.LEN, text) : new Uint8Array(0);
}

// Encode the ModelDetails message (request field 5). Cursor enables Max Mode
// NOT via a name suffix but via the dedicated `max_mode` boolean (field 8); the
// model_name itself must be the BASE id WITHOUT the `-max` suffix — exactly what
// the editor sends. Sending `claude-4-opus-max` with no flag → "Max Mode Required".
export function encodeModel(modelName) {
  const wantsMax = /[-_\s]max$/i.test(modelName);
  const baseName = wantsMax ? modelName.replace(/[-_\s]max$/i, "") : modelName;
  return concatArrays(
    encodeField(FIELD.MODEL_NAME, WIRE_TYPE.LEN, baseName),
    encodeField(FIELD.MODEL_AZURE_STATE, WIRE_TYPE.LEN, new Uint8Array(0)), // empty AzureState message
    ...(wantsMax ? [encodeField(FIELD.MODEL_MAX_MODE, WIRE_TYPE.VARINT, 1)] : [])
  );
}

export function encodeCursorSetting() {
  const unknown6 = concatArrays(
    encodeField(FIELD.SETTING6_FIELD_1, WIRE_TYPE.LEN, new Uint8Array(0)),
    encodeField(FIELD.SETTING6_FIELD_2, WIRE_TYPE.LEN, new Uint8Array(0))
  );
  return concatArrays(
    encodeField(FIELD.SETTING_PATH, WIRE_TYPE.LEN, "cursor\\aisettings"),
    encodeField(FIELD.SETTING_UNKNOWN_3, WIRE_TYPE.LEN, new Uint8Array(0)),
    encodeField(FIELD.SETTING_UNKNOWN_6, WIRE_TYPE.LEN, unknown6),
    encodeField(FIELD.SETTING_UNKNOWN_8, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.SETTING_UNKNOWN_9, WIRE_TYPE.VARINT, 1)
  );
}

export function encodeMetadata() {
  return concatArrays(
    encodeField(FIELD.META_PLATFORM, WIRE_TYPE.LEN, process.platform || "linux"),
    encodeField(FIELD.META_ARCH, WIRE_TYPE.LEN, process.arch || "x64"),
    encodeField(FIELD.META_VERSION, WIRE_TYPE.LEN, process.version || "v20.0.0"),
    encodeField(FIELD.META_CWD, WIRE_TYPE.LEN, process.cwd?.() || "/"),
    encodeField(FIELD.META_TIMESTAMP, WIRE_TYPE.LEN, new Date().toISOString())
  );
}

export function encodeMessageId(messageId, role) {
  return concatArrays(
    encodeField(FIELD.MSGID_ID, WIRE_TYPE.LEN, messageId),
    encodeField(FIELD.MSGID_ROLE, WIRE_TYPE.VARINT, role)
  );
}

export function encodeMcpTool(tool) {
  const toolName = tool.function?.name || tool.name || "";
  const toolDesc = tool.function?.description || tool.description || "";
  const inputSchema = tool.function?.parameters || tool.input_schema || {};
  return concatArrays(
    ...(toolName ? [encodeField(FIELD.MCP_TOOL_NAME, WIRE_TYPE.LEN, toolName)] : []),
    ...(toolDesc ? [encodeField(FIELD.MCP_TOOL_DESC, WIRE_TYPE.LEN, toolDesc)] : []),
    ...(Object.keys(inputSchema).length > 0
      ? [encodeField(FIELD.MCP_TOOL_PARAMS, WIRE_TYPE.LEN, JSON.stringify(inputSchema))]
      : []),
    encodeField(FIELD.MCP_TOOL_SERVER, WIRE_TYPE.LEN, "custom")
  );
}

export function encodeRequest(messages, modelName, tools = [], reasoningEffort = null, forceAgentMode = false, supportedIds = null) {
  const hasTools = tools?.length > 0;
  const isAgentic = hasTools || forceAgentMode || (Array.isArray(supportedIds) && supportedIds.length > 0);

  const formatted = [];
  const messageIds = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role === "user" ? ROLE.USER : ROLE.ASSISTANT;
    const msgId = uuidv4();
    const isLast = i === messages.length - 1;
    formatted.push({ content: msg.content, role, messageId: msgId, isLast, toolResults: msg.toolResults || [] });
    messageIds.push({ messageId: msgId, role });
  }

  let thinkingLevel = THINKING_LEVEL.UNSPECIFIED;
  if (reasoningEffort === "medium") thinkingLevel = THINKING_LEVEL.MEDIUM;
  else if (reasoningEffort === "high") thinkingLevel = THINKING_LEVEL.HIGH;

  return concatArrays(
    ...formatted.map((fm) =>
      encodeField(FIELD.MESSAGES, WIRE_TYPE.LEN, encodeMessage(fm.content, fm.role, fm.messageId, fm.isLast, isAgentic, supportedIds, fm.toolResults))
    ),
    encodeField(FIELD.UNKNOWN_2, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.INSTRUCTION, WIRE_TYPE.LEN, encodeInstruction("")),
    encodeField(FIELD.UNKNOWN_4, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.MODEL, WIRE_TYPE.LEN, encodeModel(modelName)),
    encodeField(FIELD.WEB_TOOL, WIRE_TYPE.LEN, ""),
    encodeField(FIELD.UNKNOWN_13, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.CURSOR_SETTING, WIRE_TYPE.LEN, encodeCursorSetting()),
    encodeField(FIELD.UNKNOWN_19, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.CONVERSATION_ID, WIRE_TYPE.LEN, uuidv4()),
    encodeField(FIELD.METADATA, WIRE_TYPE.LEN, encodeMetadata()),
    encodeField(FIELD.IS_AGENTIC, WIRE_TYPE.VARINT, isAgentic ? 1 : 0),
    ...(isAgentic ? [encodeField(FIELD.SUPPORTED_TOOLS, WIRE_TYPE.LEN, packVarints(supportedToolIds(supportedIds)))] : []),
    ...messageIds.map((mid) =>
      encodeField(FIELD.MESSAGE_IDS, WIRE_TYPE.LEN, encodeMessageId(mid.messageId, mid.role))
    ),
    ...(hasTools ? tools.map((t) => encodeField(FIELD.MCP_TOOLS, WIRE_TYPE.LEN, encodeMcpTool(t))) : []),
    encodeField(FIELD.LARGE_CONTEXT, WIRE_TYPE.VARINT, 0),
    encodeField(FIELD.UNKNOWN_38, WIRE_TYPE.VARINT, 0),
    encodeField(FIELD.UNIFIED_MODE, WIRE_TYPE.VARINT, isAgentic ? UNIFIED_MODE.AGENT : UNIFIED_MODE.CHAT),
    encodeField(FIELD.UNKNOWN_47, WIRE_TYPE.LEN, ""),
    encodeField(FIELD.SHOULD_DISABLE_TOOLS, WIRE_TYPE.VARINT, isAgentic ? 0 : 1),
    encodeField(FIELD.THINKING_LEVEL, WIRE_TYPE.VARINT, thinkingLevel),
    encodeField(FIELD.UNKNOWN_51, WIRE_TYPE.VARINT, 0),
    encodeField(FIELD.UNKNOWN_53, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.UNIFIED_MODE_NAME, WIRE_TYPE.LEN, isAgentic ? "Agent" : "Ask")
  );
}

export function buildChatRequest(messages, modelName, tools, reasoningEffort, forceAgentMode, supportedIds) {
  return encodeField(FIELD.REQUEST, WIRE_TYPE.LEN, encodeRequest(messages, modelName, tools, reasoningEffort, forceAgentMode, supportedIds));
}

export function wrapConnectRPCFrame(payload, compress = false) {
  let finalPayload = payload;
  let flags = 0x00;
  if (compress) {
    finalPayload = new Uint8Array(zlib.gzipSync(Buffer.from(payload)));
    flags = 0x01;
  }
  const frame = new Uint8Array(5 + finalPayload.length);
  frame[0] = flags;
  frame[1] = (finalPayload.length >> 24) & 0xff;
  frame[2] = (finalPayload.length >> 16) & 0xff;
  frame[3] = (finalPayload.length >> 8) & 0xff;
  frame[4] = finalPayload.length & 0xff;
  frame.set(finalPayload, 5);
  return frame;
}

export function generateCursorBody(messages, modelName, tools = [], reasoningEffort = null, forceAgentMode = false, supportedIds = null) {
  const protobuf = buildChatRequest(messages, modelName, tools, reasoningEffort, forceAgentMode, supportedIds);
  return wrapConnectRPCFrame(protobuf, false); // Cursor doesn't accept compressed requests
}

// ===================== DECODING =====================

export function decodeVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buffer.length) {
    const b = buffer[pos];
    result |= (b & 0x7f) << shift;
    pos++;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, pos];
}

export function decodeField(buffer, offset) {
  if (offset >= buffer.length) return [null, null, null, offset];
  const [tag, pos1] = decodeVarint(buffer, offset);
  const fieldNum = tag >> 3;
  const wireType = tag & 0x07;
  let value;
  let pos = pos1;
  if (wireType === WIRE_TYPE.VARINT) {
    [value, pos] = decodeVarint(buffer, pos);
  } else if (wireType === WIRE_TYPE.LEN) {
    const [length, pos2] = decodeVarint(buffer, pos);
    value = buffer.slice(pos2, pos2 + length);
    pos = pos2 + length;
  } else if (wireType === WIRE_TYPE.FIXED64) {
    value = buffer.slice(pos, pos + 8);
    pos += 8;
  } else if (wireType === WIRE_TYPE.FIXED32) {
    value = buffer.slice(pos, pos + 4);
    pos += 4;
  } else {
    value = null;
  }
  return [fieldNum, wireType, value, pos];
}

export function decodeMessage(data) {
  const fields = new Map();
  let pos = 0;
  while (pos < data.length) {
    const [fieldNum, wireType, value, newPos] = decodeField(data, pos);
    if (fieldNum === null) break;
    if (!fields.has(fieldNum)) fields.set(fieldNum, []);
    fields.get(fieldNum).push({ wireType, value });
    pos = newPos;
  }
  return fields;
}

const dec = (v) => new TextDecoder().decode(v);

function extractToolCall(toolCallData) {
  const toolCall = decodeMessage(toolCallData);
  let toolCallId = "";
  let toolName = "";
  let rawArgs = "";
  let isLast = false;

  if (toolCall.has(FIELD.TOOL_ID)) toolCallId = dec(toolCall.get(FIELD.TOOL_ID)[0].value).split("\n")[0];
  if (toolCall.has(FIELD.TOOL_NAME)) toolName = dec(toolCall.get(FIELD.TOOL_NAME)[0].value);
  if (toolCall.has(FIELD.TOOL_IS_LAST)) isLast = toolCall.get(FIELD.TOOL_IS_LAST)[0].value !== 0;

  if (toolCall.has(FIELD.TOOL_MCP_PARAMS)) {
    try {
      const mcpParams = decodeMessage(toolCall.get(FIELD.TOOL_MCP_PARAMS)[0].value);
      if (mcpParams.has(FIELD.MCP_TOOLS_LIST)) {
        const tool = decodeMessage(mcpParams.get(FIELD.MCP_TOOLS_LIST)[0].value);
        if (tool.has(FIELD.MCP_NESTED_NAME)) toolName = dec(tool.get(FIELD.MCP_NESTED_NAME)[0].value);
        if (tool.has(FIELD.MCP_NESTED_PARAMS)) rawArgs = dec(tool.get(FIELD.MCP_NESTED_PARAMS)[0].value);
      }
    } catch {}
  }
  if (!rawArgs && toolCall.has(FIELD.TOOL_RAW_ARGS)) rawArgs = dec(toolCall.get(FIELD.TOOL_RAW_ARGS)[0].value);

  if (toolCallId && toolName) {
    return { id: toolCallId, type: "function", function: { name: toolName, arguments: rawArgs || "{}" }, isLast };
  }
  return null;
}

function extractTextAndThinking(responseData) {
  const nested = decodeMessage(responseData);
  let text = null;
  let thinking = null;
  if (nested.has(FIELD.RESPONSE_TEXT)) text = dec(nested.get(FIELD.RESPONSE_TEXT)[0].value);
  if (nested.has(FIELD.THINKING)) {
    try {
      const t = decodeMessage(nested.get(FIELD.THINKING)[0].value);
      if (t.has(FIELD.THINKING_TEXT)) thinking = dec(t.get(FIELD.THINKING_TEXT)[0].value);
    } catch {}
  }
  return { text, thinking };
}

export function extractTextFromResponse(payload) {
  try {
    const fields = decodeMessage(payload);
    if (fields.has(FIELD.TOOL_CALL)) {
      const toolCall = extractToolCall(fields.get(FIELD.TOOL_CALL)[0].value);
      if (toolCall) return { text: null, error: null, toolCall, thinking: null };
    }
    if (fields.has(FIELD.RESPONSE)) {
      const { text, thinking } = extractTextAndThinking(fields.get(FIELD.RESPONSE)[0].value);
      if (text || thinking) return { text, error: null, toolCall: null, thinking };
    }
    return { text: null, error: null, toolCall: null, thinking: null };
  } catch (err) {
    log("EXTRACT", `decode failed: ${err.message}`);
    return { text: null, error: null, toolCall: null, thinking: null };
  }
}
