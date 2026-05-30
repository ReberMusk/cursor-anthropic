# cursor-anthropic

一个把 **一池 Cursor 账号** 暴露成 **原生 Anthropic `/v1/messages` API** 的网关。让 Claude Code / Anthropic SDK / curl 等直接用 Cursor 的模型，并自带多账号调度、限速冷却与故障转移、SOCKS/HTTP 代理池、对外 API Key（sk）鉴权，以及 HeroUI + Tailwind 管理端。

- **直连翻译** `claude ↔ cursor`（不经 OpenAI 中间层）→ `thinking` 与 `tool_use` 无损映射。
- Cursor 走 **ConnectRPC protobuf over HTTP/2**（`api2.cursor.sh`），本网关自行编解码并合成 Anthropic SSE。
- **真流式**：逐帧解码 Cursor 响应并逐 token 下发 `content_block_delta`（非 buffer 后一次性）。`thinking` 可选下发（设置页开关，默认关）。
- **多账号池**：优先级 / 轮询 / 粘性 + 自动限速/区域错误冷却 + 指数退避 + 故障转移。
- **代理池**：SOCKS5/4、HTTP(S) CONNECT，**h2-over-proxy 保持 HTTP/2**。
- **machineId 自动生成**：导入账号无需手动指定 machineId（自动生成合法的 64-hex；同时生成 macMachineId/devDeviceId 等整套 Cursor 标识）。
- **sk 鉴权**：管理端生成/吊销对外 API Key。
- **管理端**：HeroUI + TailwindCSS（登录 / 概览 / 账号池 / 代理池 / 密钥 / 设置）。

> ⚠️ 用 Cursor 订阅这样转 API 可能违反 Cursor ToS，自行承担风险。

## 快速开始

```bash
# 1) 安装依赖并构建管理端（首次）
npm run setup            # = npm install + 构建 web/

# 2) 配置
cp .env.example .env     # 至少设置 ADMIN_USERNAME / ADMIN_PASSWORD

# 3) 启动
node --env-file=.env src/server.js
# 或: npm start
```

打开 `http://localhost:8787/` 用管理员账号登录。首启时若未设 `ADMIN_PASSWORD`，会在终端打印一个随机密码。

### Docker 一键启动（app + MySQL + Redis）

```bash
cp .env.example .env     # 按需修改 ADMIN_PASSWORD / JWT_SECRET 等
docker compose up -d --build
```

`docker compose` 会拉起三件套：网关（MySQL 存储 + Redis 缓存）、MySQL 8、Redis 7，
随后访问 `http://localhost:8787/` 即可。表结构在首启时自动迁移。

### 存储后端（SQLite / MySQL）

- 由 `DB_DRIVER` 切换：`sqlite`（默认，零配置，文件在 `DATABASE_PATH`）或 `mysql`。
- MySQL 用 `DATABASE_URL=mysql://user:pass@host:3306/db`，或拆分的 `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`。
- 设置 `REDIS_URL` 后，热点读路径（调度设置、API Key 校验）走 Redis 共享缓存，多实例可共享；
  不设则使用进程内内存缓存（单实例足够）。

## 在管理端里做的事

1. **账号池**：导入 Cursor access token（JWT）。
   - 单个或批量（每行一个 token，或 `token----machineId` / `token,machineId`，或粘贴 JSON 数组）。
   - **不需要填 machineId** —— 留空会自动生成。邮箱/过期时间从 JWT 自动解析。
   - 支持调整优先级、启停、清冷却、重新生成 machineId、发探测请求测试、删除。
2. **代理池**：新建池、填代理列表、测连通性；账号可绑定池或单独 `proxy_url`。
3. **API 密钥**：生成 `sk-ca-...`（仅显示一次），客户端用它调 `/v1/messages`。
4. **设置**：调度策略（fill-first / round-robin）、粘性窗口、退避参数、改管理员密码。

## 调用 `/v1/messages`

