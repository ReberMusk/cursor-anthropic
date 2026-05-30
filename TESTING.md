# 实测结论（live against api2.cursor.sh）

测试账号：免费档（无 Claude 模型权限，无 MCP/自定义工具权限）。可用模型：`gpt-4o` / `gpt-4.1` / `cursor-small`。
测试脚本：`test/smoke.js`（离线）、`test/probe-models.mjs`、`test/tools.mjs`、`test/one-tool.mjs`、`test/inspect-tools.mjs`、`test/debug` via `CURSOR_FRAME_DEBUG=1`。

## ✅ 已验证可用

| 能力 | 结论 |
|---|---|
| 鉴权（Jyh checksum + 头） | 通过，请求被 Cursor 正常接受 |
| protobuf 请求编码 | 通过，字段结构与 9router 一致（IS_AGENTIC/MCP_TOOLS/UNIFIED_MODE/SUPPORTED_TOOLS 等齐全） |
| HTTP/2 调用 + 帧拆解/解压 | 通过 |
| 纯文本生成 → Anthropic 非流式 message | 通过 |
| 纯文本生成 → Anthropic 流式 SSE | 通过（message_start/content_block_*/message_delta/message_stop 序列正确） |
| **tool_result 多轮回灌**（文本块降级） | **通过**：喂回 `15°C, sunny` 后模型答 "The weather in Paris is currently 15°C and sunny"，**无死循环** |
| 纯聊天不误触发工具 | 通过 |
| tool_call 解码 + 工具名还原（mcp_custom_ 剥离） | 解码逻辑正确 |

## 🐛 已修复的 bug

**工具参数被复制两遍。** 根因：Cursor 流式工具调用发的是**累积全量快照帧**（每帧 = 到目前为止的完整 args），不是增量帧。原代码沿用 9router 的 `+=` 拼接 → 把 `{...}` 拼成 `{...}{...}`。
修复（`src/executor.js`）：改为"保留最长快照"（替换而非追加）。修复后 gpt-4o 返回干净的单份合法 JSON。

> 注意：这与 9router 的 `+=` 实现不同。9router 假设增量；Cursor 实测发全量。若后续发现某些模型确实发增量，需要做"快照 vs 增量"自适应判断。

## ❌ 关键卡点（需要更好的账号才能继续验证）

**Cursor 不把调用方传入的自定义工具暴露给模型——它只给模型自己的原生工具палette。**

证据（cursor-small 直接说明）：
> "I do not have a `get_weather` tool available. I can only use the `ask_question` tool."

即使我们把 `get_weather` 正确编进 protobuf（字段34，已验证），模型拿到的工具仍是 Cursor 内置的 `ask_question`（agent 模式自动注入）。gpt-4o/gpt-4.1 都只会 emit `ask_question`，从不 emit `get_weather`。

**含义**：
- 这是**账号层级限制**——免费档拿不到 MCP/自定义工具。需要 **Pro + MCP 权限**的账号才能验证自定义工具能否真正下发给模型。
- 即便 Pro 能下发，仍存在用户预言的**根本性协议错配**：Claude Code 发的工具是 `Read`/`Write`/`Bash`（带特定 schema），而 Cursor 的模型在 agent 模式下倾向调用 Cursor 原生工具（`read_file`/`run_terminal_cmd`/`ask_question`…，schema 不同）。模型若回 Cursor 原生工具调用，Claude Code 会因"未知工具"报错。

## 建议（搭建正式项目时的工具策略）

1. **先交付纯文本/对话能力**——这部分已验证扎实，可直接在 Claude Code 里当一个"便宜的文本后端"用（非 agent 场景）。
2. **工具能力标记为实验性**，并提供开关。需要在 **Pro+MCP 账号**上重测：自定义工具是否下发、模型是否按名调用。
3. 若 Pro 仍只下发 Cursor 原生工具，则需要一层 **工具名/schema 映射**（Cursor 原生工具 ↔ Claude Code 工具），但这工程量大且脆弱，性价比需评估。
4. tool_result 继续走**文本块降级**（已验证稳、不死循环），不要用原生 protobuf tool_result。

## 更新（地区切换后，东京 IP）

- 切到日本 IP 后 **claude-4-sonnet / claude-4.5-sonnet / claude-4-sonnet-thinking 解锁**（之前的 "Model not available" 是**地区限制**，非账号档位）。
- 修了"per-message agent 标记错用 hasTools"的 bug，并把 `supported_tools` 做成可注入（`CURSOR_SUPPORTED_TOOLS`，packed varint of ClientSideToolV2 ids）。

### 工具机制定性结论
- `supported_tools`（字段29 + 每条消息字段51）= **客户端声明可执行的工具枚举 id 列表**；模型只调用列表内的工具。
- 实测：`supported=[1..11,15..20]` 时模型调用了 **`web_search`（我们没定义的原生工具）** → 证明此列表解锁的是 **Cursor 原生工具**。
- 实测：自定义工具 `get_weather`（field 34 mcp_tools + id 19）**在任何 supported 组合下都不下发给模型**。模型始终只看到原生工具/ask_question。
- → **当前 Cursor 不接受这种自定义 MCP 工具声明**（9router 的 MCP=19 已失效或需真实 MCP server）。可用路线是 **原生工具 ↔ Claude Code 工具适配层**。
- native enum（everestmz proto，0–11）：1=read_semsearch,3=ripgrep_search,4=run_terminal_command,5=read_file,6=list_dir,7=edit_file,8=file_search,9=semantic_search,10=create_file,11=delete_file；15–20 段含 web_search 等（需进一步确认编号）。

