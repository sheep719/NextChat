# NextChat 二次开发规范与变更台账

> 适用范围：本 fork（`sheep719/NextChat`）的所有改动。
> **维护约定**：任何一次改动完成后，必须回到本文档追加一条台账记录，并同步更新受影响的文档。
> 本文档是二开的事实来源，改动前先读，改动后必更。

---

## 一、仓库与分支策略（最高优先级）

### 1.1 上游自动同步的事实

`.github/workflows/sync.yml` 每天（`cron: "0 0 * * *"`）把上游
`ChatGPTNextWeb/ChatGPT-Next-Web` 的 `main` **自动同步到本 fork 的 `main` 分支**，
且带 `permissions: contents: write`（可强制写入）。

### 1.2 由此得出的硬性规则

| 规则 | 说明 |
|---|---|
| **不在 `main` 上做二开** | 二开改动一律提交到 `dev/*` 或 `feat/*` 分支，`main` 保持与上游一致 |
| **或关闭自动同步** | 若坚持在 `main` 上改，必须先删除/禁用 `sync.yml`，否则改动会被上游覆盖或产生冲突 |
| **同步后必做回归** | 上游同步后需重新验证本地启动、网关连通性（见第五节验证清单） |
| **冲突处理** | 上游 workflow 文件变更会导致 GitHub 暂停自动更新，此时需手动 Sync Fork 一次 |

### 1.3 分支命名

```
feat/<功能名>      新功能（如 feat/gateway）
fix/<问题>         缺陷修复
docs/<主题>        文档
chore/<杂项>       依赖、配置
```

> ⚠️ **本机环境限制（实测）**：本机 git **无法创建带斜杠的分支**（`dev/gateway`、`feat/gateway`、
> `gateway/dev` 均失败）——git 在 `.git/refs/heads/` 下建不了子目录，分支会变成
> **unborn 分支**（`git log` 报 "does not have any commits yet"，且 `git status` 把全仓库显示成 `A`）。
> 因此本仓库**实际使用扁平分支名**：`dev-gateway`、`fix-xxx`、`docs-xxx`、`chore-xxx`。
> 详见 `docs/troubleshooting.md` P-022。换机器或确认可创建嵌套 ref 后，可改回 `dev/*` 形式。

---

## 二、改动分层规则（决定侵入程度）

按侵入性从低到高分级，**能低不高**：

| 等级 | 类型 | 做法 | 示例 |
|---|---|---|---|
| **L0** | 纯新增 | 新建独立目录/文件，不动任何存量代码 | `gateway/`、`docs/request-flow.md` |
| **L1** | 配置层 | 只改环境变量 / `.env` / 配置文件 | `.env` 加 `ALIBABA_API_KEY` |
| **L2** | 最小侵入改存量 | 改存量文件，但限定在函数内部、新增分支，不改既有逻辑 | （本次未发生） |
| **L3** | 结构性改动 | 改公共抽象、重命名、跨模块重构 | 需先说明方案再动手 |

**执行要求**
- L2/L3 改动前必须说明改法与影响范围，不擅自决定；
- 任何改动不得破坏既有 provider 通道的可用性（回归验证至少覆盖当前在用的一家）。

---

## 三、红线（不可违反）

1. **不得修改分享署名消息**
   `app/client/api.ts` 的 `share()` 中写死了 `Share from [NextChat]: https://github.com/Yidadaa/ChatGPT-Next-Web`，
   源码注释明确要求：「敬告二开开发者们……请不要修改上述消息，此消息用于后续数据清洗使用」。
2. **密钥不入仓**
   - 根目录 `.env` 已被 `.gitignore` 忽略（第 43 行 `.env`）；
   - `gateway/.env` 由 `gateway/.gitignore` 忽略；
   - 新增含密钥的目录必须自带 `.gitignore`，并提供 `.env.example`（只留空键名）。
3. **不污染全局环境**
   依赖装在对应项目目录内；工具优先用 corepack（`yarn`）或项目本地 `npm`，不用 `npm install -g`。
4. **不把上游 key 下发到浏览器**
   服务端注入是既定设计（见 `app/api/auth.ts`），二开不得把真实 key 写进前端代码或 `/api/config` 响应。

