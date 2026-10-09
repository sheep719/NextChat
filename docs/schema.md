# 数据库表结构说明（SQLite）

> 用途：满足验收标准 AC-USER-01 的 `docs/schema.md` 要求。
> 实现：`gateway/src/db.ts`（better-sqlite3，同步 API）。
> 建表用 `CREATE TABLE IF NOT EXISTS`，幂等可重复执行——进程启动时跑一次，即"迁移"。
> 时间统一存 **epoch 毫秒**（INTEGER）。库文件默认 `gateway/data/gateway.db`（`DB_PATH` 可覆盖）。

## 1. users — 用户表

对应验收标准的 `User`（id / email / passwordHash / createdAt）。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | 用户 ID |
| `username` | TEXT | NOT NULL UNIQUE | 用户名（`/^[A-Za-z0-9_-]{3,32}$/`） |
| `email` | TEXT | UNIQUE，可空 | 邮箱（可选——本项目以用户名登录，见下方"与标准字段的差异"） |
| `password_hash` | TEXT | NOT NULL | **scrypt** 加盐哈希，格式 `scrypt$<saltHex>$<hashHex>`（见下方说明） |
| `role` | TEXT | NOT NULL DEFAULT 'user' | 角色 |
| `status` | TEXT | NOT NULL DEFAULT 'active' | 状态（预留封禁等） |
| `created_at` | INTEGER | NOT NULL | epoch 毫秒 |
| `updated_at` | INTEGER | NOT NULL | epoch 毫秒 |

> **与标准字段的差异（经确认的设计选择）**：标准写 `email` 必填 + bcrypt；
> 实现为 **username 必填、email 可空** + **scrypt**（Node `node:crypto` 原生，零外部依赖，
> 校验用 `timingSafeEqual` 防时序侧信道）。理由：聊天产品以用户名为主标识；
> scrypt 与 bcrypt 同为慢哈希，安全等级相当。重复注册返回 409（`username_taken`）。

## 2. conversations — 会话表

对应验收标准的 `Conversation`（id / userId / title / messages / updatedAt）。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | 会话 ID |
| `uuid` | TEXT | NOT NULL UNIQUE | 对外暴露的会话标识 |
| `user_id` | INTEGER | NOT NULL → users.id | 归属用户，**ON DELETE CASCADE** |
| `title` | TEXT | NOT NULL DEFAULT '' | 会话标题 |
| `model` | TEXT | NOT NULL DEFAULT '' | 最近使用的模型 |
| `provider` | TEXT | NOT NULL DEFAULT '' | 最近使用的 provider |
| `archived` | INTEGER | NOT NULL DEFAULT 0 | 归档标记 |
| `created_at` / `updated_at` | INTEGER | NOT NULL | epoch 毫秒 |

索引：`idx_conversations_user (user_id, updated_at DESC)`。

> **与标准字段的差异**：标准把 `messages(JSON)` 内嵌在会话表；实现拆为独立的
> `messages` 表（逐条存、`(conversation_id, seq)` 唯一），便于按条追加与 token 分摊。

## 3. messages — 消息表

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `conversation_id` | INTEGER | NOT NULL → conversations.id | **ON DELETE CASCADE** |
| `seq` | INTEGER | NOT NULL | 会话内序号，`(conversation_id, seq)` 唯一 |
| `role` | TEXT | NOT NULL | user / assistant / system |
| `content` | TEXT | NOT NULL | 消息正文 |
| `model` | TEXT | NOT NULL DEFAULT '' | 生成该消息的模型（assistant 消息） |
| `prompt_tokens` | INTEGER | NOT NULL DEFAULT 0 | 该消息产生的输入 token |
| `completion_tokens` | INTEGER | NOT NULL DEFAULT 0 | 该消息产生的输出 token |
| `created_at` | INTEGER | NOT NULL | epoch 毫秒 |

索引：`idx_messages_conv (conversation_id, seq)`。

## 4. cloud_state — 云端状态快照（会话云同步）

前端 ChatStore 的整包快照按 key 存一份；`payload` 是**不透明 JSON**，网关不解析内容，
协议演进不需要改表结构。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `user_id` | INTEGER | NOT NULL → users.id | **联合主键**之一，ON DELETE CASCADE |
| `state_key` | TEXT | NOT NULL | **联合主键**之一（前端固定传 `"chat"`，见 `app/constant.ts` 的 `SYNC_STATE_KEY`） |
| `payload` | TEXT | NOT NULL | 前端会话集合的 JSON 序列化（上限 8MB） |
| `version` | INTEGER | NOT NULL DEFAULT 1 | 每次覆盖 +1，单调递增 |
| `updated_at` | INTEGER | NOT NULL | epoch 毫秒（服务端时间，单调） |

> 乐观锁：客户端 PUT 时带 `baseUpdatedAt`，与服务端不一致 → 409 并回传服务端最新 payload，
> 客户端按 `lastUpdate` 逐会话合并后重试。

## 5. usage_records — 用量记录

对应验收标准的 `Usage`（userId / model / promptTokens / completionTokens / createdAt）。
**每次 `/v1/chat/completions` 调用落一行（无论成功失败）**，保证"调用次数"口径准确。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `user_id` | INTEGER | → users.id，**可空** | 网关 API Key（非登录用户）调用时为空 |
| `client_id` | TEXT | NOT NULL DEFAULT '' | 凭证标识（API Key 的 clientId） |
| `model` | TEXT | NOT NULL DEFAULT '' | 请求的模型名 |
| `provider` | TEXT | NOT NULL DEFAULT '' | 命中的 provider |
| `prompt_tokens` | INTEGER | NOT NULL DEFAULT 0 | 输入 token |
| `completion_tokens` | INTEGER | NOT NULL DEFAULT 0 | 输出 token |
| `total_tokens` | INTEGER | NOT NULL DEFAULT 0 | 合计 |
| `estimated` | INTEGER | NOT NULL DEFAULT 0 | **1 = 估算值**（上游没返回 usage 时按内容推算：CJK 1 字≈1 token，其余 4 字符≈1 token） |
| `stream` | INTEGER | NOT NULL DEFAULT 0 | 是否流式 |
| `status` | INTEGER | NOT NULL DEFAULT 0 | HTTP 状态码 |
| `latency_ms` | INTEGER | NOT NULL DEFAULT 0 | 上游耗时 |
| `created_at` | INTEGER | NOT NULL | epoch 毫秒 |

索引：`idx_usage_user_time (user_id, created_at DESC)`、`idx_usage_time (created_at DESC)`。

## 迁移方式

```bash
# 无独立迁移命令——启动网关即完成建表（幂等）
cd gateway && npm run dev   # 或 npm start

# 验证表已就位
node -e "const D=require('better-sqlite3');const db=new D('data/gateway.db',{readonly:true});
console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all())"
```

> 优于 `prisma migrate status` 的判定：SQLite 场景下启动即迁移，
> `sqlite_master` 能查到全部 5 张表 + 4 个索引即为 up to date。
