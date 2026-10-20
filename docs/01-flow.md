# 请求链路打通实录（2026-10-20）

> 本文记录一次真实请求从 NextChat 前端到模型厂商的完整链路验证过程，
> 包括中间发现并修复的一个真实配置问题。原始 SSE 帧见
> [demo/sse-qwen-plus-raw.txt](./demo/sse-qwen-plus-raw.txt)。

## 一、验证环境

| 组件 | 地址 | 状态 |
|---|---|---|
| NextChat 前端（next dev） | http://127.0.0.1:3000 | ✅ |
| 自建网关（Fastify） | http://127.0.0.1:3600 | ✅ providers: alibaba(ready), deepseek(no-key), zhipu(no-key) |
| 上游（阿里百炼 DashScope） | https://dashscope.aliyuncs.com/api/v1 | ✅ |

## 二、打通步骤（可复现）

### 1. 网关注册测试用户并登录

```bash
# 注册（返回 access_token）
curl -X POST http://127.0.0.1:3600/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"linktest","password":"..."}'

# 登录拿 JWT（HS256）
curl -X POST http://127.0.0.1:3600/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"linktest","password":"..."}'
```

JWT payload（网关签发，7 天有效期）：

```json
{
  "uid": 23, "username": "linktest", "role": "user",
  "sub": "user:23", "typ": "user", "iss": "nextchat-gateway",
  "scope": "chat.completions models.read conversation.read conversation.write"
}
```

### 2. 从 NextChat 入口发起完整链路请求

```bash
curl -N -X POST http://127.0.0.1:3000/api/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <JWT>" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"用一句话介绍你自己"}],"stream":true}'
```

## 三、完整链路（实测验证）

```
curl (模拟浏览器)
  → :3000 /api/openai/v1/chat/completions        [NextChat API Route]
      auth() 校验 JWT → 放行（use user api key）
      requestOpenai() 构造 fetchUrl
  → :3600 /v1/chat/completions                   [自建网关]
      校验 JWT(typ=user, scope=chat.completions)
      resolveProvider("qwen-plus") → alibaba（精确匹配 models 列表）
      替换 Authorization 为百炼真实 key
  → https://dashscope.aliyuncs.com/api/v1/chat/completions
      SSE 逐帧返回
  ← 网关原样透传（x-gateway-provider 标注来源）
  ← NextChat API Route 原样透传
  ← 19 帧 data: {...} + [DONE]
```

实测结果：HTTP 200，19 帧 SSE，拼出完整回复
“我是通义千问（Qwen），阿里巴巴集团旗下的超大规模语言模型……”。

SSE 帧结构（每帧均为 `data: {json}\n\n`）：

```
data: {"model":"qwen-plus","choices":[{"delta":{"content":"","role":"assistant"},...}]}
data: {"model":"qwen-plus","choices":[{"delta":{"content":"我是"},...}]}
data: {"model":"qwen-plus","choices":[{"delta":{"content":"通义千"},...}]}
...
data: [DONE]
```

## 三·五、逐跳详解（文件 + 函数 + 做什么）

> 完整图见 [01-flow.mmd](./01-flow.mmd)。下表每行对应图里的一条边，
> 任何一跳答不出"文件+函数+职责"，即为该处的理解盲区。

| # | 跳点 | 文件 → 函数 | 这一跳做了什么 |
|---|---|---|---|
| 1 | UI 事件 | `app/components/chat.tsx` → `doSubmit()` L1105 | 收集输入框内容与附图，调用 chatStore |
| 2 | 状态组装 | `app/store/chat.ts` → `onUserInput()` L407 | 模板填充、写入 user/bot 两条消息（bot 占位 streaming=true）、`getMessagesWithMemory()` 合并上下文、注册 `AbortController` 进 `ChatControllerPool`（支撑停止按钮） |
| 3 | 平台分发 | `app/client/api.ts` → `ClientApi` 构造器 | 按 `ModelProvider` switch，`this.llm` 实例化为 `ChatGPTApi` |
| 4 | payload 构造 | `app/client/platforms/openai.ts` → `ChatGPTApi.chat()` L186 | `extractMessages` 提取消息、构造 OpenAI 格式 payload、`getHeaders()` L168 组装 `Authorization: Bearer <JWT>`、`path()` L85 决定 URL（浏览器走相对路径 `/api/openai`，桌面端直连） |
| 5 | 发起请求 | `app/utils/chat.ts` → `streamWithThink()` L392 | 内部 `chatApi()` 经 `@fortaine/fetch-event-source` POST，SSE 帧回调进 `onmessage` |
| 6 | 统一入口 | `app/api/[provider]/[...path]/route.ts` → `handle()` | 动态路由 `/api/openai/...` 命中 `ApiPath.OpenAI`，switch 分发到 openaiHandler |
| 7 | 白名单+鉴权 | `app/api/openai.ts` → `handle()` L29 → `app/api/auth.ts` → `auth()` L66 | `ALLOWED_PATH` 校验子路径；`parseApiKey` 区分 JWT（无 nk- 前缀→用户 key 透传）；needCode 未启用→放行 |
| 8 | URL 拼装 | `app/api/common.ts` → `requestOpenai()` L9 | `baseUrl = serverConfig.baseUrl(env BASE_URL) || OPENAI_BASE_URL`；`path` 去掉 `/api/openai/` 前缀；`fetchUrl = baseUrl + path`（实测 `http://127.0.0.1:3600/v1/chat/completions`）；10 分钟超时 + `duplex:"half"` 支持流式 body |
| 9 | 网关鉴权 | `gateway/src/server.ts` → `/v1/chat/completions` handler | 校验 JWT：`typ=user`、`scope` 含 `chat.completions`（HS256，7 天有效） |
| 10 | 模型路由 | `gateway/src/config.ts` → `resolveProvider()` L112 | `qwen-plus` 精确命中 `alibaba.models` 列表（另有 modelPrefixes 前缀匹配兜底） |
| 11 | key 替换+转发 | `gateway/src/server.ts` L955 | 替换 `Authorization` 为百炼真实 key，加 `x-gateway-provider: alibaba` 头，fetch 上游 |
| 12 | SSE 回流 | 上游 → 网关 → API Route → 浏览器 | 网关原样透传；`common.ts` L178 `new Response(res.body)` 不解析内容、删 `www-authenticate`（防浏览器弹认证框）、加 `X-Accel-Buffering: no`（禁 nginx 缓冲） |
| 13 | 逐帧解析 | `app/utils/chat.ts` → `parseSSE()` L182 | 解析每帧 `delta.content` 拼正文；`reasoning_content` 进思考区；`[DONE]` 触发 `finish()`（若有 tool_calls 则二次请求循环） |
| 14 | 逐字渲染 | `app/utils/chat.ts` → `animateResponseText()` L198 | `requestAnimationFrame` 每帧消费 ~60 字符——**渲染节奏与网络帧解耦**，网络快慢不影响打字机效果 |