---

## 四、本地环境约定

| 项 | 约定值 |
|---|---|
| 仓库路径 | `D:\github_projects\NextChat` |
| 主应用 | Next.js 14，`yarn` (corepack 提供 1.22.x)，`yarn dev` → `http://localhost:3000` |
| 网关 | Fastify 4 + tsx，`npm run start` → `http://127.0.0.1:3600` |
| 联调 mock 上游 | `node scripts/mock-upstream.mjs` → `127.0.0.1:3700` |
| 端口分配 | 3000 主应用 / 3600 网关 / 3700 mock，新增服务从 3800 起 |

**本机环境坑（已验证）**
- 系统设置了代理 `http_proxy=http://127.0.0.1:57679`：curl 访问 localhost 必须加 `--noproxy "*"`；
- bash 环境残缺（无 `mkdir/cat/head/dirname`），管道与 `node -e` 多行脚本输出捕获不可靠
  → 调试脚本写成 `.mjs` 文件、结果写入 txt 再读；
- PowerShell 输出捕获不稳定，必要时重定向到文件后用 node 读取（UTF-16LE）。

---

## 五、验证清单（改动后的最低要求）

- [ ] 类型检查通过：网关 `npm run typecheck`；主应用改动需 `yarn lint` 通过
- [ ] 真实请求验证（非"看起来能跑"）：主应用首页 HTTP 200 + `/api/config` 返回预期默认模型
- [ ] 网关链路：至少 1 家真实模型转发成功 + 1 家经 mock 上游验证（或真实 key）
- [ ] 错误分支验证：未注册模型 404 / 无 key 503 / 错误 key 401
- [ ] 网关鉴权回归：`cd gateway && npm run probe`（22 项，含 401/403/CORS/JWT 过期与篡改）
- [ ] 文档同步：受影响文档（README / 链路文档 / 本台账）已更新

---

## 六、提交规范（commit 约定）

| 规则 | 说明 |
|---|---|
| **先确认分支** | 提交前 `git branch --show-current`，必须不是 `main`；切分支后再 `git log --oneline -1` 确认有历史 |
| **扁平分支名** | 受本机限制（见 1.3），用 `dev-gateway` 这类扁平名 |
| **按层切提交** | 一个提交只做一件事，且**该提交必须能独立 typecheck**：工程配置 → 配置/数据层 → 领域层 → HTTP 层 → 文档 |
| **message 格式** | `type(scope): 主题`，正文用 `- ` 列关键点；type 取 `feat` / `fix` / `docs` / `chore` / `refactor` / `test` |
| **提交前复核** | `git add -A --dry-run` 确认无 `.env`、无 `data/*.db`、无 `scripts/*.txt` 等临时产物 |
| **提交后回填** | 改动完成即回本文档追加台账（C-00N），并同步受影响文档 |
| **作者身份** | 本仓库已设 `git config user.name sheep719` + `user.email sheep719@users.noreply.github.com`（仓库级）。本机全局是 `sheep`，与 GitHub 账号不一致，见 P-019 |
| **推送需确认** | 推送到远端属外部操作，未经用户确认不执行 |
| **及时推远端** | 本环境 `.git` 写入不保证持久（见 P-024），改动提交后应尽快推送，本地历史不能当备份 |

当前分支提交结构（`dev-gateway`，基于 main `defdcdb5`）：

```
3b8751de  docs: 新增请求链路精读文档与二开规范台账
4445c05a  chore(gateway): 初始化网关工程与依赖配置
295c8ef0  feat(gateway): 配置层与数据层
87129cb6  feat(gateway): 鉴权与用户领域层
88172cff  feat(gateway): HTTP 层、端点与自检工具
（其后两个 docs 提交见 git log：网关鉴权/用户体系文档、排障笔记与台账 C-006）
```

> 完整结构以 `git log --oneline main..dev-gateway` 为准，本表为提交时的快照。

---

## 七、变更台账

### C-001　本地开发环境搭建（2026-10-05）

