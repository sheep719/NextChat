# 原版 NextChat 架构：请求链路精读（改动前）

> 用途：满足验收标准 AC-ENV-03 / AC-DOC-03 的 before 文档。
> 本文按「UI 组件 → store → client/api.ts → 模型厂商接口」的顺序，以**有序列表**形式
> 标注每一跳的**具体文件与函数**。深度精读版（含时序图/分层图/完整代码引用）见
> `docs/request-flow.md`，两者内容同源。

## 请求链路（有序列表）

以「用户在阿里通义（Qwen）通道发送一条消息」为例，浏览器端到模型厂商的完整链路：

1. **UI 入口** — `app/components/chat.tsx`
   输入框回车/点击发送 → 调用 `chatStore.onUserInput(userInput, attachImages)`。

2. **状态层（zustand store）** — `app/store/chat.ts` → `onUserInput()`（L407）
   - `fillTemplateWith()` 按 mask 模板填充输入；
   - 先写入 `userMessage` 与占位 `botMessage`（`streaming: true`），UI 立即出气泡；
   - `getMessagesWithMemory()` 合并 mask 上下文、历史裁剪、记忆压缩、MCP system prompt；
   - `getClientApi(modelConfig.providerName)`（L459）拿到平台 `ClientApi`，调 `api.llm.chat({...})`；
   - `onController` 把 `AbortController` 注册进 `ChatControllerPool`（`app/client/controller.ts`）。

3. **平台分发** — `app/client/api.ts` → `ClientApi` 构造函数 / `getHeaders()`
   - 按 `ModelProvider` switch 把 `this.llm` 实例化为 `QwenApi` / `ChatGPTApi` / `ClaudeApi` 等 15+ 平台类；
   - `getHeaders()` 从 `useAccessStore` 取 key 组装 `Authorization`，无 key 时降级为访问码 `ek-` 前缀。

4. **平台实现（以 Qwen 为例）** — `app/client/platforms/alibaba.ts` → `QwenApi.chat()`
   - 合并三层 modelConfig（全局 ← mask ← 本次请求）；
   - 构造 **DashScope 原生** payload（`input.messages` + `parameters`，非 OpenAI 格式）；
   - URL 由 `this.path()` 决定：浏览器端走相对路径 `/api/alibaba`（同源 API Route），
     Tauri 桌面端直连 `https://dashscope.aliyuncs.com/api/`；
   - 真实 path 由 `Alibaba.ChatPath(model)`（`app/constant.ts`）按模型类型选择；
   - 附加头 `X-DashScope-SSE: enable`。

5. **流式工具层** — `app/utils/chat.ts` → `streamWithThink()`（L392）
   - `animateResponseText()` 用 `requestAnimationFrame` 做打字机渲染（网络帧与渲染解耦）；
   - 内部经 `@fortaine/fetch-event-source` 的 `fetchEventSource()` 发起 POST；
   - `onmessage` → `parseSSE()` 逐帧解析，`tool_calls` 累积后可能触发**工具调用循环二次请求**。

6. **API Route 层（服务端，edge runtime）** — `app/api/[provider]/[...path]/route.ts`
   动态路由 `/api/<provider>/<path...>` 统一入口，GET/POST 导出同一 `handle`，
   按 provider switch 分发到各 `app/api/<provider>.ts`，未匹配走 `app/api/proxy.ts` 兜底。

7. **阿里转发实现** — `app/api/alibaba.ts` → `handle()` / `request()`
   - `auth(req, ModelProvider.Qwen)` 鉴权；
   - `baseUrl` 取 `serverConfig.alibabaUrl`（`.env` 的 `ALIBABA_URL`）或默认 DashScope；
   - 服务端 `fetch` 透传（10 分钟超时、`X-Accel-Buffering: no` 禁 nginx 缓冲），
     `new Response(res.body)` 把上游 SSE 流原样透传回浏览器。

8. **鉴权与 key 注入** — `app/api/auth.ts` → `auth()`
   - `Bearer ek-xxx` 是访问码（md5 比对 `.env` 的 `CODE`）；`Bearer sk-xxx` 是用户自带 key；
   - **关键注入**：用户未自带 key 时按 provider 注入系统级 key（Qwen → `ALIBABA_API_KEY`），
     改写 `Authorization` 后再转发——本地部署时浏览器无需填 key。

9. **服务端配置** — `app/config/server.ts` → `getServerSideConfig()`
   读取 `.env`，决定哪些 provider 可用（如 `ALIBABA_API_KEY` 存在 → `isAlibaba = true`），
   经 `/api/config` 下发给前端。

10. **模型厂商接口** — DashScope
    `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation`，
    SSE 流式返回，每帧 `data:` 后是 JSON（`output.choices[].message.content` 为增量正文）。

## 本文引用的源码路径（供 AC-ENV-03 抽查）

| # | 路径 | 关键函数 |
|---|---|---|
| 1 | `app/components/chat.tsx` | 输入框 → `onUserInput` 调用点 |
| 2 | `app/store/chat.ts` | `onUserInput()` L407、`getMessagesWithMemory()` |
| 3 | `app/client/api.ts` | `ClientApi` 构造、`getHeaders()` |
| 4 | `app/client/platforms/alibaba.ts` | `QwenApi.chat()` |
| 5 | `app/client/controller.ts` | `ChatControllerPool` |
| 6 | `app/utils/chat.ts` | `streamWithThink()` L392、`animateResponseText()` |
| 7 | `app/api/[provider]/[...path]/route.ts` | `handle`（动态路由统一入口） |
| 8 | `app/api/alibaba.ts` | `handle()` / `request()` |
| 9 | `app/api/auth.ts` | `auth()` |
| 10 | `app/config/server.ts` | `getServerSideConfig()` |
| 11 | `app/constant.ts` | `Alibaba.ChatPath()` |

> 共 11 个真实路径，超过 AC-ENV-03 要求的 5 个；每条链路跳点均可按上表定位到函数级。
