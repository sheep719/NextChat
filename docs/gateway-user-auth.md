# 用户体系：表设计 + 注册/登录接口（改动 2）

> 对应变更台账 **C-005**。鉴权基础（API Key / JWT）见 `docs/gateway-auth.md`，本文只讲"用户"这一层。

## 一、目标与结论

| 目标 | 实现 | 状态 |
|---|---|---|
| 选定数据库 | SQLite（better-sqlite3），库文件 `gateway/data/gateway.db` | 已完成 |
| 用户表 + 对话表 | `users` / `conversations` / `messages` 三表，外键级联 | 已完成 |
| 注册 / 登录接口 | `POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me` | 已完成 |
| 会话读写接口 | 创建/列表/详情/加消息/删除，归属隔离 | 已完成 |
| 聊天接口绑定登录用户 | `CHAT_REQUIRE_USER=true` 时只认 `typ=user` 的用户令牌 | 已完成 |
| Postman 调通 | `gateway/postman/*.postman_collection.json`，18 个请求，开箱即用 | 已验证 |

自检：**39 项用例全部 PASS**（`npm run probe`），Postman 等价冒烟 7 步全通。

## 二、为什么 SQLite 起步

- 零运维：单文件、无需起服务，本地开发与联调最快；
- better-sqlite3 是同步 API，代码里没有 async 传染，事务与预编译语句直接可用；
- 数据层收敛在 `gateway/src/db.ts` 一个文件（建表 + 连接 + 行类型），
  **换 Postgres/MySQL 时只替换这个文件**，上层 `users.ts` / `conversations.ts` 不用动。

已开启的 PRAGMA：`journal_mode = WAL`（读写并发）、`foreign_keys = ON`（级联生效）。

## 三、表结构

```
users ──1:N── conversations ──1:N── messages
  id                id (FK user_id)      id (FK conversation_id)
  username          uuid                 seq         ← 会话内自增序号
  email             title                role        ← system/user/assistant/tool
  password_hash     model                content
  role              provider             model
  status            archived             prompt_tokens / completion_tokens
  created_at        created_at           created_at
  updated_at        updated_at
```

```sql
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT             UNIQUE,
  password_hash TEXT    NOT NULL,          -- scrypt$<saltHex>$<hashHex>
  role          TEXT    NOT NULL DEFAULT 'user',
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,          -- epoch 毫秒
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       TEXT    NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL DEFAULT '',
  model      TEXT    NOT NULL DEFAULT '',
  provider   TEXT    NOT NULL DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  model           TEXT    NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
```

设计要点：

- **时间统一 epoch 毫秒**（INTEGER），不存字符串，避免时区/格式问题；
- **级联删除**：删用户 → 其会话与消息一并删除（已开 `foreign_keys`）；
- **归属隔离下沉到数据层**：`conversations` 的查询全部带 `user_id` 条件
  （`getOwnedConversation(id, userId)`），越权访问在数据层就被挡掉，不靠路由层"记得校验"；
- `messages.seq` 会话内自增 + `UNIQUE(conversation_id, seq)`，保证顺序且防重复写。

## 四、口令安全

| 措施 | 做法 |
|---|---|
| 哈希算法 | `scrypt`（node:crypto，无外部依赖），16 字节随机盐，64 字节输出 |
| 存储格式 | `scrypt$<saltHex>$<hashHex>` |
| 比对 | `crypto.timingSafeEqual`，定长比较，无时序侧信道 |
| 账号枚举防护 | 用户名不存在时也跑一次同等开销的 scrypt；"用户不存在"与"口令错误"统一返回 401 `invalid_credentials` |
| 出参 | 一律走 `toPublicUser()`，`password_hash` 永不出库 |
| 校验 | 用户名 `^[A-Za-z0-9_-]{3,32}$`，口令 8–128 位，邮箱格式校验（可空） |

## 五、登录凭证：复用网关 JWT

登录/注册返回的**就是网关那套 HS256 JWT**，只是多了两个 claim：

```jsonc
{
  "sub": "user:1",          // 客户端标识
  "typ": "user",            // ★ 登录用户 与 服务端/网关客户端 的分界
  "uid": 1,                 // 用户 ID
  "username": "demo_user",
  "scope": "chat.completions models.read conversation.read conversation.write",
  "iat": …, "nbf": …, "exp": …
}
```

好处：一套鉴权贯穿全网关，`assertScope` / 模型白名单 / 过期校验全部复用，无需第二套会话体系。

| 凭证 | `typ` | 能做什么 |
|---|---|---|
| 用户令牌（`/api/auth/login` 签发） | `user` | 聊天、会话读写、模型列表 |
| 网关 API Key（`GATEWAY_API_KEYS`） | — | 管理/服务端：换服务端 JWT、`/v1/auth/whoami`；**不能聊天、不能读写会话** |
| 服务端 JWT（`/v1/auth/token` 签发） | — | 同上 |