```bash
curl -N -s http://localhost:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: sk-ca-xxxxx' \
  -d '{"model":"claude-sonnet-4","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

在 Claude Code 里：

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 \
ANTHROPIC_API_KEY=sk-ca-xxxxx \
ANTHROPIC_MODEL=claude-sonnet-4 \
claude
```

## 开发

```bash
# 后端（自动重载）
npm run dev
# 管理端（Vite dev server，自动代理 /api 与 /v1 到 8787）
npm run web:dev      # http://localhost:5173
```

构建管理端到 `web/dist`（由后端静态托管）：`npm run web:build`。

## 架构

```
Claude Code ──Anthropic /v1/messages──▶ Express (src/server.js)
                                          │ requireApiKey (sk)
                                          ▼
                                        scheduler.selectAccount() ── 优先级/轮询/冷却
                                          │  ┌── 失败 → fallback.markUnavailable() → 换号
                                          ▼  │
                                        translate.claudeToCursor()  (直连，无 OpenAI)
                                          ▼
                                        gateway.callCursor()  ── checksum 头 + protobuf
                                          │  └── proxyAgent.connectHttp2()  (可选 SOCKS/HTTP 隧道)
                                          ▼ HTTP/2
                                        api2.cursor.sh/.../StreamUnifiedChatWithTools
                                          ▼ protobuf frames → decode
                                        translate.buildAnthropicSSE / Message
Claude Code ◀──Anthropic SSE / JSON─────┘
```

目录：

```
src/
├── server.js              Express：挂载 /v1 + /api + 静态 SPA
├── gateway/               协议核心（复用自 PoC）
│   ├── checksum.js  protobuf.js  executor.js  translate.js  toolAdapter.js  constants.js  uuid.js
├── lib/
│   ├── machineId.js       Cursor 标识生成（machineId/macMachineId/devDeviceId/sqmId）
│   ├── jwt.js             解析 Cursor token 的 email/userId/exp
│   ├── proxyAgent.js      h2-over-proxy（SOCKS/HTTP 隧道 + TLS ALPN h2）
│   └── accountService.js  账号导入/批量解析/脱敏
├── db/{driver.js,schema.js,repos.js} 异步数据层（SQLite/MySQL 双驱动）
├── cache/index.js          可选 Redis 缓存（无则内存回退）
├── scheduler/{selectAccount.js,fallback.js}
├── auth/{admin.js,apikey.js}
└── routes/{messages,auth,accounts,proxies,keys,settings}.js
web/                       Vite + React + HeroUI + Tailwind 管理端
```

## 关于 machineId

Cursor 的 `telemetry.machineId` / `macMachineId` 都是 **64 位 hex**，`devDeviceId` / `serviceMachineId` 是 UUID v4，`sqmId` 是 `{大写UUID}` —— 都是固定格式的标识（这也是各种 "reset machine id" 工具的原理）。

本网关在导入账号时**从 access token 确定性派生**整套标识（见 `src/lib/machineId.js`）：同一个 token 永远得到同一套设备码，即使重启、清库、重复导入也不变。配合导入按 Cursor 用户 id（JWT `sub`）幂等去重 + 更新时**绝不覆盖**已有设备码，因此**一个账号 = 一个稳定设备**，避免 Cursor 的「Too many computers / 设备过多」。你只需提供 token；也可显式指定 `machineId` 覆盖。

## 离线自检

```bash
npm run smoke      # 编解码/翻译/checksum round-trip，无网络
```

## 工具适配（实验性）

Cursor 不接受自定义工具声明，只给原生 palette。`gateway/toolAdapter.js` 在 Read/Bash/LS/Glob/Grep/WebSearch 上做 native↔Claude Code 名字+参数+结果映射；`edit_file`/`Write` 因 diff 格式差异为 best-effort。详见 `TESTING.md`。

## 协议版本治理

`x-cursor-client-version`、protobuf 字段号会随 Cursor 升级漂移，集中在 `src/gateway/constants.js`，可用 `CURSOR_CLIENT_VERSION` 覆盖。完整设计见 `cursor-anthropic-技术文档.md`。
