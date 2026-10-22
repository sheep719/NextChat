# NextChat 代码地图（目录 → 职责 → 是否二次开发改动）

> 阅读顺序建议：先通读本表建立全局认知，再按
> [request-flow.md](./request-flow.md)（请求链路精读）与
> [architecture-before.md](./architecture-before.md) / [architecture-after.md](./architecture-after.md)
> （改动前后架构对比）深入。全部路径相对仓库根目录。

## 一、目录总览

| 目录 | 职责 | 是否改动 | 说明 |
|---|---|---|---|
| `app/` | 前端主体（Next.js App Router） | ✅ 改动 | 见下方明细 |
| `gateway/` | 🆕 自建模型网关（Fastify + SQLite，独立进程 :3600） | 🆕 全新 | 二次开发核心产出，见第四节 |
| `docs/` | 项目文档 | 🆕 新增若干 | 深读笔记 + 交付文档 |
| `public/` | 静态资源 | ❌ | — |
| `docker/` | Docker 构建产物 | ❌ | — |
| `scripts/` | 上游构建/工具脚本 | ❌ | — |
| `src-tauri/` | Tauri 桌面端 Rust 壳 | ❌ | — |
| `test/` | 上游测试 | ❌ | — |

## 二、`app/` 内部明细

| 路径 | 职责 | 是否改动 | 改动内容 |
|---|---|---|---|
| `app/constant.ts` | 全局常量中心：厂商地址、路由枚举、存储键、模型清单 | ✅ | 新增 `Path.Usage`、`StoreKey.Auth`、`GATEWAY_URL` 及网关相关常量 |
| `app/config/` | 配置层：`server.ts` 服务端环境变量，`build.ts` 构建期 | ❌ | — |
| `app/store/access.ts` | 访问控制与厂商配置 store（前端） | ❌ | — |
| `app/store/chat.ts` | 会话状态中心（zustand persist） | ❌ | 上游核心，保持不动 |
| `app/store/auth.ts` | 🆕 网关登录态 store：JWT 管理、登录/登出 | 🆕 新增 | 登录成功将 JWT 写入 accessStore，聊天请求自动携带身份 |
| `app/client/` | 平台适配层：`api.ts` 工厂按 ModelProvider 分发，`platforms/*.ts` 15+ 厂商实现 | ❌ | 上游核心，保持不动 |
| `app/api/` | 服务端代理路由（`[provider]/[...path]` 动态路由）与 `auth.ts` 鉴权 | ❌ | — |
| `app/components/chat.tsx` | 聊天主界面（输入框 → onUserInput） | ❌ | — |
| `app/components/login.tsx` + `app/login/` | 🆕 登录/注册页（独立路由 /login） | 🆕 新增 | 与网关 /api/auth/* 对接 |
| `app/components/usage.tsx` + `app/stats/` | 🆕 用量统计面板（Recharts 按天聚合） | 🆕 新增 | 数据来自网关 /api/usage/daily |
| `app/components/home.tsx` | 首页 | ✅ | 增加登录守卫：未登录跳 /login |
| `app/components/sidebar.tsx` | 侧边栏 | ✅ | 增加用量面板入口 |
| `app/components/settings.tsx` | 设置页 | ✅ | 增加网关配置区 |
| `app/utils/gateway-sync.ts` | 🆕 会话云端同步（ChatSyncer：快照上云、按 lastUpdate 合并、去抖上传、409 重试） | 🆕 新增 | — |
| `app/utils/chat.ts` | 流式处理（streamWithThink / parseSSE / 工具调用循环） | ❌ | 上游核心，保持不动 |
| `app/locales/cn.ts` / `en.ts` | i18n 文案 | ✅ | 新增登录/统计相关文案 |
| `app/masks/` / `app/mcp/` / `app/masks` 相关 | 面具与 MCP 功能 | ❌ | — |

## 三、聊天链路速查（未改动部分，一图流）

```
用户输入
  → app/components/chat.tsx          (UI 事件)
  → app/store/chat.ts onUserInput()  (组装消息 + 上下文)
  → app/client/api.ts                (按 ModelProvider 实例化平台类)
  → app/client/platforms/*.ts        (构造各厂商原生 payload)
  → app/utils/chat.ts streamWithThink()  (SSE 流式 + 工具调用循环)
  → POST /api/<provider>/...         (app/api/ 动态路由, edge)
  → app/api/auth.ts auth()           (访问码校验 / 注入系统 key)
  → 厂商 API (SSE 流式回传, 服务端不解析)
```

> 深读见 [request-flow.md](./request-flow.md)。

## 四、`gateway/` 明细（二次开发核心）

| 路径 | 职责 | 说明 |
|---|---|---|
| `gateway/src/server.ts` | 服务入口：`/v1/chat/completions` OpenAI 兼容入口，按 model 路由到上游 3 家 provider（精确 + 前缀匹配），SSE 透传 | 主链路 |
| `gateway/src/auth.ts` | 鉴权：API Key + JWT(HS256) 双模式；聊天接口只认 `typ=user` 登录令牌 | — |
| `gateway/src/users.ts` | 用户体系：注册/登录，scrypt 口令哈希 | — |
| `gateway/src/db.ts` | SQLite：users / conversations / messages / cloud_state / usage_records 五张表 | schema 见 [schema.md](./schema.md) |
| `gateway/src/usage.ts` | 用量统计：非流式解析 usage，流式注入 `stream_options.include_usage`，缺省按内容估算（estimated=1） | — |
| `gateway/src/cloud-state.ts` | 会话云同步端点：整包快照 + 乐观锁 | — |
| `gateway/src/conversations.ts` | 会话数据访问层 | — |
| `gateway/src/config.ts` | 网关配置：provider 路由表、密钥管理 | — |
| `gateway/src/env.ts` | 环境变量读取与校验 | — |
| `gateway/scripts/` | 辅助脚本：mock-upstream、auth-probe、issue-token | — |
| `gateway/postman/` | Postman 集合（接口调试） | — |

## 五、改动一览（5 个 feature commit）

| Commit | 内容 |
|---|---|
| `9d8a22e7` | 网关主体：多模型路由 + 统一鉴权 + 用户体系 + 云端同步端点 |
| `3890071d` | 前端接入：登录页、登录态 store、会话云同步、设置页网关配置 |
| `3a35bef7` | 用量统计：网关记录每次调用 token |
| `7fb785f3` | 前端用量面板（Recharts 按天展示） |
| `a1a3994f` | /stats 标准路由跳转用量面板 |

> 改动约束遵守 [secondary-dev-rules.md](./secondary-dev-rules.md)：不改上游核心文件（`store/chat.ts`、`client/api.ts` 等上游主链路全部保持原样），新功能以新增文件为主，侵入性修改仅限 `constant.ts`（加枚举）、`home.tsx`（登录守卫）等少量接缝点。
