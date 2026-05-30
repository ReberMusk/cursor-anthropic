/**
 * Offline smoke test — no network. Verifies the encode/decode/translate paths
 * end to end by hand-building a Cursor response frame and decoding it.
 *
 *   node test/smoke.js
 */
import assert from "assert";
import {
  encodeField, wrapConnectRPCFrame, generateCursorBody,
} from "../src/gateway/protobuf.js";
import { decodeCursorBuffer } from "../src/gateway/executor.js";
import { claudeToCursor, buildAnthropicSSE, buildAnthropicMessage } from "../src/gateway/translate.js";
import { generateCursorChecksum, buildCursorHeaders } from "../src/gateway/checksum.js";

const LEN = 2, VARINT = 0;
let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

// 1) checksum + headers don't throw and look sane
{
  const cs = generateCursorChecksum("machine-123");
  assert(typeof cs === "string" && cs.endsWith("machine-123"));
  const h = buildCursorHeaders("tok_abcdefághijklmnop", "machine-123");
  assert(h["x-cursor-checksum"] && h.authorization.startsWith("Bearer "));
  assert(h["x-session-id"].length === 36, "session id should be a uuid");
  ok("checksum + headers");
}

// 2) request encoding produces a valid ConnectRPC frame
{
  const body = generateCursorBody([{ role: "user", content: "Hi" }], "claude-4-sonnet", [], null, false);
  assert(body[0] === 0x00, "no-compress flag");
  const len = (body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4];
  assert(len === body.length - 5, "frame length matches payload");
  ok("request protobuf frame");
}

// 3) decode a hand-built TEXT response frame -> "hello world"
{
  // StreamUnifiedChatResponse: field2(RESPONSE) -> field1(RESPONSE_TEXT)
  const inner = encodeField(1, LEN, "hello world");
  const payload = encodeField(2, LEN, inner);
  const frame = wrapConnectRPCFrame(payload, false);
  const decoded = decodeCursorBuffer(Buffer.from(frame));
  assert.strictEqual(decoded.text, "hello world");
  assert.strictEqual(decoded.toolCalls.length, 0);
  ok("decode text frame");
}

// 4) decode a TOOL_CALL frame
{
  // field1(TOOL_CALL) -> ClientSideToolV2Call { id=3, name=9, raw_args=10, is_last=11 }
  const call = Buffer.concat([
    encodeField(3, LEN, "toolu_abc"),
    encodeField(9, LEN, "mcp_custom_Read"),
    encodeField(10, LEN, '{"path":"/tmp/x"}'),
    encodeField(11, VARINT, 1),
  ].map((u) => Buffer.from(u)));
  const payload = encodeField(1, LEN, call);
  const frame = wrapConnectRPCFrame(payload, false);
  const decoded = decodeCursorBuffer(Buffer.from(frame));
  assert.strictEqual(decoded.toolCalls.length, 1);
  assert.strictEqual(decoded.toolCalls[0].function.name, "mcp_custom_Read");
  ok("decode tool_call frame");
}

// 5) claudeToCursor: system + text + tool_result text-block downgrade
{
  const { messages, supportedIds } = claudeToCursor({
    system: "You are helpful",
    tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "read the file" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] },
    ],
  });
  assert(messages[0].content.startsWith("[System Instructions]"));
  // tool_use + tool_result become a NATIVE ToolResult attached to the assistant message
  const withResults = messages.find((m) => Array.isArray(m.toolResults) && m.toolResults.length);
  assert(withResults, "expected an assistant message carrying native toolResults");
  assert(withResults.toolResults[0].nativeName === "read_file", "Read -> read_file");
  assert(withResults.toolResults[0].resultText === "file contents", "result text attached");
  assert(supportedIds.includes(5), "Read should map to native id 5"); // read_file
  ok("claudeToCursor translation + native tool_result");
}

// 6) response builders: SSE + non-stream object
{
  const decoded = { status: 200, error: null, text: "Hi there", thinking: "", toolCalls: [] };
  const sse = buildAnthropicSSE(decoded, "claude-sonnet-4", "hello");
  assert(sse.includes("event: message_start"));
  assert(sse.includes('"text_delta"') && sse.includes("Hi there"));
  assert(sse.includes('"stop_reason":"end_turn"'));
  assert(sse.trim().endsWith("}")); // ends with message_stop data

  const msg = buildAnthropicMessage(decoded, "claude-sonnet-4", "hello");
  assert.strictEqual(msg.content[0].text, "Hi there");
  assert.strictEqual(msg.stop_reason, "end_turn");
  ok("Anthropic SSE + message builders");
}

console.log(`\n${passed}/6 smoke checks passed ✅`);
