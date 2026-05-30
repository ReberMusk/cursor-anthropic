// Verify the tool definition actually lands in the encoded protobuf (field 34 MCP_TOOLS).
import { generateCursorBody, decodeMessage, decodeField } from "../src/gateway/protobuf.js";

const tools = [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } }];
const body = generateCursorBody([{ role: "user", content: "weather in Paris?" }], "gpt-4o", tools, null, true);

// strip 5-byte ConnectRPC frame header
const payload = Buffer.from(body.slice(5));
// top-level field 1 (REQUEST) wraps the StreamUnifiedChatRequest
const [fnum, , value] = decodeField(payload, 0);
console.log("top-level field:", fnum, "(expect 1=REQUEST)");
const req = decodeMessage(value);

console.log("fields present:", [...req.keys()].sort((a, b) => a - b).join(", "));
console.log("has IS_AGENTIC(27):", req.has(27), req.has(27) ? "=" + req.get(27)[0].value : "");
console.log("has SUPPORTED_TOOLS(29):", req.has(29));
console.log("has MCP_TOOLS(34):", req.has(34), "count=" + (req.get(34)?.length || 0));
console.log("has UNIFIED_MODE(46):", req.has(46), req.has(46) ? "=" + req.get(46)[0].value : "");
console.log("has SHOULD_DISABLE_TOOLS(48):", req.has(48), req.has(48) ? "=" + req.get(48)[0].value : "");

if (req.has(34)) {
  const tool = decodeMessage(req.get(34)[0].value);
  const dec = (v) => new TextDecoder().decode(v);
  console.log("  tool name(1):", tool.has(1) ? dec(tool.get(1)[0].value) : "(none)");
  console.log("  tool params(3):", tool.has(3) ? dec(tool.get(3)[0].value) : "(none)");
  console.log("  tool server(4):", tool.has(4) ? dec(tool.get(4)[0].value) : "(none)");
}

// also check last message has MSG_SUPPORTED_TOOLS(51)
const msgs = req.get(1) || [];
const lastMsg = decodeMessage(msgs[msgs.length - 1].value);
console.log("last message fields:", [...lastMsg.keys()].sort((a, b) => a - b).join(", "));
console.log("  last msg has MSG_SUPPORTED_TOOLS(51):", lastMsg.has(51));
console.log("  last msg has MSG_IS_AGENTIC(29):", lastMsg.has(29), lastMsg.has(29) ? "=" + lastMsg.get(29)[0].value : "");
console.log("  last msg has MSG_UNIFIED_MODE(47):", lastMsg.has(47), lastMsg.has(47) ? "=" + lastMsg.get(47)[0].value : "");