- **等级**：L0/L1（新建目录 + 配置 `.env`）
- **内容**：从 `sheep719/NextChat` HTTPS clone 到 `D:\github_projects\NextChat`；
  经 corepack 启用 yarn（未全局安装）；`yarn install` 完成；
  `.env` 写入 `ALIBABA_API_KEY`（DashScope）+ `DEFAULT_MODEL=qwen-plus`
- **关键决策**：项目 `package.json` 绑定 yarn（`packageManager: yarn@1.22.19`，scripts 内部调用 yarn），
  故放弃 pnpm 改用 yarn，**未改动任何项目代码**
- **结果**：`yarn dev` 启动成功，首页 200，`/api/config` 返回 `defaultModel=qwen-plus`

### C-002　请求链路精读文档（2026-10-07）

- **等级**：L0（纯新增文档）
- **内容**：产出 `docs/request-flow.md`——前端（`chat.tsx` → `store/chat.ts onUserInput`
  → `client/api.ts` 工厂 → `platforms/alibaba.ts` → `utils/chat.ts streamWithThink`）
  → API Route（`api/[provider]/[...path]/route.ts` → `api/alibaba.ts` → `api/auth.ts`）
  → 模型接口（DashScope）全链路时序图 + 分层图 + 精读笔记
- **结论要点**：API key 由服务端 `auth()` 注入、不下发浏览器；服务端 SSE 原样透传不解析；
  打字机动画（rAF）与网络帧解耦；工具调用会触发二次请求循环

### C-003　自建多模型网关骨架（2026-10-07）

- **等级**：L0（纯新增 `gateway/` 目录，未改主应用任何代码）
- **内容**：Fastify 4 + TypeScript 网关，OpenAI 兼容入口 + 多模型路由
  - `src/config.ts`：provider 注册表 + 模型精确/前缀两级路由（alibaba / deepseek / zhipu）
  - `src/server.ts`：鉴权 hook + `/v1/chat/completions`（SSE 流式透传）+ `/v1/models` + `/healthz`
  - `src/env.ts`：零依赖 `.env` 加载器
  - `scripts/mock-upstream.mjs`：联调用极简 OpenAI 兼容上游
- **实测**：阿里非流式/流式真实转发成功；第二家经 mock 上游非流式/流式转发成功；
  未注册模型 404、无 key provider 503、错误网关 key 401
- **修复的两个真 bug**（详见 `gateway/README.md` 踩坑记录）
  1. 上游响应头不能全量透传：`transfer-encoding` 撞 `content-length` → undici `HPE_UNEXPECTED_CONTENT_LENGTH`
  2. 流式必须 `reply.hijack()` + `raw.pipe()`，`reply.send(Readable.fromWeb())` 会丢自定义响应头
- **待办**：接入主应用（在根目录 `.env` 加 `OPENAI_API_KEY` + `BASE_URL=http://127.0.0.1:3600/v1`）——**待确认后执行**

### C-004　网关统一鉴权（API Key / JWT）+ 成为 NextChat 自定义 endpoint（2026-10-07）

- **等级**：L0（全部改动在 `gateway/` 与 `docs/` 内，未改主应用任何代码）
- **内容**
  - 新增 `gateway/src/auth.ts`：API Key 多 Key 注册表（`<key>[:<clientId>]`）、
    JWT(HS256) 签发/校验（node:crypto，零依赖，未引入 jsonwebtoken）、
    scope / models / providers 三级授权、fail-closed 启动自检
  - `gateway/src/server.ts`：统一鉴权 hook + CORS 白名单 + `OPTIONS` 预检 +
    新增 `POST /v1/auth/token`（只认 API Key，禁止 JWT 自我续签）与 `GET /v1/auth/whoami`
  - 新增 `scripts/issue-token.ts`（签发 JWT CLI）、`scripts/auth-probe.ts`（22 项鉴权自检）
  - `.env` / `.env.example` 扩充鉴权与 CORS 配置项；`.gitignore` 忽略 `scripts/*.txt`
  - 新增 `docs/gateway-auth.md`（鉴权设计、拒绝矩阵、NextChat 接入步骤）
