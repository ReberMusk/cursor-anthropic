# cursor-anthropic 技术设计文档

> 一个独立的「Cursor → Anthropic API」转换网关。每个 Cursor 账号（workersToken + machineId）都能被单独管理，输入 token 即可对外提供 **原生 Anthropic（`/v1/messages`）格式** 的 API。内置多账号池的优先级轮询调度、自动错误/限速捕捉、SOCKS 动态代理池、批量导入，以及 HeroUI + TailwindCSS 管理端。
>
> 本文档参考 9router 项目的 Cursor 处理逻辑（ConnectRPC protobuf 编解码、Jyh checksum 鉴权、账号 fallback 调度）重新设计，但聚焦单一目标：**只做 Cursor，只做 Anthropic 格式**，不引入其他 provider 的复杂度。
>
> ### ⚠️ 与 9router 的根本性架构差异：直连翻译，不走 OpenAI 中间层
>
> 9router 是多 provider 路由器，采用 **OpenAI 作为枢纽格式**（hub-and-spoke），所有 provider 走 `cursor→openai→claude` 两段式翻译——这是为了把 N×M 个翻译器降到 N+M 个的**工程妥协**，对它合理，但不是技术亮点。
>
> 本项目只有 1 种输入（Anthropic）+ 1 个 provider（Cursor），枢纽收益为 0，反而付出双跳转换的**保真度代价**：
> - **thinking**：Cursor protobuf 有专用 thinking 字段（field 25），与 Anthropic 原生 `thinking` 块 1:1 对应；OpenAI chat 格式没有干净的 thinking 表示，过一道就丢失块结构/签名。
> - **tool_use**：Anthropic `input` 是结构化 JSON，OpenAI `arguments` 是字符串；双跳 = 先 stringify 再 parse，流式分片 JSON 还要重拼。
> - **content blocks**：Anthropic 多块/index/cache_control 在 OpenAI 扁平 content 里无法保留。
>
> **因此本项目采用 `claude ↔ cursor` 直连翻译**：请求把 Anthropic Messages 直接编码进 Cursor protobuf；响应把 protobuf 的 `{text, thinking, toolCall}` 三类信号**直接**拼成 Anthropic SSE 事件。
>
> ### ⚠️ 关于 "Cursor 的 Anthropic 端点"
>
> 经核实：**Cursor 不对外暴露任何 Anthropic 格式接口**。客户端与后端的唯一通道就是私有的 `api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools`（ConnectRPC + protobuf over HTTP/2）。Cursor 硬编码路由把带 "claude" 的模型强制打到自家计费后端，**Claude 跑在 Cursor 服务端，客户端拿到的永远是 Cursor 的 protobuf**，没有 Anthropic SSE 可"抓"。所以"纯 Anthropic 格式"只能靠**我方从 protobuf 信号直接拼装** Anthropic 事件来实现。
>
> 参考逆向资料：[eisbaw/cursor_api_demo](https://github.com/eisbaw/cursor_api_demo) · [everestmz/cursor-rpc](https://github.com/everestmz/cursor-rpc) · [burpheart/cursor-tap](https://github.com/burpheart/cursor-tap/blob/main/cursor-reverse-notes-1.md)

---

## 1. 项目目标与范围

### 1.1 核心能力
1. **协议网关**：把 Anthropic `/v1/messages`（含流式 SSE）请求转换为 Cursor 的 ConnectRPC protobuf 请求；把 Cursor 的二进制响应流转换回 Anthropic 事件流。
2. **单账号即可启动**：录入一个 `workersToken`（Cursor access token）+ `machineId`，立即对外暴露一个可用的 Anthropic 端点。
3. **多账号池调度**：支持优先级、轮询（round-robin / fill-first）、自动限速冷却与故障转移。
4. **可观测与可控**：每个账号独立查看状态（active / rate-limited / error / expired）、用量、最近错误、绑定的代理。
5. **代理池**：每个账号可绑定 SOCKS5/HTTP 动态代理，支持代理池轮换。
6. **管理端**：HeroUI + TailwindCSS，支持批量导入账号、代理池管理、管理员鉴权。

### 1.2 非目标
- 不做 OpenAI / Gemini / 其他 provider（单一职责：Anthropic ↔ Cursor 直连，不引入枢纽格式）。
- 不做 token 计费/账单（只做轻量用量估算）。

---

## 2. 总体架构

```
┌─────────────────┐   Anthropic /v1/messages    ┌──────────────────────────────────────┐
│  Client          │ ──────────────────────────> │           cursor-anthropic              │
│ (Claude Code,    │ <────────────────────────── │                                          │
│  SDK, curl...)   │   Anthropic SSE / JSON       │  ┌────────────┐   ┌──────────────────┐  │
└─────────────────┘                               │  │ API Gateway │──>│ Account Scheduler │  │
                                                   │  │ (/v1/...)   │   │ (优先级/轮询/冷却) │  │
                                                   │  └─────┬──────┘   └────────┬─────────┘  │
                                                   │        │                   │            │
                                                   │  ┌─────▼───────────────────▼─────────┐  │
                                                   │  │   Direct Translator (无 OpenAI 层) │  │
                                                   │  │  claude → cursor (req)              │  │
                                                   │  │  cursor(protobuf) → claude (resp)   │  │
                                                   │  └─────────────────┬─────────────────┘  │
                                                   │                    │                    │
                                                   │  ┌─────────────────▼─────────────────┐  │
                                                   │  │        CursorExecutor              │  │
                                                   │  │  protobuf 编码 + Jyh checksum 头   │  │
                                                   │  │  HTTP/2 或 proxy fetch              │  │
                                                   │  └─────────────────┬─────────────────┘  │
                                                   │                    │ ConnectRPC protobuf │
                                                   └────────────────────┼────────────────────┘
                                                                        ▼
                                                              https://api2.cursor.sh
                                                       /aiserver.v1.ChatService/StreamUnifiedChatWithTools
```

### 2.1 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 20 | 需要原生 `http2`、`fetch`、`zlib` |
| Web 框架 | Next.js 15 (App Router) | API routes + 管理端同仓；或拆分 Fastify + Vite |
| 管理端 UI | **HeroUI** + **TailwindCSS** | 组件库 + 原子样式 |
| 数据库 | SQLite (better-sqlite3) | 默认；抽象 adapter 以便换 Postgres |
| 代理 | undici `ProxyAgent` + `socks-proxy-agent` | HTTP/SOCKS5 |
| 鉴权 | bcrypt + JWT (httpOnly cookie) | 管理员登录 |
| protobuf | 手写 wire-format 编解码器 | 不依赖 .proto 文件 |

---

## 3. Cursor 协议处理（核心模块）

### 3.1 鉴权头生成（`lib/cursor/checksum.js`）

Cursor 需要一组特定请求头，最关键的是 `x-cursor-checksum`（Jyh cipher）。

```js
import crypto from "crypto";
import { v5 as uuidv5 } from "uuid";

export function generateHashed64Hex(input, salt = "") {
  return crypto.createHash("sha256").update(input + salt).digest("hex");
}

// Jyh cipher：时间戳 6 字节 → XOR 链 → URL-safe base64 → 拼 machineId
export function generateCursorChecksum(machineId) {
  const ts = Math.floor(Date.now() / 1e6);
  const bytes = new Uint8Array([
    (ts >> 40) & 0xff, (ts >> 32) & 0xff, (ts >> 24) & 0xff,
    (ts >> 16) & 0xff, (ts >> 8) & 0xff, ts & 0xff,
  ]);
  let t = 165;
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = ((bytes[i] ^ t) + (i % 256)) & 0xff;
    t = bytes[i];
  }
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let enc = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] || 0, c = bytes[i + 2] || 0;
    enc += ALPHA[a >> 2] + ALPHA[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) enc += ALPHA[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) enc += ALPHA[c & 63];
  }
  return `${enc}${machineId}`;
}

export function buildCursorHeaders(accessToken, machineId, ghostMode = true) {
  const token = accessToken.includes("::") ? accessToken.split("::")[1] : accessToken;
  const machine = machineId || generateHashed64Hex(token, "machineId");
  return {
    authorization: `Bearer ${token}`,
    "connect-accept-encoding": "gzip",
    "connect-protocol-version": "1",
    "content-type": "application/connect+proto",
    "user-agent": "connect-es/1.6.1",
    "x-client-key": generateHashed64Hex(token),
    "x-cursor-checksum": generateCursorChecksum(machine),
    "x-cursor-client-version": "3.1.0",
    "x-cursor-client-type": "ide",
    "x-cursor-client-os": process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    "x-cursor-client-arch": process.arch === "arm64" ? "aarch64" : "x64",
    "x-cursor-client-device-type": "desktop",
    "x-cursor-config-version": crypto.randomUUID(),
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "x-ghost-mode": ghostMode ? "true" : "false",
    "x-request-id": crypto.randomUUID(),
    "x-session-id": uuidv5(token, uuidv5.DNS),
    "x-amzn-trace-id": `Root=${crypto.randomUUID()}`,
  };
}
```

> ⚠️ `x-cursor-client-version` 等会随 Cursor 升级失效，做成可配置常量集中管理（见 §9 协议版本治理）。

### 3.2 protobuf 编解码（`lib/cursor/protobuf.js`）

ConnectRPC 帧格式：`[1B flags][4B big-endian length][payload]`。payload 是 protobuf。

**字段号表（硬编码，无 .proto）** —— 关键字段：

```
// 请求 StreamUnifiedChatRequest
MESSAGES=1, MODEL=5, IS_AGENTIC=27, SUPPORTED_TOOLS=29, MCP_TOOLS=34,
UNIFIED_MODE=46, SHOULD_DISABLE_TOOLS=48, THINKING_LEVEL=49, UNIFIED_MODE_NAME=54

// ConversationMessage
MSG_CONTENT=1, MSG_ROLE=2, MSG_ID=13, MSG_TOOL_RESULTS=18, MSG_IS_AGENTIC=29, MSG_UNIFIED_MODE=47

// 响应 StreamUnifiedChatResponseWithTools
TOOL_CALL=1, RESPONSE=2
//  ClientSideToolV2Call: TOOL_ID=3, TOOL_NAME=9, TOOL_RAW_ARGS=10, TOOL_IS_LAST=11, TOOL_MCP_PARAMS=27
//  StreamUnifiedChatResponse: RESPONSE_TEXT=1, THINKING=25
```

核心函数（与 9router 一致，建议直接复用）：
- 编码：`encodeVarint / encodeField / encodeMessage / encodeMcpTool / encodeToolResult / generateCursorBody`
- 解码：`decodeMessage / parseConnectRPCFrame / extractTextFromResponse / extractToolCall`
- 帧封装：`wrapConnectRPCFrame(payload, compress=false)` —— **请求不压缩**，响应可能 gzip。

**响应解析返回三类信号**：
```js
extractTextFromResponse(payload) → { text, thinking, toolCall, error }
// field 1 → toolCall（需再解 MCP_PARAMS 拿真实工具名/参数）
// field 2 → { text(=field1), thinking(=field25) }
```

### 3.3 执行器（`lib/cursor/executor.js`）

职责：组 URL/头/body → 发请求（http2 优先，走代理时回退 fetch）→ 拆帧解压解码 → **产出归一化解码事件流**（`{type:'text'|'thinking'|'tool_call'|'error', ...}`），交给 `cursor→claude` 翻译器直接拼成 Anthropic SSE。**不产出 OpenAI 格式**。

```js
const COMPRESS_FLAG = { NONE: 0x00, GZIP: 0x01, TRAILER: 0x02, GZIP_TRAILER: 0x03 };

function decompressPayload(payload, flags) {
  if (payload[0] === 0x7b) return payload;              // JSON 错误，不解压
  if (flags === 0x00) return payload;
  try { return zlib.gunzipSync(payload); }
  catch { try { return zlib.inflateSync(payload); }
  catch { try { return zlib.inflateRawSync(payload); } catch { return payload; } } }
}
```

帧循环（流式与非流式共用一套拆帧逻辑，只是输出形态不同）：
1. 读 `flags` + `length`，切 `payload`，`offset += 5 + length`
2. `decompressPayload`
3. 若 JSON 错误帧（`{...."error"....}`）：**已有内容则 break，否则返回错误响应**（区分 `resource_exhausted` → rate_limit）
4. `extractTextFromResponse`：
   - `toolCall` → 按 id 累积到 `toolCallsMap`，`isLast` 时 finalize
   - `text` / `thinking` → 累加并发 chunk
5. 流结束：finalize 残留 tool_call，标记 `stopReason`（有工具→`tool_use`，否则→`end_turn`）

> **关键设计（区别于 9router）**：executor 输出的是**与格式无关的归一化事件**，不绑定 OpenAI 也不绑定 Claude。由于本项目只产出 Anthropic，唯一的下游消费者是 `cursor→claude` 发射器（§4.2），它把 `text/thinking/tool_call` 事件**直接**映射成 Anthropic 的 `content_block_*` 事件——`thinking` 和 `tool_use` 的结构因此全程无损，不经 OpenAI 扁平化。

### 3.4 网络层（`lib/net/proxyFetch.js`）

```js
export async function proxyAwareFetch(url, options, proxyOptions) {
  const proxyUrl = resolveProxyUrl(url, proxyOptions); // 连接级代理 > env 代理
  if (proxyUrl) {
    const dispatcher = await getDispatcher(proxyUrl);   // undici ProxyAgent / socks
    try { return await fetch(url, { ...options, dispatcher }); }
    catch (e) {
      if (proxyOptions?.strictProxy) throw e;           // 严格模式不回退
      return fetch(url, options);
    }
  }
  return fetch(url, options);
}
```
- SOCKS5：`getDispatcher` 内对 `socks://` 用 `socks-proxy-agent` 构造 undici 兼容 dispatcher。
- **走代理时强制用 fetch 而非 http2**（http2 直连无法套 ProxyAgent）。

---

## 4. 格式翻译（Anthropic ↔ Cursor 直连，无 OpenAI 中间层）

### 4.1 直连管线

```
请求:  CLAUDE(messages) ──claudeToCursor()──> CURSOR(protobuf)
响应:  CURSOR(protobuf) ──executor 解码──> 归一化事件 ──cursorToClaude()──> CLAUDE SSE
```

只有两个翻译器，无需注册表/枢纽格式：
- `lib/translator/claudeToCursor.js`（请求）
- `lib/translator/cursorToClaude.js`（响应，消费 executor 的归一化事件，产出 Anthropic SSE）

入口（`api/v1/messages`）固定 Anthropic，无需格式探测。

### 4.2 claude → cursor（`claudeToCursor.js`）

将 Anthropic Messages（含 `system` 顶层字段、content blocks）直接归一化为 Cursor 会话消息，再交 `generateCursorBody` 编码 protobuf。

**消息归一化**：
```js
// 1) 顶层 system（string 或 block[]）→ 首条 user 消息前缀
if (body.system) push({ role: "user", content: `[System Instructions]\n${flatten(body.system)}` });

// 2) 遍历 messages：
//   - user / assistant 的 text block → 取文本
//   - assistant 的 tool_use block → 收集为 tool_calls（input 为结构化 JSON，原样保留）
//   - user 的 tool_result block → 见下方策略
```

**tool_result 处理（关键，沿用 9router 的踩坑结论）**：
Cursor 原生 protobuf tool_result 在 schema 轻微不匹配时会**让 Cursor 死循环**。因此**默认采用文本块降级**：把 Anthropic `tool_result` 渲染成结构化 XML 文本块塞进 user 消息：
```xml
<tool_result>
  <tool_name>Read</tool_name>
  <tool_use_id>toolu_xxx</tool_use_id>
  <result>...(sanitizeToolResultText + escapeXml)...</result>
</tool_result>
```
- `sanitizeToolResultText`：剥离不可打印控制字符（避免 backend 报错）
- 工具名与 `tool_use.id` 通过一张 `id→name` 映射表关联（Anthropic 的 tool_result 只带 `tool_use_id`，名字要回查对应的 `tool_use` block）

> **备用路径**：`protobuf.js` 保留 `encodeToolResult`（原生 `ClientSideToolV2Result` → `MCPResult` 嵌套），需要时可切换。工具名统一 `mcp_custom_<name>`，`tool_use_id` 经 `\nmc_` 拆 `modelCallId`。

**工具名 / agent 模式映射**：

| Anthropic 输入 | Cursor 编码 |
|---|---|
| `tools[].name = Read` | `mcp_custom_Read`（`encodeMcpTool`，schema 取 `input_schema`） |
| `mcp__server__tool` | `mcp_server_tool` |
| 有 tools / UA=claude-cli | `isAgentic=1`, `unified_mode=AGENT`, `should_disable_tools=0`, `unified_mode_name="Agent"` |
| 无 tools | `unified_mode=CHAT`, `should_disable_tools=1`, `unified_mode_name="Ask"` |
| `thinking: { type:"enabled", budget_tokens }` | `thinking_level`：budget 高→2(HIGH) / 中→1(MEDIUM) |

### 4.3 cursor → claude（`cursorToClaude.js`）—— 直接拼 Anthropic 事件

消费 executor 的归一化事件，产出标准 Anthropic SSE。**这是"纯 Anthropic 格式"的落点**：

```
event: message_start        → { type, message: { id, role:"assistant", model, usage } }

// thinking（来自 protobuf field 25，1:1 映射 Anthropic thinking 块）
event: content_block_start  → index 0, { type:"thinking" }
event: content_block_delta  → { type:"thinking_delta", thinking:"..." }
event: content_block_stop   → index 0

// text（protobuf field 1）
event: content_block_start  → index 1, { type:"text", text:"" }
event: content_block_delta  → { type:"text_delta", text:"..." }
event: content_block_stop   → index 1

// tool_use（protobuf ClientSideToolV2Call）
event: content_block_start  → index 2, { type:"tool_use", id, name, input:{} }
event: content_block_delta  → { type:"input_json_delta", partial_json:"..." }  // 流式拼 arguments
event: content_block_stop   → index 2

event: message_delta        → { delta:{ stop_reason:"end_turn"|"tool_use" }, usage:{ output_tokens } }
event: message_stop
```

要点：
- **thinking 无损**：Cursor 有专用 thinking 字段，直达 Anthropic `thinking_delta`，无需经 OpenAI 的 `reasoning_content` 折损。
- **tool_use 无损**：工具参数以 `input_json_delta.partial_json` 流式下发，客户端按 Anthropic 规范自行拼成 `input` 对象——不经"字符串化→反序列化"双跳。
- `stop_reason`：有 tool_call → `tool_use`，否则 → `end_turn`；遇 `resource_exhausted` 错误帧 → 返回 Anthropic `rate_limit_error`。
- 非流式（`stream:false`）：累积全部事件后组装成单个 Anthropic `message` 对象返回。
- usage：`input_tokens` 轻量估算，`output_tokens` 按累积文本估算。

---

## 5. 多账号池：数据模型与调度

### 5.1 数据模型（`cursor_accounts` 表）

```sql
CREATE TABLE cursor_accounts (
  id            TEXT PRIMARY KEY,           -- uuid
  name          TEXT,                       -- 显示名/备注
  email         TEXT,                       -- 从 JWT 解出
  access_token  TEXT NOT NULL,              -- workersToken
  machine_id    TEXT NOT NULL,              -- Cursor machineId
  ghost_mode    INTEGER DEFAULT 1,
  priority      INTEGER NOT NULL,           -- 1=最高，新增=max+1
  is_active     INTEGER DEFAULT 1,          -- 管理员手动启停
  -- 调度运行态
  status        TEXT DEFAULT 'active',      -- active | rate_limited | error | expired | disabled
  last_used_at  TEXT,
  consecutive_use_count INTEGER DEFAULT 0,  -- 粘性轮询计数
  backoff_level INTEGER DEFAULT 0,          -- 指数退避层级
  last_error    TEXT,
  error_code    INTEGER,
  last_error_at TEXT,
  cooldown_until TEXT,                      -- 全局冷却到期时间（ISO）
  expires_at    TEXT,                       -- token 过期（默认 +24h）
  -- 代理绑定
  proxy_pool_id TEXT,                       -- 关联 proxy_pools.id（可空）
  proxy_url     TEXT,                       -- 直接指定单一代理（优先于池）
  -- 用量
  total_requests INTEGER DEFAULT 0,
  total_errors   INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_acc_priority ON cursor_accounts(priority);
CREATE INDEX idx_acc_status   ON cursor_accounts(status, is_active);
```

代理池：
```sql
CREATE TABLE proxy_pools (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  strategy    TEXT DEFAULT 'round-robin',  -- round-robin | random
  proxies     TEXT NOT NULL,               -- JSON: ["socks5://u:p@h:p", "http://..."]
  cursor      INTEGER DEFAULT 0,           -- round-robin 游标
  is_active   INTEGER DEFAULT 1,
  created_at  TEXT, updated_at TEXT
);

CREATE TABLE admins (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,             -- bcrypt
  created_at    TEXT
);
```

### 5.2 账号选择算法（`lib/scheduler/selectAccount.js`）

```js
export async function selectAccount({ strategy = "fill-first", exclude = new Set() }) {
  const now = Date.now();
  const all = await db.getActiveAccounts(); // is_active=1，按 priority 升序
  const available = all.filter(a =>
    !exclude.has(a.id) &&
    a.status !== "expired" &&
    !(a.cooldown_until && new Date(a.cooldown_until).getTime() > now)
  );
  if (!available.length) {
    const next = all.map(a => a.cooldown_until).filter(Boolean).sort()[0];
    return { allRateLimited: true, retryAfter: next || null };
  }

  if (strategy === "round-robin") {
    const STICKY = 3;
    const byRecency = [...available].sort((a, b) =>
      (b.last_used_at ? +new Date(b.last_used_at) : 0) - (a.last_used_at ? +new Date(a.last_used_at) : 0));
    const cur = byRecency[0];
    if (cur?.last_used_at && (cur.consecutive_use_count || 0) < STICKY) {
      await db.touchAccount(cur.id, { consecutive_use_count: cur.consecutive_use_count + 1 });
      return cur;
    }
    const lru = [...available].sort((a, b) =>
      (a.last_used_at ? +new Date(a.last_used_at) : 0) - (b.last_used_at ? +new Date(b.last_used_at) : 0))[0];
    await db.touchAccount(lru.id, { consecutive_use_count: 1 });
    return lru;
  }

  // fill-first：按优先级取第一个可用
  const acc = available[0];
  await db.touchAccount(acc.id, { consecutive_use_count: (acc.consecutive_use_count || 0) + 1 });
  return acc;
}
```

### 5.3 错误捕捉与冷却（`lib/scheduler/fallback.js`）

```js
const BACKOFF = { base: 2000, max: 5 * 60 * 1000, maxLevel: 8 };
const TRANSIENT_COOLDOWN_MS = 30 * 1000;

const ERROR_RULES = [
  { text: "rate limit",          backoff: true },
  { text: "too many requests",   backoff: true },
  { text: "quota exceeded",      backoff: true },
  { text: "resource_exhausted",  backoff: true },     // Cursor 限速
  { text: "unauthorized",        cooldownMs: 2 * 60 * 1000, status: "error" },
  { status: 429,                 backoff: true },
  { status: 401,                 cooldownMs: 2 * 60 * 1000, status: "error" },
  { status: 403,                 cooldownMs: 5 * 60 * 1000, status: "error" },
];

function quotaCooldown(level) {
  return Math.min(BACKOFF.base * 2 ** Math.max(0, level - 1), BACKOFF.max);
}

export function classifyError(status, errorText, backoffLevel = 0) {
  const s = (typeof errorText === "string" ? errorText : JSON.stringify(errorText || "")).toLowerCase();
  for (const r of ERROR_RULES) {
    const hit = (r.text && s.includes(r.text)) || (r.status && r.status === status);
    if (!hit) continue;
    if (r.backoff) {
      const lvl = Math.min(backoffLevel + 1, BACKOFF.maxLevel);
      return { shouldFallback: true, cooldownMs: quotaCooldown(lvl), newLevel: lvl, status: "rate_limited" };
    }
    return { shouldFallback: true, cooldownMs: r.cooldownMs, newLevel: backoffLevel, status: r.status || "error" };
  }
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS, newLevel: backoffLevel, status: "error" };
}

export async function markUnavailable(accountId, status, errorText) {
  const acc = await db.getAccount(accountId);
  const { cooldownMs, newLevel, status: st } = classifyError(status, errorText, acc.backoff_level);
  await db.updateAccount(accountId, {
    status: st,
    cooldown_until: new Date(Date.now() + cooldownMs).toISOString(),
    backoff_level: newLevel,
    last_error: String(errorText).slice(0, 200),
    error_code: status,
    last_error_at: new Date().toISOString(),
    total_errors: acc.total_errors + 1,
  });
  return { cooldownMs };
}

export async function markSuccess(accountId) {
  await db.updateAccount(accountId, {
    status: "active", cooldown_until: null, backoff_level: 0,
    last_error: null, last_error_at: null,
  });
}
```

> 与 9router 的差异：本项目只服务 Cursor + 单一 Anthropic 格式，因此把 9router 的「按 (account, model) 锁」简化为「按 account 全局冷却」。若需更细粒度（不同 Claude 模型独立限速），可恢复 `modelLock_<model>` 设计。

### 5.4 请求主循环（`api/v1/messages` handler）

```js
export async function handleMessages(req) {
  const claudeBody = await req.json();
  const stream = claudeBody.stream !== false;
  const exclude = new Set();

  while (true) {
    const acc = await selectAccount({ strategy: settings.strategy, exclude });
    if (acc.allRateLimited) {
      return anthropicError(429, "All Cursor accounts are rate-limited", { retryAfter: acc.retryAfter });
    }

    // 1) 翻译 claude → cursor(protobuf) —— 直连，无 OpenAI 中间层
    const { messages, tools, thinkingLevel } = claudeToCursor(claudeBody);
    const cursorBody = generateCursorBody(
      messages, mapModel(claudeBody.model), tools, thinkingLevel,
      isClaudeCodeUA(req.headers["user-agent"])
    );

    // 2) 解析代理
    const proxyOptions = await resolveProxy(acc);

    // 3) 执行
    const exec = await cursorExecutor.execute({
      body: cursorBody, stream,
      credentials: { accessToken: acc.access_token, machineId: acc.machine_id, ghostMode: !!acc.ghost_mode },
      proxyOptions,
    });

    if (exec.status !== 200) {
      const { } = await markUnavailable(acc.id, exec.status, exec.errorText);
      exclude.add(acc.id);
      continue; // 故障转移到下一个账号
    }

    await markSuccess(acc.id);
    await db.bumpUsage(acc.id);

    // 4) 响应 cursor 归一化事件 → Anthropic SSE（直连）
    return cursorToClaude(exec.events, { stream, model: claudeBody.model });
  }
}
```

---

## 6. Token / 账号导入

### 6.1 单个录入（手动）
`POST /api/accounts/import`
```jsonc
{ "accessToken": "ey...", "machineId": "uuid...", "name": "acc-1", "priority": 1, "ghostMode": true }
```
- 校验：token 长度 > 50；machineId 形如 UUID（`/^[a-f0-9-]{32,}$/i`）
- 从 JWT payload 解 `email` / `userId`（`extractUserInfo`）
- `expires_at = now + 24h`
- 去重：同 email 则更新而非新增

### 6.2 批量导入
`POST /api/accounts/bulk-import`，支持多格式：

```jsonc
// 格式 A: JSON 数组
[{ "accessToken": "...", "machineId": "...", "name": "a" }, ...]

// 格式 B: 行文本（每行 token----machineId 或 token,machineId）
ey...----uuid-1
ey...,uuid-2

// 格式 C: CSV（带表头 name,accessToken,machineId,priority,proxyUrl）
```
- 解析 → 逐条校验 → 事务批量插入 → 返回 `{ imported, skipped, errors:[{line, reason}] }`
- 优先级：未指定则从当前 max 递增分配
- 可选「导入即测试」：异步对每个账号发一个最小探测请求标记初始 status

### 6.3 自动导入（从本机 Cursor 提取，可选）
读取本机 `state.vscdb`（SQLite）：
- accessToken keys: `cursorAuth/accessToken`, `cursorAuth/token`
- machineId keys: `storage.serviceMachineId`, `storage.machineId`, `telemetry.machineId`
- 平台路径：macOS `~/Library/Application Support/Cursor/...`、Windows `%APPDATA%/Cursor/...`、Linux `~/.config/Cursor/...`
- 提取策略：优先 `better-sqlite3`，回退 `sqlite3` CLI，再回退手动粘贴提示。

---

## 7. 管理端（HeroUI + TailwindCSS）

### 7.1 页面结构

```
/login                     管理员登录
/dashboard                 概览：账号总数 / active / rate-limited / error，QPS、今日请求
/dashboard/accounts        账号列表（表格）+ 单个/批量导入 + 启停/优先级调整/删除
/dashboard/accounts/[id]   单账号详情：状态、用量曲线、最近错误、绑定代理、token 信息、手动测试
/dashboard/proxy-pools     代理池管理：增删池、编辑代理列表、测试连通性
/dashboard/settings        调度策略(fill-first/round-robin)、stickyLimit、退避参数、管理员改密
```

### 7.2 关键组件（HeroUI）

| 页面 | HeroUI 组件 |
|---|---|
| 账号列表 | `Table`, `Chip`(状态色), `Dropdown`(操作), `Pagination` |
| 状态徽章 | `Chip`：active=success / rate_limited=warning / error=danger / expired=default |
| 批量导入 | `Modal` + `Textarea` + `Tabs`(JSON/行文本/CSV) + `Progress` |
| 优先级编辑 | `Input(type=number)` 或拖拽排序 |
| 代理池 | `Card` + `Table` + `Switch`(启用) + 测试按钮 `Button` + `Spinner` |
| 设置 | `Select`(策略), `Slider`(stickyLimit), `Input` |
| 登录 | `Card` + `Input`(用户名/密码) + `Button` |

样式：TailwindCSS 原子类 + HeroUI 主题（`tailwind.config` 引入 `heroui()` 插件）。

```js
// tailwind.config.js
import { heroui } from "@heroui/react";
export default {
  content: ["./src/**/*.{js,jsx,ts,tsx}", "./node_modules/@heroui/theme/dist/**/*.{js,ts}"],
  darkMode: "class",
  plugins: [heroui()],
};
```

### 7.3 账号状态实时刷新
- 列表页轮询 `GET /api/accounts?fields=status,cooldown_until,last_error`（5s）或 SSE 推送。
- `cooldown_until` 倒计时在前端用 `Chip` + 剩余秒数展示。

---

## 8. 管理员鉴权与初始化

### 8.1 初始管理员
- 首次启动若 `admins` 表为空：
  - 读环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（`.env`），bcrypt 后写入；
  - 或进入「首次安装」引导页 `/setup` 让用户设置。
- 默认值（仅开发）：`admin` / 随机生成并打印到 stdout（强制首次登录改密）。

```env
# .env.example
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me-on-first-login
JWT_SECRET=please-generate-a-32-byte-random-secret
DATABASE_PATH=./data/cursor-anthropic.db
PORT=3000
# 全局出站代理（账号未绑定时回退）
ALL_PROXY=
NO_PROXY=api2.cursor.sh
```

### 8.2 登录流程
- `POST /api/auth/login` → bcrypt 比对 → 签发 JWT 写 httpOnly + SameSite=strict cookie。
- 中间件 `middleware.js` 保护 `/dashboard/*` 和除 `/v1/*` 外的 `/api/*`。
- `/v1/messages` 等对外 API 用**独立的 API Key**鉴权（`x-api-key` 头），与管理员登录解耦。

### 8.3 对外 API 鉴权
```sql
CREATE TABLE api_keys (id TEXT PRIMARY KEY, key_hash TEXT, name TEXT, is_active INTEGER, created_at TEXT);
```
- 客户端用 `x-api-key: sk-...` 调 `/v1/messages`；服务端比对 hash。
- 管理端可生成/吊销 API Key。

---

## 9. 协议版本治理与健壮性

| 风险 | 对策 |
|---|---|
| Cursor 升级改 protobuf 字段号 | `extractTextFromResponse` 检测未知 field 号并告警日志；集中 `PROTOBUF_SCHEMA_VERSION` 常量 |
| `x-cursor-client-version` 失效 | 头部常量集中在 `lib/cursor/constants.js`，支持环境变量覆盖、热更 |
| tool_result 死循环 | 默认文本块降级（§4.2），原生 protobuf 路径作为可开关备用 |
| gzip/deflate 混用 | `decompressPayload` 三级回退 |
| token 24h 过期 | 定时任务标记 `expires_at` 临近的账号为 `expired` 并在管理端高亮提醒重新导入 |
| 代理失效 | `strictProxy` 控制是否回退直连；代理池支持连通性测试 |

---

## 10. 目录结构

```
cursor-anthropic/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── v1/messages/route.js        # 对外 Anthropic 端点
│   │   │   ├── accounts/route.js           # 列表/单导入
│   │   │   ├── accounts/bulk-import/route.js
│   │   │   ├── accounts/[id]/route.js      # 详情/启停/删除/测试
│   │   │   ├── proxy-pools/route.js
│   │   │   ├── auth/login/route.js
│   │   │   └── keys/route.js               # 对外 API Key 管理
│   │   ├── (dashboard)/dashboard/...       # HeroUI 管理端页面
│   │   ├── login/page.js
│   │   └── setup/page.js
│   ├── lib/
│   │   ├── cursor/
│   │   │   ├── checksum.js                  # Jyh cipher + 头
│   │   │   ├── protobuf.js                  # 编解码器
│   │   │   ├── executor.js                  # 拆帧→归一化事件
│   │   │   └── constants.js                 # 客户端版本/字段号/schema 版本
│   │   ├── translator/
│   │   │   ├── claudeToCursor.js            # 请求：Anthropic → Cursor protobuf（直连）
│   │   │   └── cursorToClaude.js            # 响应：归一化事件 → Anthropic SSE（直连）
│   │   ├── scheduler/
│   │   │   ├── selectAccount.js
│   │   │   └── fallback.js
│   │   ├── net/proxyFetch.js
│   │   ├── db/{adapter.js,schema.js,repos/*}
│   │   └── auth/{admin.js,apikey.js,jwt.js}
│   └── middleware.js
├── data/                                    # SQLite 落盘
├── .env.example
├── tailwind.config.js
├── Dockerfile
└── package.json
```

---

## 11. 对外 API 契约（Anthropic 兼容）

`POST /v1/messages`
- 头：`x-api-key`, `anthropic-version`, `content-type: application/json`
- body：标准 Anthropic Messages（`model`, `messages`, `system`, `tools`, `max_tokens`, `stream`, `thinking`...）
- 响应：
  - `stream=true` → `text/event-stream`，事件序列 `message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop`
  - `stream=false` → Anthropic `message` JSON 对象
- 错误：Anthropic 错误格式 `{ "type":"error", "error": { "type":"rate_limit_error"|"api_error", "message":"..." } }`

模型映射 `mapModel()`：把客户端传的 `claude-sonnet-4-*` / `claude-3-5-sonnet` 等映射成 Cursor 支持的模型名（维护一张映射表，未命中则透传）。

---

## 12. 实施里程碑

| 阶段 | 交付 |
|---|---|
| M1 协议核心 | checksum + protobuf 编解码 + executor，单元测试覆盖编/解码与 checksum |
| M2 翻译管线 | claude↔cursor 直连（`claudeToCursor`/`cursorToClaude`），curl 打通 `/v1/messages`（流式+非流式+工具+thinking） |
| M3 单账号网关 | 录入一个 token 即可用；API Key 鉴权 |
| M4 多账号调度 | 选择/退避/故障转移/冷却 + DB |
| M5 代理池 | SOCKS5/HTTP 绑定、池轮换、连通性测试、strictProxy |
| M6 管理端 | HeroUI 列表/详情/批量导入/设置/登录 + 管理员初始化 |
| M7 健壮性 | 协议版本告警、token 过期提醒、可观测日志/指标 |

---

## 附录 A：与 9router 的对应关系（便于复用代码）

| 9router 文件 | cursor-anthropic 对应 | 复用度 |
|---|---|---|
| `open-sse/utils/cursorChecksum.js` | `lib/cursor/checksum.js` | 直接复用 |
| `open-sse/utils/cursorProtobuf.js` | `lib/cursor/protobuf.js` | 直接复用 |
| `open-sse/executors/cursor.js` | `lib/cursor/executor.js` | 复用拆帧/解压/protobuf 解码；**改为输出归一化事件而非 OpenAI chunk** |
| `open-sse/translator/request/openai-to-cursor.js` | `lib/translator/claudeToCursor.js` | **改写**：直接吃 Anthropic content blocks（含 system/tool_result/tool_use），不经 OpenAI |
| `open-sse/translator/response/openai-to-claude.js` | `lib/translator/cursorToClaude.js` | **改写**：直接吃归一化事件拼 Anthropic SSE；thinking/tool_use 无损 |
| `open-sse/translator/index.js`（枢纽注册表） | — | **删除**：单一格式无需注册表/中间层 |
| `open-sse/utils/proxyFetch.js` | `lib/net/proxyFetch.js` | 复用 + 增 socks |
| `src/sse/services/auth.js`(选择) | `lib/scheduler/selectAccount.js` | 简化（单 provider） |
| `open-sse/services/accountFallback.js` | `lib/scheduler/fallback.js` | 简化（account 级冷却） |
| `src/app/api/oauth/cursor/import/route.js` | `api/accounts/import` | 复用校验/JWT 解析 |

## 附录 B：关键常量（需随 Cursor 升级维护）

```js
// lib/cursor/constants.js
export const CURSOR_BASE_URL = "https://api2.cursor.sh";
export const CURSOR_CHAT_PATH = "/aiserver.v1.ChatService/StreamUnifiedChatWithTools";
export const CURSOR_CLIENT_VERSION = process.env.CURSOR_CLIENT_VERSION || "3.1.0";
export const PROTOBUF_SCHEMA_VERSION = "1.1.3";
export const COMPRESS_FLAG = { NONE: 0x00, GZIP: 0x01, TRAILER: 0x02, GZIP_TRAILER: 0x03 };
```
