# 网关统一鉴权（API Key / JWT）与 NextChat 自定义 endpoint 接入

> 对应变更台账 **C-004**。本文是网关鉴权的唯一说明文档，改动前先读、改动后同步。

## 一、目标与结论

| 目标 | 实现 | 状态 |
|---|---|---|
| 统一鉴权入口 | 所有受保护端点只经 `src/auth.ts` 的 `authenticate()` 一处 | 已完成 |
| 支持 API Key | 多 Key 注册表，可带 clientId；`Authorization: Bearer` 或 `X-Api-Key` | 已完成 |
| 支持 JWT | HS256 签发/校验（node:crypto，零依赖），带 exp / scope / 模型白名单 | 已完成 |
| 未授权请求被拒绝 | 无凭证/错 key/失效 JWT → 401；越权 → 403；**未配任何凭证时网关拒绝启动**（fail-closed） | 已验证 |
| 成为 NextChat 自定义 endpoint | OpenAI 兼容端点 + CORS 白名单 + 预检处理 | 已验证 |

自检结果：**22 项用例全部 PASS**（`npm run probe`）。

## 二、请求链路中的鉴权位置

```
NextChat 浏览器端
  │  设置 → 自定义接口 → 接口地址 http://127.0.0.1:3600
  │  （客户端拼路径：[baseUrl, "v1/chat/completions"].join("/")）
  ▼
POST http://127.0.0.1:3600/v1/chat/completions
  │  Authorization: Bearer <网关 API Key 或 JWT>
  ▼
┌──────────── gateway (Fastify :3600) ────────────┐
│ ① onRequest：按 Origin 白名单写 CORS 头          │
│ ② OPTIONS 预检：204（免鉴权，浏览器不带凭证）      │
│ ③ preHandler：authenticate() 统一鉴权 ── 失败即 401/403
│ ④ assertScope("chat.completions")               │
│ ⑤ resolveProvider(model) → 路由                 │
│ ⑥ assertModelAllowed() → 模型/provider 白名单     │
│ ⑦ 换成上游真实 key，转发；SSE 原样透传            │
└──────────────────────────────────────────────────┘
          ▼              ▼              ▼
       Alibaba        DeepSeek        Zhipu
```

关键点：

- **网关凭证与上游 key 完全隔离**：客户端只持有网关凭证，上游 key 只在第 ⑦ 步服务端替换，
  浏览器永远拿不到 `ALIBABA_API_KEY` 等真实密钥。
- **浏览器直连必须开 CORS**：与走 NextChat 自身 `/api/openai/*`（同源、服务端转发）不同，
  自定义 endpoint 是浏览器跨域直连，带 `Authorization` 会触发预检，因此网关必须显式处理
  `OPTIONS` 并返回 `Access-Control-Allow-Origin`。

## 三、凭证模型

| | API Key | JWT |
|---|---|---|
| 形态 | 静态长密钥 | `Header.Payload.Signature`（HS256） |
| 携带方式 | `Authorization: Bearer <key>` 或 `X-Api-Key: <key>` | `Authorization: Bearer <jwt>` |
| 有效期 | 长期，手动轮换 | 带 `exp`，默认 1h，上限 12h |
| 细粒度 | 无（默认全放行） | 支持 scope / models / providers 限制 |
| 适用 | 服务端、本机 CLI | 下发给浏览器端、临时授权、按模型限权 |
| 轮换 | 改 `.env` 重启 | 等 `exp` 自然失效，或更换 `JWT_SECRET` |

`AUTH_MODE=both`（默认）时两种都接受：形如 JWT 的串走 JWT 校验，其余按 API Key 比对；
**JWT 校验失败不会回退按 API Key 处理**，避免两种凭证混淆。

### JWT claims

| claim | 含义 |
|---|---|
| `sub` | 客户端标识（clientId），写入 `x-gateway-client` 响应头 |
| `exp` / `nbf` / `iat` | 有效期，允许 `JWT_CLOCK_SKEW_SEC`（默认 60s）时钟偏差 |
| `iss` / `aud` | 配置了 `JWT_ISSUER` / `JWT_AUDIENCE` 时强制校验 |
| `scope` | 空格分隔；`*` 或 `admin` 表示全放行 |
| `models` | 模型白名单，支持 `qwen-*` 前缀通配 |
| `providers` | provider 白名单（alibaba / deepseek / zhipu …） |