### 浏览器端与 curl 模拟的差异（重要）

- **浏览器登录后**：`accessStore.useCustomConfig=true` 且 `openaiUrl=127.0.0.1:3600`，
  `platforms/openai.ts` 的 `path()` 判断后**直连网关**，跳过第 6-8 跳（API Route）；
- **curl 打 :3000**（本文方式）：走完整 6-8 跳，验证的是 API Route 全链路；
- 两条路径在第 9 跳（网关）汇合，其后完全一致。

### 自测代码说明（app/api/common.ts 临时日志）

```ts
const traceBody =
  typeof fetchOptions.body === "string"
    ? fetchOptions.body        // customModels 过滤段已读为字符串
    : await req.text();        // 否则读一次原始流
if (traceBody) fetchOptions.body = traceBody;  // 必须回填，否则 body 流已被消耗
console.log("[LINK-TRACE] body >>>", traceBody);
console.log("[LINK-TRACE] url  >>>", fetchUrl, "method:", req.method);
```

**第一版踩坑记录**（保留为面试素材）：最初写成 `await req.clone().text()`，
返回 `TypeError: Response body object should not be disturbed or locked`。
根因：`fetchOptions.body = req.body` 在函数前段已捕获原始流的引用，
后调 `clone()` 会 tee 并锁定该流，fetch 再读旧引用即报错。
**教训：流式请求体是一次性的，引用被提前捕获后不可 clone；正确做法是读一次成字符串再回填**——与上游 customModels 过滤段（L112-144）的处理模式一致。

## 四、发现并修复的问题（真实踩坑）

### 症状

首次从 :3000 发请求，返回：

```json
{"cause":{"name":"ConnectTimeoutError","code":"UND_ERR_CONNECT_TIMEOUT","message":"Connect Timeout Error"}}
```

### 排查过程

1. 网关直连测试（:3600 → 百炼）**正常** → 网关与上游无问题；
2. 查看 NextChat 服务端日志，发现真实转发地址：

   ```
   [Proxy]  v1/chat/completions
   [Base Url] https://api.openai.com
   fetchUrl https://api.openai.com/v1/chat/completions
   ```

   请求根本没进网关，直接发往了 OpenAI 官方（本机无法直连，超时）。

### 根因

主应用 `.env` 未配置 `BASE_URL`，`app/api/common.ts` 的 `requestOpenai()` 中：

```ts
let baseUrl = (isAzure ? serverConfig.azureUrl : serverConfig.baseUrl) || OPENAI_BASE_URL;
```

`serverConfig.baseUrl` 为空 → 回退默认值 `https://api.openai.com`。

### 修复

`.env` 追加两行（OpenAI 通道指向自建网关）：

```env
BASE_URL=http://127.0.0.1:3600
OPENAI_API_KEY=sk-gateway
```

next dev 热更新后重试，日志变为：

```
[Base Url] http://127.0.0.1:3600
fetchUrl http://127.0.0.1:3600/v1/chat/completions
```

链路全通。

### 教训

- **配置默认值的兜底不等于正确**：`OPENAI_BASE_URL` 兜底值在"接入自建网关"的部署形态下是错的；
- 排查网络超时的顺序：先确认**实际请求地址**（日志里找 fetchUrl），再怀疑网络/代理。

## 五、浏览器端路径说明（与 curl 验证的差异）

curl 直打 :3000 的 API Route 验证的是服务端链路。真实浏览器端还多一层决策
（`app/client/platforms/openai.ts` → `path()`）：

- 登录后 `accessStore.useCustomConfig=true` 且 `openaiUrl=http://127.0.0.1:3600`
  → 浏览器**直连网关**（跳过 NextChat API Route）；
- 未登录/未自定义 → 走 `/api/openai`（即本文 curl 模拟的路径）。

两条路径最终都汇入网关的 `/v1/chat/completions`，鉴权与路由逻辑一致。

## 六、复现检查清单

- [x] 网关 /health 200
- [x] 注册 + 登录返回 JWT（typ=user）
- [x] 网关直连 /v1/chat/completions（qwen-plus）SSE 正常
- [x] :3000 完整链路 SSE 正常（19 帧）
- [x] 服务端日志 fetchUrl 指向网关
- [x] JWT payload 解码验证（scope 含 chat.completions）
- [x] SSE 原始帧存档 docs/demo/sse-qwen-plus-raw.txt