- **关键决策**
  - **JWT 用 node:crypto 手搓而非加依赖**：避免为一个 HMAC + base64url 引入整个 jsonwebtoken
  - **JWT 校验失败不回退 API Key**：形状像 JWT 但校验不过就直接 401，避免两种凭证混淆误判
  - **令牌端点只认 API Key**：否则 JWT 可无限自我续签，TTL 形同虚设
  - **未配凭证拒绝启动**（fail-closed）：把"未授权即拒绝"变成默认状态，而非靠人记得配 key；
    本地调试需显式 `ALLOW_ANONYMOUS=true`
  - **浏览器直连必须开 CORS**：NextChat 自定义 endpoint 是跨域直连（与走自身 `/api/openai/*`
    同源代理不同），且带 `Authorization` 会触发预检，故预检必须免鉴权
- **验证**：`npm run probe` 22/22 PASS（含阿里真实转发、mock 上游第二家、跨域 401/200、
  CORS 预检放行与拦截、JWT 过期/篡改、scope 与模型白名单越权 403）；
  未配凭证启动实测中止并打印指引
- **待办**：主应用侧实际配置（界面填自定义接口，或根目录 `.env` 走 `BASE_URL` 服务端代理，属 L1）——**待确认后执行**

### C-005　用户体系：表设计 + 注册/登录接口 + 聊天绑定用户（2026-10-07）

- **等级**：L0（全部改动在 `gateway/` 与 `docs/` 内，未改主应用任何代码）
- **内容**
  - `src/db.ts`：SQLite（better-sqlite3）连接 + 幂等建表迁移（`users` / `conversations` / `messages`），
    PRAGMA `journal_mode=WAL` + `foreign_keys=ON`，时间统一 epoch 毫秒
  - `src/users.ts`：scrypt 口令哈希（零依赖）、timing-safe 比对、账号枚举防护、
    注册/查询/登录校验、签发用户令牌
  - `src/conversations.ts`：会话与消息存储，**所有查询强制带 `user_id`**
  - `src/auth.ts`：新增 `typ` claim 与 `kind`（user / client / anonymous）、`assertUser()`
  - `src/server.ts`：新增 `/api/auth/register|login|me`、`/api/conversations*`；
    `CHAT_REQUIRE_USER=true` 时聊天接口只认 `typ=user` 的用户令牌
  - `postman/nextchat-gateway.postman_collection.json`：18 个请求、自带 `pm.test()` 断言
  - 新增 `docs/gateway-user-auth.md`（表设计、口令安全、端点、Postman 步骤）
- **关键决策**
  - **SQLite 起步 + 数据层单文件收敛**：换 Postgres/MySQL 只改 `src/db.ts`，上层不动
  - **登录复用网关 JWT**，用 `typ=user` 区分"登录用户"与"服务端/网关客户端"，
    不引入第二套会话体系
  - **归属隔离下沉到数据层**：越权靠 SQL 的 `user_id` 条件挡住，而非路由层记得校验
  - **chat 绑定登录用户**但保留 `CHAT_REQUIRE_USER` 开关，便于回归与灰度
  - 时间存 epoch 毫秒、口令永不出参（`toPublicUser()`）
- **验证**：`npm run probe` **39/39 PASS**（含跨用户越权 404、API Key 不能聊天 403、
  服务端 JWT 不能聊天 403、令牌篡改/过期 401、scope 与模型白名单 403、CORS 预检）；
  按 Postman 集合默认变量跑等价冒烟 7 步全通
- **待办**：刷新令牌/登出、登录限流、聊天自动落库（`conversation_id`）、迁移 Postgres

---

### C-006　排障笔记 + 提交整理（2026-10-07）

- **等级**：L0（纯新增/补充文档，未改任何代码）
- **内容**
  - 新增 `docs/troubleshooting.md`：把开发过程中**真正卡住过**的 22 个问题按
    「环境 / 网络 / 运行时 / 工程 / 仓库流程」分类，每条含现象 → 根因 → 解决 → 防范，附速查表
  - 本文档新增「六、提交规范」章节（分支确认、按层切提交、message 格式、提交前后复核）
  - 把此前散落在对话里的踩坑（SSE 头冲突、hijack 丢头、代理、bash 残缺等）固化为可检索笔记
