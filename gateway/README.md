# NextChat 自建后端网关

OpenAI 兼容入口的多模型路由网关骨架（独立 Fastify + TypeScript 服务，与 NextChat 主应用解耦）。

```
客户端 (NextChat / 任意 OpenAI 兼容客户端)
    │  POST /v1/chat/completions  (OpenAI 格式, Bearer <网关key>)
    ▼
┌─────────────── gateway (Fastify, :3600) ───────────────┐
│  ① 统一鉴权: API Key / JWT(HS256)，未通过即 401/403     │
│  ② 路由: model 名 → provider (精确 + 前缀匹配)          │
│  ③ 转发: 替换上游真实 key, body 原样透传, SSE 流式回传   │
└────┬──────────────┬──────────────┬─────────────────────┘
     ▼              ▼              ▼
  Alibaba         DeepSeek        Zhipu GLM
 (DashScope      (api.deep-     (open.bigmodel.cn
  兼容模式)       seek.com)      /api/paas/v4)
```

## 已接入的 provider

| provider | 模型（精确） | 模型（前缀匹配） | 环境变量 |
|---|---|---|---|
| alibaba | qwen-plus / qwen-turbo / qwen-max / qwen-long | qwen2* / qwen2.5* / qwen3* / qvq* | `ALIBABA_API_KEY` |
| deepseek | deepseek-chat / deepseek-reasoner | — | `DEEPSEEK_API_KEY` |
| zhipu | — | glm-4* / glm-4.5* / glm-4.6* | `ZHIPU_API_KEY` |

## 快速开始

```bash
cd gateway
npm install
cp .env.example .env   # 填入各 provider 的 key
npm run dev            # tsx watch, http://127.0.0.1:3600
```

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/v1/chat/completions` | 需 | 聊天补全，OpenAI 兼容，支持 `stream: true`（SSE 透传） |
| GET | `/v1/models` | 需 | 模型列表（按客户端白名单过滤） |
| POST | `/v1/auth/token` | 需（仅认 API Key） | 用 API Key 换取 JWT |
| GET | `/v1/auth/whoami` | 需 | 查看当前调用方身份 |
| GET | `/healthz` | 免 | 健康检查 + provider 就绪状态 |
| POST | `/api/auth/register` | 免 | 注册用户（返回用户 + 令牌） |
| POST | `/api/auth/login` | 免 | 登录（返回用户令牌） |
| GET | `/api/auth/me` | 用户 | 当前用户信息 |
| POST | `/api/conversations` | 用户 | 创建会话 |
| GET | `/api/conversations` | 用户 | 会话列表（只含自己的） |
| GET | `/api/conversations/:id` | 用户 | 会话详情 + 消息 |
| POST | `/api/conversations/:id/messages` | 用户 | 追加消息 |
| DELETE | `/api/conversations/:id` | 用户 | 删除会话（级联删消息） |
| GET | `/api/sync/state` | 用户 | 拉取云端状态快照（`?key=chat`，默认 chat） |
| PUT | `/api/sync/state` | 用户 | 写入快照，带 `baseUpdatedAt` 乐观锁，冲突返回 409 + 服务端最新 |
| DELETE | `/api/sync/state` | 用户 | 删除快照 |
| GET | `/api/sync/state/keys` | 用户 | 列出当前用户的快照 key 与体积/版本 |

> 用户体系与表设计见 `docs/gateway-user-auth.md`（SQLite：users / conversations / messages）。
> 多端对话同步（整包快照方案）见 `docs/frontend-cloud-sync.md`。

### 快照同步的设计取舍

`cloud_state.payload` 是**不透明 JSON**，网关不解析其内容。这样做的原因：
前端 `ChatSession` 结构复杂且会演进（`mask` / `memoryPrompt` / `stat` / `tools` …），
逐字段映射进关系表必然丢字段；整包快照换取的是「换设备看到的一模一样」。
乐观锁用 `baseUpdatedAt`：服务端更新 → 409 并回传服务端最新，由客户端合并后重试。
8MB 上限，`state_key` 只允许 `[A-Za-z0-9_.-]{1,64}`。

### 鉴权（详见 `docs/gateway-auth.md`）

- 支持两种凭证：**API Key**（`GATEWAY_API_KEYS`，多 Key 可带 clientId）与
  **JWT（HS256，零依赖实现）**，由 `AUTH_MODE=apikey|jwt|both` 控制，默认 `both`。
- 携带方式：`Authorization: Bearer <凭证>` 或 `X-Api-Key: <凭证>`。
- JWT 可声明 `scope` / `models` / `providers`，实现按接口、按模型限权。
- **未授权一律拒绝**：无凭证 / 错 Key / 失效 JWT → 401；越权 → 403。
- **fail-closed**：未配置任何凭证且未显式 `ALLOW_ANONYMOUS=true` 时，网关拒绝启动。

```bash
curl -X POST http://127.0.0.1:3600/v1/chat/completions \
  -H "Authorization: Bearer sk-gateway-local-2026" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"hi"}]}'
```

## 接入 NextChat（作为「自定义 endpoint」）

1. 启动网关：`npm run start`（`http://127.0.0.1:3600`）；
2. NextChat 界面 → 设置 → 打开 **「自定义接口」**，服务商选 **OpenAI**：
   - **接口地址**：`http://127.0.0.1:3600`（**不要带 `/v1`**，客户端会自行拼 `v1/chat/completions`）
   - **API Key**：网关凭证（API Key 或 `npm run token` 签出的 JWT）
