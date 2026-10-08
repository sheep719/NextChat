# 前端登录页 + 会话云端同步（C-008）

> 目标：**换浏览器能看到历史对话**。
> 本文记录方案选型、落地结构、时序、以及踩过的 5 个坑（对应 `troubleshooting.md` 的 P-026 ~ P-030）。

---

## 一、需求与选型

| 决策点 | 选择 | 理由 |
|---|---|---|
| 登录入口 | 独立 `/login` 路由 | `home.tsx` 内部是 `HashRouter`，子页面无法做"未登录就拦"的路由级守卫；独立路由可以用真实 URL 跳转 |
| 是否强制登录 | 强制 | 未登录直接 `window.location.href = "/login"`，否则云端同步无从归属 |
| 同步粒度 | **整包不透明显JSON 快照** | `ChatSession` 字段会演进（mask / memoryPrompt / stat / tools …），逐字段映射进关系表必丢字段；整包换取"换设备看到的和原来一模一样" |
| 首次登录合并策略 | 自动合并（按 `lastUpdate` 取新） | 用户无感知迁移，本地独有的会话会自动回推上线 |

### 为什么不是"逐条 upsert"

`ChatSession` 是一个会随时加字段的大对象（`app/store/chat.ts`）。如果按字段建表：
- 每次上游新增字段都要改表结构 → 二开维护成本高
- 漏一个字段就是"换设备后面具丢了/上下文丢了"这类玄学 bug

整包快照的代价是**无法做细粒度并发合并**，但真实场景是"同一人换设备"，冲突极少，
用乐观锁 + 整包合并足够。

---

## 二、落地结构

```
gateway/src/db.ts            + cloud_state 表（user_id + state_key 联合主键）
gateway/src/cloud-state.ts   + 快照读写（乐观锁、8MB 上限、单调递增时间戳）
gateway/src/server.ts        + 4 个同步端点 + CORS 允许 PUT/DELETE
app/store/auth.ts            + 登录态 store（token / user / gatewayUrl / lastSyncTime）
app/utils/gateway-sync.ts    + ChatSyncer：pull / 去抖 push / 合并 / 冲突重试
app/components/login.tsx     + 登录注册页
app/login/page.tsx           + /login 路由
app/components/home.tsx      + 登录守卫 + useCloudSync
app/components/settings.tsx  + 账号区（当前用户 / 上次同步 / 立即同步 / 登出）
app/locales/{cn,en}.ts       + GatewayAuth 文案块
```

### 数据表

```sql
CREATE TABLE IF NOT EXISTS cloud_state (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_key  TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, state_key)
);
```

一个用户可以有多份快照（`state_key` 默认 `"chat"`，将来可放 `mask`、`plugin` 等）。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sync/state?key=chat` | 拉快照；无则返回空 |
| PUT | `/api/sync/state` | 写快照，body 带 `baseUpdatedAt` 做乐观锁；冲突返回 409 + 服务端最新 |
| DELETE | `/api/sync/state?key=chat` | 删除快照 |
| GET | `/api/sync/state/keys` | 列出该用户所有 `state_key` |

全部走 `requireUser()`，匿名 401。

---

## 三、同步时序

```
应用启动
  └─ home.tsx: authReady && loggedIn ?
       ├─ 否 → /login
       └─ 是 → useCloudSync(true)
                ├─ waitForChatHydration()   ← 必须，见 P-028
                ├─ pull()
                │    ├─ 云端空 → push(true)（首次登录迁移本地数据）
                │    └─ 云端有 → mergeSessions(local, remote) → 写回 store → push(true)
                └─ useChatStore.subscribe(() => schedulePush())   ← 去抖 3s
```

### 合并规则

`mergeSessions(local, remote)`：以 `id` 为键，`lastUpdate` 大的胜出，结果按 `lastUpdate` 倒序。

### 冲突处理

PUT 带 `baseUpdatedAt`（上次拉/推时记下的服务端 `updatedAt`）。
服务端发现 `updated_at > baseUpdatedAt` → 409 + 返回服务端最新 payload；
客户端合并后**只重试一次**（`MAX_PUSH_RETRY = 1`），避免死循环。

### 选中会话

合并后不能简单保持 `currentSessionIndex`：新设备刚创建的空会话 `lastUpdate` 往往
比历史会话更新，会排在第 0 位，用户看到空白页面会以为"没同步过来"（P-030）。
规则：
1. 尽量停在原来那条（按 id 找回）
2. 登录后的首次恢复，若当前是空会话且存在有内容的会话 → 切到最近一条有内容的

---

## 四、登录如何接到"聊天"

`login()` 成功后把 JWT 直接写进 `useAccessStore`：

```ts
a.useCustomConfig = true;
a.provider = ServiceProvider.OpenAI;
a.openaiUrl = normalizeBase(gatewayUrl);   // 注意不能带 /v1，见 C-004
a.openaiApiKey = token;                    // JWT 当 API Key 用
```

这样 `ChatGPTApi.path()` 拼出的就是 `{gateway}/v1/chat/completions`，
聊天请求天然带上用户身份，网关侧即可把对话归属到该用户。

---

## 五、验证

### 接口层（`sync-probe.mjs`，13/13 PASS）

注册 → 匿名 401 → 空快照 → PUT → GET → 用户隔离 → 重新登录数据一致 →
正确 base 写入 → 冲突 409 → 非法 key 400 → keys 列表 → DELETE。

### 端到端（`e2e-sync.mjs`，6/6 PASS）

用 CDP 开两个**互相隔离的 BrowserContext** 模拟两台设备：

```
A1 未登录访问主页          → 跳转 /login
A2 注册账号               → 进入主页
A3 发一条消息（走网关）     → 本设备可见
A4 云端快照               → 已包含该会话
B1 全新设备访问主页        → 要求登录
B2 同一账号登录           → 看到 A 发的历史消息
```

两个脚本都在仓库外（`D:\github_projects\`），不污染 fork 的工作区。

---

## 六、已知限制 / 后续

- **不是实时同步**：去抖 3s，且只在页面打开时推；多标签页同时打开会互相覆盖（有乐观锁，会 409 合并）
- **整包体积**：单快照上限 8MB，会话极多时需要分片或改增量
- **模型路由未配全**：E2E 里助手回复报 `Unknown model "gpt-4o-mini"`，
  需要在 `gateway/src/config.ts` 补 provider 映射（属于 C-003 的收尾，不影响同步链路）
- **登出即失联**：`logout()` 会 `chatSyncer.reset()`，本地数据保留但不再同步；
  换账号登录时会用新账号的快照覆盖合并