- **关键决策**
  - **排障笔记与二开规范分离**：规范回答"该怎么做"，排障笔记回答"卡住了怎么办"，避免规范文档被撑爆
  - **只记录真卡住过的问题**，不写"理论上可能出错"的条目，保证每条都有实测支撑
  - **提交按层切而非按时间切**：所有改动此前都是未提交状态，按依赖层切能保证每个提交都能独立 typecheck、可 bisect
- **验证**：`git log --oneline` 结构符合第六节约定；`npm run probe` 39 项仍全 PASS（未改代码）
- **待办**：推送到远端 fork（**需用户确认**）；聊天自动落库；刷新令牌/限流

---

## 八、后续改动记录（持续更新）

<!-- 新改动追加在此处，格式照抄第六节 -->

### C-007　作者身份统一 + 推送到远端 fork（2026-10-07）

- **等级**：L0（流程与文档，不改任何代码）
- **内容**
  - 仓库级身份设为 `sheep719 <sheep719@users.noreply.github.com>`（本机全局 `sheep` 与 GitHub 账号不符）
  - 推送 `dev-gateway` 到 `origin`（`https://github.com/sheep719/NextChat.git`），远端此前只有 `main`
- **关键决策**
  - **用 GitHub noreply 邮箱**：提交能稳定关联到 `sheep719` 账号，且不暴露真实邮箱
  - **只推功能分支、不动 `main`**：本 fork 的 `main` 每天被上游 `sync.yml` 自动覆盖
  - **放弃重写历史，改为工作区重提**：用 `git rebase --exec amend` 改作者时命令超时被杀，
    `.git` 写入被回滚（P-024），8 个提交对象丢失。工作区文件完好，故按原分层重新提交——
    **内容零损失，代价是 commit hash 全部变化**（新 hash 见 `git log --oneline main..dev-gateway`）
- **推送结果**（已核验）：远端 `dev-gateway` = `9f5db3f4`，与本地一致；`main` 保持 `defdcdb5` 未动

  ```
  747e6911  docs: 新增请求链路精读文档与二开规范台账
  0bfb5b0e  chore(gateway): 初始化网关工程与依赖配置
  2b618f72  feat(gateway): 配置层与数据层
  4a513c09  feat(gateway): 鉴权与用户领域层
  749c6033  feat(gateway): HTTP 层、端点与自检工具
  482581e8  docs(gateway): 鉴权设计与用户体系接入文档
  9f5db3f4  docs: 补充作者身份与推送规范、排障条目 P-024、台账 C-007
  ```

  7 个提交作者均为 `sheep719 <sheep719@users.noreply.github.com>`（GitHub API 核验）

  > **2026-10-08 补充：上表 hash 已全部失效。** 做 C-008 时 P-024 **再次发生**
  > （提交命令被中断 → `.git` 写入回滚 → `refs/` 与本地提交对象一起丢失），
  > 本地已无法还原，只能从工作区重提。内容零损失，hash 全变，
  > 新 hash 见下方 C-008。远端 `dev-gateway` 仍停在旧历史 `9f5db3f4`，
  > 因此再次推送需要**强推**（见 C-008 待确认事项）。
- **经验固化**
  - **历史重写在本环境不可靠**：改作者本来只需 `rebase --exec amend`，
    但本环境会回滚被中断命令的写入（P-024），改为"工作区重提"更稳
  - **验证远端不要只靠 `git ls-remote`**：本机代理会让 git 报
    `CONNECT tunnel failed, 502`；改用
    `curl https://api.github.com/repos/sheep719/NextChat/branches` 核验最直观
  - **批量 git 写入放同一条命令内**：重建 refs + 7 次提交 + push 一次跑完，可规避跨命令回滚
- **验证**：`git ls-remote --heads origin` 能看到 `refs/heads/dev-gateway`，且 hash 与本地一致
- **待办**：刷新令牌/限流；聊天自动落库（`conversation_id`）；迁移 Postgres

### C-008　前端登录页 + 会话云端同步（2026-10-08）

- **等级**：L2（新增文件为主 + 少量既有文件改动）
- **内容**
  - 新增 `/login` 路由与登录注册页；`home.tsx` 加登录守卫（未登录 → `/login`）
  - 新增 `app/store/auth.ts`（登录态）与 `app/utils/gateway-sync.ts`（`ChatSyncer`）
  - 网关新增 `cloud_state` 表与 4 个 `/api/sync/state*` 端点
  - 设置页新增账号区（当前用户 / 上次同步时间 / 立即同步 / 登出）