### scope 取值

| scope | 保护对象 |
|---|---|
| `chat.completions` | `POST /v1/chat/completions` |
| `models.read` | `GET /v1/models` |
| `admin` / `*` | 全部 |

令牌**未声明 scope 时放行全部**（兼容自签简单令牌）；一旦声明，则必须命中才放行。

## 四、配置项（`gateway/.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_MODE` | `both` | `apikey` / `jwt` / `both` |
| `GATEWAY_API_KEYS` | — | 逗号分隔，格式 `<key>` 或 `<key>:<clientId>` |
| `GATEWAY_API_KEY` | — | 旧单 Key 变量，仍兼容（与上式合并去重） |
| `JWT_SECRET` | — | HS256 密钥；留空则关闭 JWT 能力 |
| `JWT_ALGS` | `HS256` | 允许的 alg（HS256/384/512） |
| `JWT_ISSUER` / `JWT_AUDIENCE` | 空 | 非空则强制校验 iss/aud |
| `JWT_DEFAULT_TTL_SEC` | `3600` | 默认有效期 |
| `JWT_MAX_TTL_SEC` | `43200` | 签发上限，防永久令牌 |
| `JWT_CLOCK_SKEW_SEC` | `60` | 时钟偏差容差 |
| `ALLOW_ANONYMOUS` | `false` | **true 才允许匿名**；默认未授权即拒绝 |
| `GATEWAY_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | 跨域白名单，`*` 为任意（仅调试） |

**fail-closed**：启动时若既无 API Key 也无 `JWT_SECRET`，且未显式 `ALLOW_ANONYMOUS=true`，
网关打印指引后直接退出，不会出现"没配 key 就全放行"的裸奔状态。

## 五、令牌签发

### 1）用 API Key 换 JWT（经网关，可验证签发链路）

```bash
curl -X POST http://127.0.0.1:3600/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-gateway-local-2026","clientId":"nextchat-web","ttlSec":3600,
       "scope":"chat.completions models.read","models":["qwen-*"]}'
```

响应：`{ access_token, token_type, expires_in, expires_at, client_id, ... }`

> 该端点**只接受 API Key**，用 JWT 换令牌会返回 401 —— 否则令牌可无限自我续签。

### 2）离线签发（CLI，不需要网关在跑）

```bash
npm run token -- --client nextchat-web --ttl 3600 \
  --scope "chat.completions models.read" --models "qwen-*" --providers alibaba
npm run token -- --exchange --key sk-gateway-local-2026 --client nextchat-web   # 走 HTTP 换取
```

### 3）查看当前身份

```bash
curl http://127.0.0.1:3600/v1/auth/whoami -H "Authorization: Bearer <key 或 jwt>"
```

## 六、拒绝矩阵（未授权请求如何被拒）

| 场景 | HTTP | error.code | 说明 |
|---|---|---|---|
| 无凭证 | 401 | `missing_credentials` | 返回 `WWW-Authenticate: Bearer realm="nextchat-gateway"` |
| 错误/未知 API Key | 401 | `invalid_api_key` | 定长比较，无时序侧信道 |
| JWT 签名被篡改 | 401 | `invalid_token` | HMAC 校验失败 |
| JWT 已过期 | 401 | `token_expired` | 超出 `exp + skew` |
| JWT alg 不受支持 | 401 | `invalid_token` | 防 alg 混淆 |
| iss / aud 不匹配 | 401 | `invalid_token` | 配置了才校验 |
| scope 不足 | 403 | `insufficient_scope` | 如 `models.read` 调 chat |
| 模型不在白名单 | 403 | `model_not_allowed` | JWT 的 `models` 限制 |
| provider 不在白名单 | 403 | `provider_not_allowed` | JWT 的 `providers` 限制 |
| 用 JWT 换令牌 | 401 | `invalid_api_key` | 禁止自我续签 |
| 未注册模型 | 404 | `model_not_found` | 已通过鉴权，路由层拒绝 |
| provider 未配 key | 503 | `provider_not_configured` | 已通过鉴权，上游未配置 |
| 来源不在 CORS 白名单 | 403 | — | 预检被拒，浏览器直接拦截 |

`GET /healthz` 免鉴权（只暴露 provider 就绪状态，不含密钥）。

## 七、接入 NextChat（自定义 endpoint）

1. 启动网关：`cd gateway && npm run start`（默认 `http://127.0.0.1:3600`）。
2. 准备凭证：直接用 `.env` 里的 `GATEWAY_API_KEYS` 任一条，或签一个 JWT：
   ```bash
   npm run token -- --client nextchat-web --ttl 3600 --scope "chat.completions" --models "qwen-*"
   ```