3. 「自定义模型名」添加 `qwen-plus,deepseek-chat,glm-4-flash` 等；
4. 把 API Key 故意改错一位发消息 → 应报错，网关日志出现 `401 invalid_api_key`。

> 这是浏览器跨域直连，网关已内置 CORS 白名单与 `OPTIONS` 预检处理
> （`GATEWAY_CORS_ORIGINS`，默认含 `http://localhost:3000`）。
>
> 备选（同源、走 NextChat 服务端转发）：根目录 `.env` 加
> `OPENAI_API_KEY=<网关凭证>` 与 `BASE_URL=http://127.0.0.1:3600`，属 L1 配置改动，执行前确认。

## 添加新 provider

1. `gateway/.env` 加 `<NAME>_BASE_URL` 与 `<NAME>_API_KEY`；
2. `src/config.ts` 的 `providers` 数组追加一项（models / modelPrefixes 二选一或都配）；
3. 重启网关生效 —— 无需改任何转发代码。

## 自测 / 联调

不想消耗真实额度时，可用自带的 mock 上游验证第二家 provider 的转发链路（含 SSE）：

```bash
node scripts/mock-upstream.mjs                      # 终端 A：mock 上游 :3700
DEEPSEEK_BASE_URL=http://127.0.0.1:3700/v1 \
DEEPSEEK_API_KEY=mock-test-key npm run start        # 终端 B：网关把 deepseek 指向 mock
```

然后请求 `deepseek-chat` 即可验证路由 + 转发 + 流式，无需真实 key。

## 已验证行为（本地实测）

| 场景 | 结果 |
|---|---|
| `qwen-plus` 非流式 | 200，阿里真实回复，`x-gateway-provider: alibaba` |
| `qwen-plus` 流式 | 200，SSE 8 帧 + `[DONE]`，`content-type: text/event-stream` |
| `deepseek-chat` 非流式 | 200，转发到第二家上游（mock） |
| `deepseek-chat` 流式 | 200，SSE 11 帧 + `[DONE]` |
| 未配置 key 的 provider | 503 `provider_not_configured` |
| 未注册模型（如 gpt-4o） | 404 `model_not_found` |
| 网关 key 缺失/错误 | 401 `missing_credentials` / `invalid_api_key` |
| 注册/登录/会话/聊天绑定 | 见 `npm run probe`（39 项用例，全 PASS） |

自检脚本 `npm run probe` 覆盖：注册登录、会话与消息 CRUD、跨用户越权、聊天接口绑定登录用户、
JWT 过期与篡改、scope 与模型白名单、CORS 预检、模拟 NextChat 跨域请求；
结果写入 `scripts/auth-probe-result.txt`。

Postman：`postman/nextchat-gateway.postman_collection.json`（18 个请求，自带断言），
导入后按分组顺序执行即可，详见 `docs/gateway-user-auth.md`。

## 踩坑记录

- **响应头不能全量透传**：上游的 `transfer-encoding: chunked` 与 Fastify 自动追加的
  `content-length` 同时存在时，Node 侧 undici 会抛 `HPE_UNEXPECTED_CONTENT_LENGTH`。
  因此转发前需删除 `content-length / transfer-encoding / connection / content-encoding`。
- **流式用 hijack + raw pipe**：`reply.send(Readable.fromWeb())` 会丢失自定义响应头，
  改用 `reply.hijack()` + `reply.raw.writeHead()` + `.pipe(reply.raw)` 才能原样透传 SSE。
- **hijack 分支要手动补 CORS 头**：CORS 头是在 `onRequest` 里用 `reply.header()` 设的，
  而 `reply.raw.writeHead()` 不经过 Fastify 的 header 收集，需把 `req.cors` 并进 headerObj。
- **预检必须免鉴权**：浏览器的 `OPTIONS` 预检不会携带 `Authorization`，若走鉴权 hook 必然 401，
  导致 NextChat 自定义 endpoint 连不上。
- **JWT 过期判定含时钟容差**：`exp + JWT_CLOCK_SKEW_SEC`（默认 60s）之后才算过期，
  构造过期令牌做测试时 `exp` 要早于 `now - skew`，否则会被当作时钟偏差放行。

## 目录结构

```
gateway/
├── src/
│   ├── server.ts        # Fastify 实例 + CORS + 鉴权 hook + 各端点
│   ├── auth.ts          # 统一鉴权：API Key 注册表 + JWT 签发/校验 + scope/白名单
│   ├── db.ts            # SQLite 连接 + 建表迁移 + 行类型（换库只改这里）
│   ├── users.ts         # 用户存储 + scrypt 口令哈希 + 用户令牌签发
│   ├── conversations.ts # 会话/消息存储（查询强制带 user_id，归属隔离）
│   ├── config.ts        # provider 注册表 + 模型路由解析
│   └── env.ts           # 零依赖 .env 加载器
├── scripts/
│   ├── mock-upstream.mjs  # 联调自测用的极简 OpenAI 兼容上游
│   ├── issue-token.ts     # 签发 JWT 的 CLI（离线签发 / HTTP 换取）
│   └── auth-probe.ts      # 自检（39 项：鉴权 + 用户 + 会话 + 聊天绑定）
├── postman/
│   └── nextchat-gateway.postman_collection.json  # Postman 集合（18 个请求）
├── data/                  # SQLite 库文件（gitignore）
├── docs/…（项目级文档在 ../docs/gateway-auth.md 与 ../docs/gateway-user-auth.md）
├── .env / .env.example
└── package.json
```