- **关键决策**
  - **整包快照而非逐条 upsert**：`ChatSession` 字段会随上游演进，逐字段映射必丢字段
  - **独立 `/login` 路由而非 HashRouter 子页**：`home.tsx` 内是 HashRouter，做不了路由级守卫
  - **JWT 直接写进 `useAccessStore` 当 API Key**：一步同时解决"聊天走网关"和"请求带用户身份"
  - **乐观锁用 `baseUpdatedAt`**：冲突 409 回传服务端最新，客户端合并后只重试一次
- **新增文件**：`app/store/auth.ts`、`app/utils/gateway-sync.ts`、`app/components/login.tsx`、
  `app/login/page.tsx`、`gateway/src/cloud-state.ts`、`docs/frontend-cloud-sync.md`
- **改动文件**：`app/components/home.tsx`、`app/components/settings.tsx`、`app/constant.ts`、
  `app/store/index.ts`、`app/locales/{cn,en}.ts`、`gateway/src/db.ts`、`gateway/src/server.ts`
- **验证**：接口层 `sync-probe.mjs` 13/13；端到端 `e2e-sync.mjs` 6/6（两个隔离 BrowserContext 模拟换设备）
- **踩坑**：CORS 未放行 PUT（P-026）、ChatStore 就地 mutate 导致订阅失效（P-027）、
  IndexedDB hydration 竞态（P-028）、新页面循环依赖 SSR 500（P-025/P-029）、
  合并后停在空会话（P-030）
- **环境事故（P-024 两次复发）**：提交前端层时 pre-commit 钩子
  （husky → lint-staged → `eslint --fix ./app/**`）在本环境无限挂死，
  且被中断/挂死的命令会把 `.git` 写入回滚——连此前已成功提交的 commit 对象也一并丢失，
  本轮共恢复三次。**经验：本环境本地 `.git` 不可靠，工作区文件始终完好；
  慢检查必须放后台跑；提交后立即 `git log` 复核；尽早推远端。**
- **用户确认的两个例外**（2026-10-08，经询问后批准）
  1. 前端层提交使用 `--no-verify`：先手动对全部改动文件跑 `eslint --fix` 与
     `prettier --write`（与钩子相同的检查），只是绕开挂死的 lint-staged 运行器
  2. `git push --force-with-lease=dev-gateway:9f5db3f4…` 强推：本地历史因 P-024
     被迫重写（内容一致、hash 全变），远端是自己的 fork 功能分支、无协作者
- **本次提交与推送结果**（已用 GitHub API 核验）

  ```
  9d8a22e7  feat(gateway): 自建多模型网关 + 统一鉴权 + 用户体系 + 云端同步端点
  3890071d  feat(frontend): 登录页与会话云端同步
  e6348521  docs: 云端同步文档、台账 C-008 与排障 P-026~P-032
  ```

  远端 `dev-gateway` = `e6348521`，与本地一致；`main` 仍为 `defdcdb5` 未动。
  因本地历史被迫重写，本次为强推：
  `git push --force-with-lease=dev-gateway:acd46f1f… origin dev-gateway`
- **强推踩坑**：lease 的期望值要填**远端实际值** `acd46f1f`，不是台账里写的 `9f5db3f4`
  （C-007 之后还推过一次 docs 提交）。填错会被 `stale info` 拒绝。
  核验远端一律走 `api.github.com/repos/sheep719/NextChat/branches`——
  `git ls-remote` 会被本机代理拦成 `CONNECT tunnel failed 502`。
- **待办**：多标签页实时同步；快照分片（当前上限 8MB）；补 `gpt-4o-mini` 等模型的 provider 路由

### C-009　用量统计：记录 token + 按天图表面板（2026-10-08）