3. NextChat 界面 → 左下角「设置」：
   - 打开 **「自定义接口」**（`useCustomConfig`）；
   - 服务商选 **OpenAI**；
   - **接口地址** 填 `http://127.0.0.1:3600`
     （**不要带 `/v1`** —— NextChat 客户端会自行拼接 `v1/chat/completions`）；
   - **API Key** 填网关凭证（API Key 或上面签出的 JWT 均可）。
4. 「自定义模型名」里加上要用的模型：`qwen-plus,deepseek-chat,glm-4-flash`（逗号分隔）。
5. 验证：
   - 正常：选 `qwen-plus` 发消息 → 正常流式回复；
   - **未授权：把 API Key 改错一位 → 发消息报错，网关日志出现 `[auth] reject ... 401 invalid_api_key`**
     （浏览器可见 401，因为响应带 CORS 头）。

> 网关侧需保证 `GATEWAY_CORS_ORIGINS` 包含 NextChat 的来源（默认已含 `http://localhost:3000`）。
> 若 NextChat 跑在其他端口/域名，追加到白名单后重启网关。

### 备选：服务端代理（不经浏览器跨域）

在 NextChat 根目录 `.env` 追加，让 NextChat 自身的 `/api/openai/*` 转发到网关：

```
OPENAI_API_KEY=<网关凭证>
BASE_URL=http://127.0.0.1:3600
```

此方式同源、无跨域问题，但仍需网关凭证，鉴权规则完全一致。**属 L1 配置层改动，执行前需确认。**

## 八、验证记录（2026-10-07，`npm run probe`）

| 用例 | 结果 |
|---|---|
| `/healthz` 免鉴权 | 200，`authMode=both` |
| 无凭证 / 错误 Key / 无凭证访问 `/v1/models` | 401 |
| 合法 Key 非流式（qwen-plus，阿里真实转发） | 200，`x-gateway-provider: alibaba` |
| 合法 Key 流式 | 200，SSE 4 帧 |
| API Key → `/v1/auth/token` 签发 JWT | 200，`expires_in=600` |
| JWT 流式 | 200，`x-gateway-client: probe-jwt` |
| 篡改签名 / 过期 JWT | 401 `invalid_token` / `token_expired` |
| `scope=models.read` 调 chat / 调 `/v1/models` | 403 / 200 |
| `models=[deepseek-chat]` 调 qwen-plus / 调 deepseek-chat | 403 `model_not_allowed` / 200（mock 上游） |
| 用 JWT 换令牌 / 错 key 换令牌 | 401 |
| `whoami` | 200，身份正确 |
| CORS 预检：白名单来源 / 非白名单来源 | 204 / 403 |
| 模拟 NextChat 跨域 + 错 key / + 正确 key 流式 | 401（带 CORS 头）/ 200 SSE |
| 未注册模型 | 404 `model_not_found` |
| 未配任何凭证启动 | 启动中止（fail-closed） |

## 九、安全注意事项

- `JWT_SECRET` 与 `GATEWAY_API_KEYS` 只存在于 `gateway/.env`（已被 `.gitignore` 忽略），
  不得提交、不得下发给浏览器。
- 对外暴露时：`ALLOW_ANONYMOUS` 保持 `false`；`GATEWAY_CORS_ORIGINS` 不要填 `*`；
  JWT TTL 尽量短（浏览器端建议 ≤1h）。
- 轮换 `JWT_SECRET` 会让所有已签发令牌立即失效（无需等待 exp）。
- 日志对 `authorization` / `x-api-key` 做了 redact，不会打印完整凭证。
