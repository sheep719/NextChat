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