- **等级**：L2（新增文件为主 + 少量既有文件改动）
- **内容**
  - 网关新增 `usage_records` 表与 `gateway/src/usage.ts`（记录 / 按天聚合 / 四口径汇总）
  - `/v1/chat/completions` 转发链路记账：非流式解析 `usage`；流式注入
    `stream_options.include_usage` 并用 Transform 边转发边解析
  - 网关新增 `GET /api/usage/daily`、`/api/usage/summary`、`/api/usage/recent`
  - 前端新增 `app/components/usage.tsx`（Recharts），侧边栏「用量」入口，`Path.Usage = "/usage"`
  - 安装依赖 `recharts`（`package.json` + `yarn.lock`）
- **关键决策**
  - **真实 usage 优先、估算兜底**：注入 `stream_options.include_usage`（OpenAI 兼容标准开关）；
    上游返回 400 且提示该字段时**自动去掉重试**；拿不到就按内容估算并置 `estimated=1`
  - **估算规则**：CJK 1 字≈1 token、其余 4 字符≈1 token；请求侧按 messages、响应侧按流式正文累加
  - **面板做在网关侧而非前端**：换设备也要连续，且前端拿不到上游真实 usage
  - **Recharts（用户选）**：React 声明式、体积小；体积大的按需 `dynamic()` 加载
  - **入口用 HashRouter 子页**：与设置页同级，不用新建 Next 路由、不重复做登录守卫
- **新增文件**：`gateway/src/usage.ts`、`app/components/usage.tsx`、`app/components/usage.module.scss`、
  `app/icons/usage.svg`、`docs/usage-stats.md`
- **改动文件**：`gateway/src/db.ts`、`gateway/src/server.ts`、`gateway/src/config.ts`、
  `gateway/scripts/mock-upstream.mjs`、`app/constant.ts`、`app/components/home.tsx`、
  `app/components/sidebar.tsx`、`app/locales/{cn,en}.ts`、`package.json`、`yarn.lock`
- **验证**：网关侧 7 项全过（真实 usage 两条路径 + 估算兜底 + 补零 + 汇总 + 隔离 + 401）；
  前端 E2E 10/10（面板数值与网关 summary 完全一致）
- **踩坑**：E2E 注入登录态不能用删 IndexedDB（被应用连接阻塞，evaluate 挂死，P-033）；
  Recharts 3 的坐标轴类名与 2.x 不同、断言要改用整段文本（P-034）
- **本次提交**

  ```
  3a35bef7  feat(gateway): 用量统计——记录每次调用 token 并按天聚合
  7fb785f3  feat(frontend): 用量面板——Recharts 按天展示 token 与调用次数
  <docs>    docs: 用量统计文档、台账 C-009 与排障 P-033~P-034
  ```

  前端层同样使用 `--no-verify`（用户已确认）：手动跑完 eslint / prettier / tsc
  后绕开挂死的 lint-staged 运行器。
- **待办**：按模型拆分、费用估算（需维护价格表）；用量配额/限流

### C-010　项目收尾：容器化 + README + 提交历史整理（2026-10-08）

- **等级**：L2（覆盖上游既有的 `Dockerfile` / `docker-compose.yml` / `.dockerignore`，
  并在 `README.md` **顶部新增区块**、原文一字未删）
- **内容**
  - `Dockerfile` 改为多阶段单镜像：前端 `yarn build`（standalone）+ 网关 `npm ci`，
    最终镜像由 `docker/start.sh` 同时拉起 web(3000) 与 gateway(3600)
  - `docker/start.sh`：双进程托管、信号转发、任一退出即整体退出；
    `JWT_SECRET` 缺失时自动生成并持久化到数据目录
  - `.dockerignore` 排除任意层级 `.env`、`gateway/node_modules`、`*.db`
  - `.gitattributes` 强制脚本 LF（否则 CRLF 进容器会 `bash\r` 报错）
  - `docker-compose.yml` 改为构建本地镜像的单 service
  - `README.md` 顶部加「二开版总览」：一键运行、环境变量表、
    架构对比（mermaid 原版 vs 二开版 + 能力对比表）、改动清单、文档索引
- **关键决策**（均经用户确认）
  - **README 顶部加区块而非重写**：上游 README 有 483 行且每日自动同步，
    只改开头一小段可把将来合并冲突压到最小
  - **单容器双进程**而非两容器 compose：`docker run` 一条命令即可，不需要 compose；
    compose 仅作为可选便利方式保留
  - **不动提交历史**：现有 7 个提交已按「网关 / 前端 / 文档」分层，语义清晰；
    本环境重写历史有 P-024 风险，改为打标签 `v0.2.0` + 在文档里固化说明