## 六、端点清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 免 | 注册，成功直接返回用户 + 令牌（201）；重名 409；弱口令/非法名 400 |
| POST | `/api/auth/login` | 免 | 登录，返回 `access_token` / `expires_in` / `user`（200）；失败 401 |
| GET | `/api/auth/me` | 用户 | 当前用户与令牌信息 |
| POST | `/api/conversations` | 用户 | 创建会话（`title` / `model` / `provider`） |
| GET | `/api/conversations` | 用户 | 列表，`?limit&offset`，只返回自己的 |
| GET | `/api/conversations/:id` | 用户 | 详情 + 消息；非本人 → 404 |
| POST | `/api/conversations/:id/messages` | 用户 | 追加消息（`role` / `content`），`seq` 自增 |
| DELETE | `/api/conversations/:id` | 用户 | 删除会话（级联删消息）；非本人 → 404 |
| POST | `/v1/chat/completions` | **用户** | 聊天（`CHAT_REQUIRE_USER=true` 时） |

### 聊天接口绑定登录用户

`CHAT_REQUIRE_USER=true`（默认）时，`/v1/chat/completions` 要求 `typ=user`，否则：

| 携带凭证 | 结果 |
|---|---|
| 用户令牌 | 200，正常转发 |
| 网关 API Key | **403 `user_auth_required`** |
| 服务端 JWT（`/v1/auth/token` 签发） | **403 `user_auth_required`** |
| 无凭证 | 401 `missing_credentials` |

设为 `CHAT_REQUIRE_USER=false` 可退回"网关凭证也能聊天"的行为（回归用）。

## 七、用 Postman 调通（3 分钟）

1. 启动网关：`cd gateway && npm run start`（`http://127.0.0.1:3600`，已含默认账号变量）；
2. Postman → **Import** → 选 `gateway/postman/nextchat-gateway.postman_collection.json`；
3. 集合变量已预置：`baseUrl`、`username=demo_user`、`password=demo-pass-2026`、
   `gateway_api_key=sk-gateway-local-2026`（与 `gateway/.env` 一致）；
4. **按顺序**执行 5 个分组：
   1. `1. 健康检查` —— 看 `db.users`、`chatRequiresUser`；
   2. `2. 用户认证` —— 注册（自动写入 `access_token`）→ 登录 → `me` → 两个失败用例；
   3. `3. 会话与消息` —— 创建（自动写入 `conversation_id`）→ 列表 → 加消息 → 详情 → 删除；
   4. `4. 模型与聊天` —— 模型列表 → 非流式聊天 → 流式聊天 → **403（API Key）** → 401（无凭证）；
   5. `5. 网关服务端凭证` —— 用 API Key 换服务端 JWT、`whoami`。
5. 每个请求自带 `pm.test()` 断言，Runner 里可看到全绿。

等价命令行冒烟（`npm run start` 后）：

```bash
curl -X POST http://127.0.0.1:3600/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"demo_user","password":"demo-pass-2026"}'
# → 201 {"user":{...},"access_token":"eyJ...","expires_in":7200}

curl -X POST http://127.0.0.1:3600/v1/chat/completions \
  -H "Authorization: Bearer <上一步的 access_token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"说两个字"}]}'
```

## 八、验证记录（2026-10-07）

`npm run probe` —— **PASS 39 / FAIL 0**，覆盖：

- 注册：201 / 重名 409 / 弱口令 400 / 非法用户名 400
- 登录：正确 200 / 错口令 401 / 不存在用户 401（不泄露存在性）
- `me`：带令牌 200（`kind=user`）/ 无令牌 401
- 会话：创建 201、加消息 `seq=1`、非法 role 400、列表、详情含 2 条消息、删除后再取 404
- **越权**：另一用户读写他人会话 → 404；网关 API Key 访问会话 → 403
- 聊天：用户令牌非流式 200（阿里真实回复）/ 流式 200 SSE；API Key → 403；无凭证 → 401；
  服务端 JWT → 403；篡改签名 → 401；过期 → 401；scope 不足 → 403；模型白名单越权 → 403
- CORS：白名单预检 204、非白名单 403、跨域错 key 401（带 CORS 头）、跨域用户令牌流式 200

Postman 等价冒烟（集合默认变量 `demo_user`）：注册 201 → 登录 200 → me 200 →
建会话 201 → 加消息 → 详情 200 → 聊天 200（alibaba）→ 删会话 200，全通。

## 九、配置项（`gateway/.env` 新增）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DB_PATH` | `data/gateway.db` | SQLite 库文件（相对网关目录） |
| `CHAT_REQUIRE_USER` | `true` | 聊天接口是否要求登录用户 |
| `REGISTRATION_ENABLED` | `true` | 是否开放注册 |
| `USER_TOKEN_TTL_SEC` | `7200` | 登录令牌有效期（秒） |

## 十、后续可做（未做）

- 刷新令牌 / 登出（当前令牌靠 `exp` 自然失效；换 `JWT_SECRET` 可立刻全部失效）
- 登录失败限流、IP/用户维度限流
- 聊天自动落库（请求体带 `conversation_id` 时把用户提问与模型回复写入 `messages`）
- 迁移 Postgres：只改 `src/db.ts`，上层不动