## 原生工具 schema（适配层映射依据，实测 claude-4-sonnet 发出）

| Cursor 原生 | 实测 args | CC 工具 | CC input |
|---|---|---|---|
| `read_file` | `{target_file, should_read_entire_file, start_line_one_indexed?, end_line_one_indexed?, explanation}` | Read | `{file_path, offset?, limit?}` |
| `run_terminal_cmd` | `{command, is_background, explanation}` | Bash | `{command}` |
| `list_dir` | `{relative_workspace_path, explanation}` | LS | `{path}` |
| `file_search` | `{query, explanation}` | Glob | `{pattern}` |
| `ripgrep_search` | `{query, ...}` | Grep | `{pattern}` |
| `web_search` | `{search_term, explanation}` | WebSearch | `{query}` |
| `edit_file` | `{target_file, code_edit, instructions}` ← diff 标记格式 | Edit/Write | `{old_string,new_string}` ⚠️ 格式不兼容，best-effort |
| `create_file` | (未单测) | Write | `{file_path, content}` |

native enum id（everestmz proto 0–11）：3=ripgrep_search 4=run_terminal_cmd 5=read_file 6=list_dir 7=edit_file 8=file_search 10=create_file 11=delete_file；web_search 在 15–20 段（确切编号待定，用广列表即触发）。

### 9router 对照
9router **不是适配层**：它把调用方工具当 MCP 自定义工具编码（field 34）+ `supported_tools=[1]` + 剥 `mcp_custom_` 前缀。这套在当前 Cursor 上**不下发自定义工具**（已实测）。即 9router 在工具这块与我们卡在同一处，且无原生映射可抄——原生适配层是新增能力。

## 适配层进展（native ↔ Claude Code）

实现 `src/toolAdapter.js`：
- 请求：从 CC tools[] 推导 `supported_tools` 原生 enum ids（Read→5, Bash→4, LS→6, Glob→8, Grep→3, Write→10, Edit→7, WebSearch→15..20）。不再编码自定义 MCP 工具。
- 响应：原生工具调用 → CC `tool_use`，名字回映射 + 参数 remap（target_file→file_path 等），丢弃 Cursor 的 `explanation` 字段。

实测（claude-4-sonnet）：
- ✅ **Read 通**：`read_file{target_file}` → `tool_use{name:"Read", input:{file_path}}`。适配概念成立。
- ⚠️ Bash 未触发（prompt 太简单，模型口头答；需更明确的 prompt 重测）。
- ❌ **多轮 round-trip 失败**：历史 tool_use/tool_result 用 XML 文本块喂回 → 模型不认，重新调用 Read。

### ✅ 工具闭环已打通（agentic 可用）
三处修复后，Read/Bash 的发起 + 多轮 round-trip 全部实测通过（claude-4-sonnet）：

1. **完整原生工具集**：agent 模式声明全套 native ids `[1..11,15..20]`（`supportedIdsFromClaudeTools` 返回 FULL_NATIVE_IDS）。只给单个 id 模型会说"没有该工具"。
2. **原生 ToolResult 编码**（`encodeNativeToolResult`，protobuf 字段18 + ClientSideToolV2Result）：用 Cursor 原始 call_id（透传为 tool_use.id，CC 原样回传）关联。`read_file_result`/`run_terminal_command_result` 填具体 result，其余靠 ToolResult.content（字段7）兜底。
3. **双向映射**（`toolAdapter.js`）：native→CC 名字 + 参数 remap（target_file→file_path、command→command…），丢弃 Cursor 的 explanation 字段。

实测结果：
```
✓ Read → tool_use{name:Read, input:{file_path}}
✓ Bash → tool_use{name:Bash, input:{command:"git branch --show-current"}}
✓ round-trip: 模型用 tool_result 正确回答，无重复调用
```

### 仍待打磨（非阻塞）
- `edit_file`：Cursor 的 `code_edit` 是 "// ...existing code..." diff 格式，与 CC 的 Edit(old/new_string) 不兼容 → 仍 best-effort（放进 `_cursor_code_edit`）。Write(create_file) 类似需补 result 结构。
- 无 CC 对应物的 native 工具（delete_file=11、semantic_search=9、read_semsearch=1）：模型若调用，名字透传，CC 可能报未知工具（编码场景少见）。
- 全 native 集可能让模型偶尔调用 CC 未声明的工具；可按 CC tools 收窄白名单（权衡：收窄会触发"模型说没工具"）。

## 复现命令

```bash
export CURSOR_MACHINE_ID=... CURSOR_ACCESS_TOKEN=...
node test/smoke.js                              # 离线自检
node test/probe-models.mjs                      # 探测可用模型
CURSOR_MODEL=gpt-4o node test/tools.mjs         # 工具场景 A–E
node test/one-tool.mjs                           # 三个模型各发一次工具调用
CURSOR_FRAME_DEBUG=1 node test/one-tool.mjs      # 看每帧的流式 args
```