- **新增文件**：`docker/start.sh`、`.gitattributes`
- **改动文件**：`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`README.md`、
  `docs/secondary-dev-rules.md`、`docs/troubleshooting.md`、`gateway/README.md`
- **验证**：本地 `yarn build` 产出 standalone，按容器目录布局起服务 `/login` 返回 200；
  `bash -n` 语法通过；12 项不变量断言全过。**本机无 Docker，未执行 docker build/run**（P-039）
- **踩坑**：P-035（必须 Node 22）、P-036（`HUSKY=0`）、P-037（`HOST=0.0.0.0`）、
  P-038（CRLF → `.gitattributes`）、P-039（无 Docker 的替代验证）
- **本次提交**

  ```
  d5450882  feat(docker): 单镜像同时托管前端与网关，支持一键 docker run
  （紧随其后的 docs 提交即本条台账所在提交，不在此自引用 hash）
  ```

- **标签**：`v0.2.0`（对应"登录 + 云同步 + 用量统计 + 容器化"这一版）
- **待办**：真机 `docker build` 验证（装 better-sqlite3、镜像体积、首次启动耗时）；
  用量按模型拆分；`gpt-4o-mini` 的 provider 路由

### C-011　真机 Docker 验证 + 干净环境三处构建修复 + 演示截图归档（2026-10-10）

- **等级**：L1（`.dockerignore`/`tsconfig.json` 配置修正）+ L2（Dockerfile 构建参数，默认关）
- **背景**：本机 Docker Desktop 修复后（WSL3.0.1 MSI 安装），补齐验收 DOC-01（真机 compose
  验证）与 USER-05（docs/demo/ 截图归档）。
- **干净环境暴露的三处问题**（本地构建因环境巧合从未触发）：
  1. `node:22-bookworm-slim` 2025 起预装 yarn → `npm install -g yarn@1.22.19` 报
     `EEXIST /usr/local/bin/yarn`。改为 `command -v yarn || npm install -g`；
  2. `.dockerignore` 整目录排除 `src-tauri` → `app/config/build.ts` 的编译期
     `import tauri.conf.json` 失败。改为只排除 `src-tauri/target`；
  3. 根 `tsconfig.json` 的 `include **/*.ts` 扫到 `gateway/src`（独立依赖树，
     better-sqlite3 不在 root node_modules）→ 容器内 typecheck 报
     `Cannot find module 'better-sqlite3'`。exclude 补 `gateway`、`src-tauri/target`。
- **网络受限构建方案**（Dockerfile 新增 ARG，默认关闭不动上游语义）：
  `--build-arg NPM_REGISTRY=https://registry.npmmirror.com --build-arg REWRITE_LOCK_REGISTRY=1`。
  根因：yarn 1.x `--frozen-lockfile` 从 lock 的 `resolved` URL 下载 tarball，
  `--registry` 只管解析；lock 里 765 个包指向 registry.yarnpkg.com（国内不可达），
  必须 sed 重写域名。yarn 1.x 不读 http_proxy 环境变量（apt/npm 认，yarn 不认）。
- **真机验证数据**：
  - 构建耗时约 22 分钟（走 npmmirror；含 apt 编译链 73MB + yarn 1100 包 + Next build）
  - `docker compose up -d` → 容器 healthy（3000/3600 双端口）
  - `:3000/login` = 200；`:3600/health` = 200 `{"status":"ok"}`；
    `/api/conversations` 无 token = 401
- **截图**：`docs/demo/`（Edge CDP 无头自动化：01 登录 / 02 对话 / 03 跨端历史 /
  04 用量面板），脚本 `D:\Doctor\demo-shots.mjs`（本机，不入库）
- **本次提交**：
  - `0795574a` fix(docker) / `1b7ab203` fix(build) / `c3126c70` docs(demo) /
    `4d33b901` docs(acceptance)
- **待办**：DOC-04 提交数补量（本日 +5）；INT 三项第 4 周前
