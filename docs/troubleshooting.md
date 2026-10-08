# 排障笔记：卡住的问题与解决方案

> 记录本项目（NextChat fork + 自建网关）开发过程中**真正卡住过**的问题：现象、根因、解法、防范手段。
> 目的是让下次遇到同类问题不再重复排查。按「环境 / 网络 / 运行时 / 工程 / 仓库流程」分类，
> 每条含 **现象 → 根因 → 解决 → 防范** 四段。

> 相关文档：`docs/secondary-dev-rules.md`（二开规范与台账）、`gateway/README.md`（网关踩坑记录）、
> `docs/request-flow.md`（请求链路）、`docs/gateway-auth.md`、`docs/gateway-user-auth.md`。

---

## 一、本机环境类

### P-001　bash 工具环境残缺：`mkdir` / `cat` / `head` / `dirname` 全部 command not found

- **现象**：执行 `mkdir -p /d/github_projects && git clone ...` 报 `mkdir: command not found`；
  带管道的 `| head -20` 报 `head: command not found`；每次命令还附带
  `shell-runtime-bash-env.sh: line 3: dirname: command not found`。
- **根因**：本机 bash shim 不是完整 POSIX 环境，缺少 coreutils 子集；`head` 缺失导致管道类命令整体失败（exit 127）。
- **解决**：
  1. 目录创建改用 PowerShell：`New-Item -ItemType Directory -Force -Path "D:\github_projects"`；
  2. 取全部输出时**不要**用管道，改用 `git add --dry-run`、`git status --porcelain` 等原生输出；
  3. 需要文本处理时用 `node -e "..."` 代替 `cat/head/grep`。
- **防范**：凡命令里出现 `mkdir/cat/head/tail/dirname/xargs`，直接改用 PowerShell 工具或 node 脚本。

### P-002　`node -e` 多行脚本的输出捕获不可靠

- **现象**：`node -e "..."` 里跑复杂逻辑（批量请求、多行模板字符串）时，控制台只有 `ERR` 或完全无输出，
  但服务端日志显示请求已 200 成功。
- **根因**：bash shim 对多行/特殊字符（`$`、`\n`、引号）的转义处理有问题，脚本片段被截断。
- **解决**：把逻辑写成 `.mjs` / `.ts` 脚本文件再执行；结果**写入 txt**，然后用
  `node -e "console.log(require('fs').readFileSync('<path>','utf8'))"` 读回。
  （`gateway/scripts/auth-probe.ts` 就是按这个模式写的，结果落到 `scripts/auth-probe-result.txt`。）
- **防范**：超过 3 行的脚本一律落文件，不写 `-e` 内联。

### P-003　PowerShell 输出捕获不稳定，且文件是 UTF-16LE

- **现象**：PowerShell 工具里 `yarn --version` 看起来"没有输出"；重定向到文件后用普通方式读取是乱码。
- **根因**：工具对 stdout 捕获有丢帧；PowerShell `>` 默认写 UTF-16LE，而读取方按 UTF-8 解析。
- **解决**：命令后加 `*> 文件路径` 强制写盘，再用 node 按 `utf16le` 读并去掉 `\0`：
  ```js
  node -e "let s=require('fs').readFileSync(p);console.log(s.toString('utf16le').replace(/\0/g,''))"
  ```
- **防范**：PowerShell 只用来"执行 + 写文件"，不用来"看输出"。

### P-004　corepack 的 yarn 在 bash 里跑不起来

- **现象**：`node .../corepack/dist/corepack.js enable yarn` 创建了 shim，但直接 `yarn --version` 报脚本无法执行。
- **根因**：corepack 在 Windows 生成的是 `yarn` / `yarn.cmd` / `yarn.ps1` 三个 shim；bash shim 不是真正的 shell，
  无法执行 shebang 脚本；`.ps1` 又被执行策略挡住。
- **解决**：绕开 shim，**直接调用** `C:\Users\21998\.workbuddy\binaries\node\versions\22.22.2-3\yarn.CMD`。
- **防范**：Windows 下优先显式调用 `.CMD`，依赖 PATH 查找不可靠。

---

## 二、网络与代理类

### P-005　curl 访问本地服务返回代理错误

- **现象**：`curl http://127.0.0.1:3600/healthz` 返回的不是网关响应，而是代理报错页 / 连不上。
- **根因**：系统设置了 `http_proxy=http://127.0.0.1:57679`，curl 默认把 localhost 请求也发给代理。
- **解决**：`curl --noproxy "*" ...`；或直接改用 Node 原生 `fetch`（不受该环境变量影响）。
- **防范**：本机所有 curl 调用一律带 `--noproxy "*"`（已写入二开规范第四节）。

### P-006　`yarn install` 中途被中断（网络重试后进程终止）

- **现象**：首次安装出现两次网络重试警告后被终止，`node_modules` 已有 730 个包但 `.bin` 未链接完。
- **根因**：安装耗时长（最终约 17 分钟），前台超时 / 网络抖动中断了进程。
- **解决**：不做清理，直接重跑 `yarn install`——yarn 有缓存可续传，不必从头开始；
  长命令改用后台执行（`run_in_background`）避免被前台超时打断。
- **防范**：安装类命令一律后台执行；中断后先看 `node_modules` 是否成型，能续就续。

### P-007　Next dev 首次请求超时

- **现象**：`curl http://localhost:3000` 挂住直到超时，而服务端日志显示正在编译。
- **根因**：Next.js 开发模式首次访问会 hold 住请求直到编译完成，默认 curl 超时不够。
- **解决**：把 `--max-time` 提到 300s 再请求一次；首次编译完成后后续请求即为毫秒级。
- **防范**：验证主应用前先确认 dev server 日志出现 `Ready`，再放宽超时请求。

### P-008　上游返回 429 频率限制

- **现象**：阿里云 DashScope 返回
  `429 您的使用量已超出频率限制，将在 2026-10-07 21:51:31 UTC+8 重置`。
- **根因**：`qwen-plus` 免费额度有 RPM 限制，联调时反复请求打爆。
- **解决**：等待重置或换模型；**联调阶段改用本地 mock 上游**（`gateway/scripts/mock-upstream.mjs`，端口 3700）
  跑通链路，不消耗真实额度。
- **防范**：批量自检脚本优先指向 mock 上游，真实模型只做少量抽样验证。

---

## 三、运行时与协议类（网关核心坑）

### P-009　非流式请求整体失败：`HPE_UNEXPECTED_CONTENT_LENGTH`

- **现象**：网关转发成功（服务端日志 200），但客户端 `fetch` 抛 `HPE_UNEXPECTED_CONTENT_LENGTH`。
- **根因**：把上游响应头**全量透传**时带上了 `transfer-encoding: chunked`（undici 已解压，语义失效），
  而 Fastify 又自动补了 `content-length`，两者冲突，undici 解析器直接报错。
- **解决**：透传前过滤 hop-by-hop / 长度类响应头：
  `content-encoding`、`content-length`、`transfer-encoding`、`connection`、`www-authenticate`。
- **防范**：**代理类代码永远不要全量透传响应头**，只保留白名单。

### P-010　流式 SSE 丢失自定义响应头（`content-type` / `x-gateway-provider` 全为 null）

- **现象**：`reply.send(Readable.fromWeb(upstream.body))` 后，客户端拿到的 `content-type` 不是
  `text/event-stream`，自定义头也不见了。
- **根因**：Fastify 对流的处理路径不会应用此前 `reply.header()` 设置的头。
- **解决**：改用 `reply.hijack()` + `reply.raw.writeHead(status, headers)` + `Readable.pipe(reply.raw)`，
  完全接管原始响应。
- **防范**：流式响应一律 hijack，不走 Fastify 的序列化路径。

### P-011　hijack 之后 CORS 头不生效（浏览器跨域请求被拦）

- **现象**：非流式请求带 CORS 头正常，流式分支的预检/响应缺少 `Access-Control-Allow-Origin`。
- **根因**：`raw.writeHead()` 直接写底层 socket，**绕过了 Fastify 的 header 收集**，
  因此全局 CORS hook 注入的头不会出现在 hijack 分支。
- **解决**：在请求对象上暂存 CORS 头（`req.corsHeaders`），hijack 分支手动并入 `writeHead` 的头对象。
- **防范**：凡 hijack 分支，都要显式复查"是否有中间件注入的头需要手动补"。

### P-012　只有一家模型有 key，无法证明"多模型路由"真的可达

- **现象**：DeepSeek / 智谱没有 key，请求返回 503 `provider_not_configured`，
  无法区分"路由错了"还是"只是没配 key"。
- **根因**：缺上游凭证，端到端链路无法闭合。
- **解决**：写一个极简 OpenAI 兼容 mock 上游（3700），支持非流式与 SSE 两种响应，
  把 `DEEPSEEK_BASE_URL` 指向它，即可真实走完整 HTTP 转发验证（SSE 11 帧拼出完整回复）。
- **防范**：涉及多 provider 的功能，一律配 mock 上游做联调，避免"看起来对"但从未跑通。

### P-013　自检里"JWT 过期"用例偶发误判

- **现象**：构造 `exp = now - 60` 的过期令牌，有时被判为有效。
- **根因**：JWT 校验带 60s 时钟容差（`JWT_CLOCK_SKEW_SEC`），`now-60` 正好落在容差边界内。
- **解决**：把过期用例的 `exp` 设到容差之外（如 `now - 3600`），边界值不要贴着阈值取。
- **防范**：安全相关用例的构造值要远离任何容差/阈值边界，否则测试会假阳性。

---

## 四、工程与类型类

### P-014　项目绑定 yarn，但先装了 pnpm

- **现象**：`package.json` 声明 `packageManager: yarn@1.22.19`，且 `dev` 脚本内部写死
  `concurrently -r "yarn run mask:watch" "next dev"`。
- **根因**：NextChat 该版本原生绑定 yarn，用 pnpm 启动时内部仍会调用 yarn，未安装则直接失败。
- **解决**：确认后放弃 pnpm，改用 corepack 提供的 yarn 1.22.x，**未改动任何项目代码**。
- **防范**：新项目先读 `packageManager` 字段与 scripts 内部命令，再决定包管理器。

### P-015　`.mjs` 文件里写了 TypeScript 类型注解

- **现象**：`scripts/mock-upstream.mjs` 中 `let parsed: any = {}` 直接语法错误，脚本启动失败。
- **根因**：`.mjs` 按 ESM JavaScript 解析，不支持类型注解（习惯性按 TS 写）。
- **解决**：去掉类型注解，改用纯 JS 写法。
- **防范**：`.mjs`/`.js` 脚本里禁用 `: type` 语法；需要类型就改成 `.ts` 走 tsx。

### P-016　Fastify 请求对象扩展类型的写法

- **现象**：`declare module "fastify" { interface FastifyRequest { auth?: AuthIdentity } }`
  在 tsx 下不生效，`req.auth` 报类型不存在。
- **根因**：模块增强未被 `tsc` 正确加载（tsx 与 tsc 的模块解析路径不一致）。
- **解决**：改为在请求处理中用显式类型化的局部变量 / 索引访问，不依赖模块增强；
  同时对 `Object.assign(headerObj, ...)` 这类操作显式声明类型。
- **防范**：TypeScript 类型检查以 `npm run typecheck`（tsc --noEmit）为准，
  不要相信"tsx 能跑就算过"。

### P-023　用管道过滤验证命令的输出，把错误截没了

- **现象**：`npm run typecheck 2>&1 | tail -5` 看起来"没有问题"，但完整跑一次却报 5 个 TS 错误
  （`scripts/auth-probe.ts` 里 `string | undefined` 不能赋给 `string | null`）。
- **根因**：`tail -5` 只保留最后 5 行，而 tsc 的错误列表在前面、被截掉；
  本环境 `tail` 还经常不存在（返回空输出），更容易误判成"通过"。
- **解决**：验证类命令**不加任何管道过滤**，直接看完整输出；需要统计条数时用 node 读流计数，
  而不是 `wc`/`head`/`tail`。修复后本例补了 `token ?? null` 归一与 `String(x ?? "")` 守卫。
- **防范**：typecheck / lint / 自检脚本的输出一律完整查看；"看起来通过"不算验证通过。

### P-024　git 命令被中断后 `.git` 写入被回滚，提交对象与 `refs/` 一起丢失

- **现象**：执行 `git rebase -f main --exec "..."` 时命令超时被 SIGTERM 杀掉，
  之后所有 git 命令都报 `fatal: not a git repository`；
  检查发现 `.git/refs/` 目录整体消失，loose 对象从几十个只剩 10 个，
  8 个本地提交里只剩 1 个（`295c8ef0`）能被扫到。
- **根因**：本环境对**被中断（SIGTERM/超时）的命令**会回滚其文件写入。
  rebase 期间 git 写入的新 ref 与新对象一起被回滚到了更早的快照点；
  `refs/` 缺失会让 git 判定整个目录"不是仓库"（即便 `objects/`、`HEAD`、`packed-refs` 都在）。
  这与 P-022（git 建不出嵌套分支 ref）同源：本环境对 `.git` 的写入不保证持久。
- **解决**：
  1. 用 node 直接扫 `objects/` 解压 loose 对象确认哪些提交还活着（不依赖 git 即可读）；
  2. `mkdir .git/refs/heads` + 写回 `refs/heads/main = <已知 hash>` 让仓库重新可用；
  3. **工作区文件始终完好**——历史丢了但内容没丢，把工作区按层重新提交即可完全恢复。
- **防范**：
  - **大批量 git 写入（rebase / filter-branch / 批量 amend）不要放在一条易超时的命令里**；
    必要时拆小，或干脆用"工作区重提"替代历史重写。
  - **及时推远端**：远端是唯一可靠持久化，本地 `.git` 不能当备份。
  - 重写历史前先 `git branch -f <备份名>`，且**确认备份 ref 真的写进 `refs/heads/`**。
  - 日志文件（`git log`）不能作为唯一依据，重要节点把 hash 抄进 `docs/` 台账。

- **2026-10-08 复发（第二次，损失更大）**：提交前端层时 `git commit` 触发
  husky → lint-staged → `eslint --fix ./app/**`，耗时超过前台命令上限被 SIGTERM 杀掉。
  结果不只是本次提交丢了，**此前已成功提交的网关层 commit 对象也一起被回滚**，
  `refs/` 再次整体消失，loose 对象只剩 7 个。
  恢复步骤（比第一次更快，因为有预案）：
  1. 读 `.git/logs/refs/heads/dev-gateway` 拿到最后的 commit hash；
  2. 重建 `refs/heads/` 与 `refs/remotes/origin/`，先全部指向**还在 pack 里的上游 main** `defdcdb5`；
  3. `rm .git/index` + 删除失效的 `objects/info/commit-graphs/*.graph`，再 `git read-tree HEAD` 重建索引；
     直接 `git reset -q HEAD` 会报 `unable to read <missing blob>`，因为旧 index 引用了已消失的 blob；
  4. `git status` 此时会正确只显示"我们的改动 vs 上游 main"，按层重新提交。
- **新增防范（本次血泪）**
  - **慢钩子要么放后台，要么先手动跑一遍**：`eslint --fix ./app/**` 在这个仓库要 7 分钟以上。
    前台跑 `git commit` 必被杀。改用后台执行，或先手动跑 `npx eslint --fix <改动文件>` 让它进入缓存/已修复状态。
  - **提交完立刻 `git log --oneline -1` 复核**，别等下一条命令才发现仓库没了。
  - **尽早推远端**：本环境本地 `.git` 不可靠，远端才是真持久化。

### P-025　新增页面 SSR 崩溃：`Cannot access '__WEBPACK_DEFAULT_EXPORT__' before initialization`

- **现象**：新建 `app/login/page.tsx` 后访问 `/login` 恒返回 **500**，
  服务端日志刷 `ReferenceError: Cannot access '__WEBPACK_DEFAULT_EXPORT__' before initialization`，
  栈是 `login.tsx → ui-lib → locales/index → cn.ts → store/config → utils/store → utils/indexedDB-storage → utils.ts → store/index → store/chat → locales/index`。
- **根因**：App 里存在一条上游就有的循环依赖
  `locales/index → cn.ts → store/config → utils → store/index → store/chat → locales/index`。
  主页之所以从不报错，是因为 `home.tsx` 在 `import Locale from "../locales"` **之前**
  先写了 `import { getCSSVar, useMobileScreen } from "../utils"`，
  把 store/locales 的初始化顺序摆对了。新页面只要 import 顺序不同（先碰 locales），
  `store/chat` 就会在 `locales/index` 初始化完成前读它的默认导出，直接抛错。
- **解决**：新页面在 import UI 组件/locales **之前**先副作用导入 utils，固定初始化顺序：
  ```ts
  import "../utils";          // 必须放在最前，打破 locales ↔ store 的初始化竞争
  import Locale from "../locales";
  ```
- **防范**：新增 `app/**/page.tsx` 时照抄 `home.tsx` 的 import 顺序；
  一旦看到 `__WEBPACK_DEFAULT_EXPORT__` 这类报错，先怀疑 import 顺序，而不是业务代码。

### P-017　端口被上一次的后台进程占用

- **现象**：重启网关报 `EADDRINUSE`，或新代码看起来没生效（请求仍打到旧进程）。
- **根因**：后台启动的网关进程未停止，仍监听 3600。
- **解决**：用 PowerShell 精确定位并杀进程：
  ```powershell
  Get-NetTCPConnection -LocalPort 3600 -State Listen |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force }
  ```
- **防范**：改代码重启网关前，先确认端口归属；后台任务的 task id 要记下来以便停止。

### P-018　better-sqlite3 原生模块安装风险

- **现象**：担心需要本机编译（node-gyp / VS Build Tools），安装失败会卡住整个改动。
- **根因**：better-sqlite3 是原生模块，缺预编译包时需本地编译。
- **解决**：实测 `npm install better-sqlite3` 直接命中 Node 22 预编译包，
  立即用 `new Database(':memory:')` 冒烟验证（SQLite 3.53.4）；同时补装 `@types/better-sqlite3`。
- **防范**：引入原生依赖后**第一时间做冒烟验证**，不要等到写完代码才发现装不上。

---

## 五、仓库与流程类

### P-019　本机 git 身份与 GitHub 账号不一致

- **现象**：`git config --global user.name` 是 `sheep`，但 GitHub 上的 `sheep` 是他人账号，
  名下没有 NextChat fork，无法确定真实仓库地址。
- **根因**：全局 git 用户名是本地设置，与 GitHub 账号无绑定关系。
- **解决**：直接向用户确认，拿到真实地址 `https://github.com/sheep719/NextChat.git` 后再 clone。
- **防范**：涉及远端仓库地址、推送目标等外部操作时，以用户明确提供的信息为准，不从配置推断。

### P-020　`main` 分支会被上游自动覆盖（最危险的一条）

- **现象**：`.github/workflows/sync.yml` 每天 `cron "0 0 * * *"` 把上游
  `ChatGPTNextWeb/ChatGPT-Next-Web` 的 `main` **自动同步到本 fork 的 `main`**，且带 `contents: write`。
- **根因**：fork 开启了自动同步，main 不是"我的分支"。
- **解决**：所有二开改动提交到 `dev/*` / `feat/*`（本项目用 `dev/gateway`），`main` 保持与上游一致。
- **防范**：提交前先 `git branch --show-current` 确认不在 main；需要长期在 main 上改则先禁用 `sync.yml`。

### P-022　带斜杠的分支名建不出来（`dev/gateway` 变 unborn 分支）★ 高危

- **现象**：`git checkout -b dev/gateway` 提示 "Switched to a new branch"，但随后
  `git log` 报 `your current branch 'dev/gateway' does not have any commits yet`；
  `git status` 把**整个仓库 425 个文件都显示成 `A`（新增）**，看着像索引被搞坏了。
- **根因**：本机 git **无法在 `.git/refs/heads/` 下创建子目录**，因此 `refs/heads/dev/gateway`
  这个 ref 根本没落盘；`.git/HEAD` 却已写成 `ref: refs/heads/dev/gateway`，于是 HEAD 指向不存在的 ref
  → 分支"无提交" → 索引里 main 的正常内容被当作"相对空 HEAD 的新增"。
  - 对照验证：`git branch -f devgateway main`（无斜杠）成功且持久；
    `feat/gateway`、`gateway/dev` 同样失败 → **与名字无关，是嵌套 ref 本身建不出来**；
  - 用 node 手工 `mkdir + 写 ref 文件` 可被 git 读到（此时 `git commit` 能成功），
    但下一次 git 写操作后该文件会再次消失 → 不能作为常规方案；
  - PowerShell 下同样失败，不是某个 shell 工具的问题。
- **解决**：改用**扁平分支名** `dev-gateway`（语义不变，git 原生可创建/更新/持久）。
  已产生的提交对象仍有效，用 `git branch -f dev-gateway <sha>` 挂到新分支即可，工作不丢。
- **防范**：
  1. 本仓库一律用扁平分支名（`dev-gateway` / `fix-xxx` / `docs-xxx`），不用 `dev/*` 形式；
  2. 切分支后**必跑 `git log --oneline -1`** 确认有历史，别只看 checkout 的提示；
  3. 若 `git status` 突然把大量文件显示成 `A`，先怀疑 HEAD 指向了不存在的 ref，而不是索引损坏。

### P-021　调试产物散落，容易误提交

- **现象**：排查过程中产生 `probe-result.txt`、`diag-result.txt`、`pid.txt`、`sse-test.txt` 等临时文件。
- **根因**：受 P-002 影响，调试结果必须落盘，导致产物堆积。
- **解决**：`gateway/.gitignore` 增加 `scripts/*.txt`、`data/`、`*.db*`、`.env`、`*.log`；
  每轮改动结束后统一清理，并在提交前用 `git add -A --dry-run` 复核待提交清单。
- **防范**：**提交前必跑 `git add -A --dry-run`**，确认无密钥文件、无数据库文件、无临时产物。

---

## 六、云端同步类（C-008 期间新增）

### P-026　CORS 预检没放行 PUT/DELETE，浏览器静默不发请求 ★ 易误判

- **现象**：`curl` 直接 PUT 快照一切正常，但页面上"云端快照始终为空"，
  Network 面板只有一条 `OPTIONS` 预检，真正的 PUT 根本没发出去，控制台也不报明显错误。
- **根因**：网关只在预检响应里写了 `access-control-allow-methods: GET, POST, OPTIONS`。
  PUT/DELETE 非简单请求，浏览器先发 `OPTIONS`，发现方法不在白名单就直接拦掉，
  且不会在页面 JS 层抛异常——看起来就像"前端没调用"。
- **解决**：预检里把方法补全（含 DELETE，因为端点支持删除快照）：
  ```ts
  reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  ```
- **核验**：`curl -X OPTIONS -i 'http://127.0.0.1:3600/api/sync/state'` 看响应头。
- **防范**：新增非 GET/POST 端点时，同步改 CORS 白名单；
  "curl 通但浏览器不通"第一嫌疑就是 CORS，不要急着改前端逻辑。

### P-027　ChatStore 就地 mutate，`sessions` 引用永远相同，订阅判重失效 ★ 高危

- **现象**：快照能上传一次，之后无论发多少条消息都不再上传；
  用 `state.sessions !== prev.sessions` 判断变更时**恒为 false**。
- **根因**：`app/store/chat.ts` 更新消息时是在原对象/原数组上就地修改
  （`update((state) => { state.sessions[i].messages.push(m) })`），引用没变。
  zustand 的 subscribe 拿到的是同一个引用。
- **解决**：改用**基于内容**的指纹，把 id / lastUpdate / 消息条数 / 正文总长度 / 主题拼成字符串：
  ```ts
  const sig = sessions.map(s =>
    `${s.id}:${s.lastUpdate ?? 0}:${s.messages?.length ?? 0}:${bodyLen}:${s.topic ?? ""}`
  ).join("|");
  ```
  并且订阅时**不做引用比较**，直接 `schedulePush()`，交给 `push()` 内部按指纹去重。
- **防范**：在这个仓库里凡是"判断 sessions 是否变了"，一律比内容，比引用必踩。

### P-028　IndexedDB hydration 竞态：pull 早于 hydration 会双向覆盖

- **现象**：换设备后依然看不到历史，且云端快照被"一条空会话"覆盖掉。
- **根因**：`useChatStore` 用 `persist` + **IndexedDB** 异步恢复。
  若在 hydration 完成前 `pull()`：① `getState().sessions` 还是默认的空会话，
  push 上去就把云端覆盖成空；② 合并写回本地后，紧接着的 hydration
  又用本地旧数据把合并结果覆盖掉。两个方向都被覆盖。
- **解决**：拉之前先等 hydration：
  ```ts
  while (!useChatStore.getState()._hasHydrated) await new Promise(r => setTimeout(r, 100));
  ```
  带 15s 超时兜底，超时则按当前状态继续并打 warn。
- **防范**：任何"读 store → 与远端合并 → 写回"的逻辑，都必须先确认 `_hasHydrated`。

### P-029　新页面 import 顺序（P-025 的同类复发）

- **现象 / 根因 / 解决**：同 P-025。`app/components/login.tsx` 首版先 import 了
  `auth.module.scss` 与 UI 组件，触发 `locales ↔ store` 循环依赖，SSR 500。
  把 `import "../utils";` 提到最前即可。
- **防范**：把这条写进新增页面的模板里，不要凭记忆。

### P-030　合并后停在"新建的空会话"，用户以为没同步过来

- **现象**：E2E 里设备 B 侧边栏明明出现了"2 条对话"的历史会话，
  但主区域空空如也，断言 `found: false`。
- **根因**：合并结果按 `lastUpdate` 倒序，而设备 B **刚创建的空会话时间更新**
  （11:47:12 > 11:46:37），排在第 0 位，`currentSessionIndex` 仍是 0 → 停在空会话。
- **解决**：合并写回时按 id 找回原会话；登录后的首次恢复，若当前选中是空会话
  且存在有内容的会话，则切到最近一条有内容的会话（用 `didInitialSelect` 只做一次，
  避免后续 pull 抢走用户正在看的会话）。
- **防范**："数据到了但页面没变"，先查是不是选中项/索引问题，而不是同步没生效。

### P-031　E2E 用同一 Chrome profile 会串号，必须隔离 BrowserContext

- **现象**：第二轮跑测试，设备 B 一上来就是"已登录"，看不到登录页，断言失败。
- **根因**：同一个 Chrome 用户目录共享 IndexedDB / localStorage，上一轮的登录态还在。
- **解决**：改用 CDP 的 `Target.createBrowserContext` 为每台设备开独立上下文，
  用完 `Target.disposeBrowserContext`。
- **另注**：`agent-browser` CLI 在本机 bash 下不可用（缺 `sed`/`dirname`/`uname`，
  且模块路径解析成 `c:\node_modules\...`），直接用 CDP WebSocket 写脚本最稳；
  浏览器要带 `--remote-debugging-port=9222 --headless=new --no-sandbox
  --proxy-bypass-list="localhost;127.0.0.1"`，否则本机代理会拦 localhost。

## 七、速查表

### P-032　eslint 在 `app/constant.ts` 上崩溃（上游预置问题，与本地改动无关）

- **现象**：对 `app/constant.ts` 跑 `eslint`（无论是否 `--fix`）直接抛
  `TypeError: Cannot read properties of undefined (reading 'loc')`，
  规则 `unused-imports/no-unused-imports`，exit code 2（ESLint 自身崩溃，不是 lint 报错）。
- **定位**：把**上游原版** `constant.ts`（`git show HEAD:app/constant.ts`）落成临时文件再跑，
  **同样崩**——说明是仓库自带的 `eslint@8.49.0` 与 `eslint-plugin-unused-imports`
  的兼容问题，不是我们改出来的。
- **影响**：任何触碰 `constant.ts` 的提交，pre-commit 钩子里的 `eslint --fix` 都会崩。
- **绕过**：提交前手动检查——其余文件 `eslint --fix` + `prettier --write` 全过、
  全项目 `tsc --noEmit` 通过后，经用户确认用 `--no-verify` 提交。
- **根治（待办）**：升级 `eslint-plugin-unused-imports` 或锁 `eslint` 小版本；改动在
  `package.json`，属 L3，动之前先单独验证。

| 症状 | 直接做法 |
|---|---|
| bash 报 `xxx: command not found` | 换 PowerShell 或 `node -e` |
| `node -e` 没输出 | 脚本落文件，结果写 txt 再读 |
| PowerShell 输出乱码/为空 | `*> file` 写盘，node 按 `utf16le` 读 |
| curl 连不上 localhost | 加 `--noproxy "*"` |
| 客户端报 `HPE_UNEXPECTED_CONTENT_LENGTH` | 过滤 `content-length` / `transfer-encoding` / `content-encoding` |
| 流式响应头丢失 | `reply.hijack()` + `raw.writeHead()` + `pipe` |
| hijack 后 CORS 头没了 | 手动把 CORS 头并入 `writeHead` |
| 上游 429 | 换模型 / 等重置 / 用 mock 上游 |
| 端口被占 | PowerShell `Get-NetTCPConnection` + `Stop-Process` |
| 改了代码但行为没变 | 确认旧进程已停、端口归属新进程 |
| 提交前 | `git add -A --dry-run` 复核 + 确认不在 `main` |
| git 报 `not a git repository` | `.git/refs/` 被回滚丢失，重建 `refs/heads` 并写回 ref 文件（P-024） |
| `git ls-remote` 报 `CONNECT tunnel failed 502` | 本机代理拦截，改用 GitHub API `repos/<owner>/<repo>/branches` 核验 |
| curl 能 PUT、浏览器不行 | 补 CORS `access-control-allow-methods`（P-026） |
| 快照只上传一次就不再更新 | 不要比 `sessions` 引用，改比内容指纹（P-027） |
| 换设备后历史"消失"或云端被清空 | pull 前等 `_hasHydrated`（P-028） |
| 新页面 500 `__WEBPACK_DEFAULT_EXPORT__` | 把 `import "../utils"` 放到最前（P-025 / P-029） |
| 侧边栏有历史但主区域空白 | 检查 `currentSessionIndex` 是否停在空会话（P-030） |
| eslint 对 constant.ts 抛 `reading 'loc'` | 上游预置 bug（P-032），用上游原文件可复现；手动检查后 --no-verify |
| git commit 卡在 "Preparing lint-staged..." | 本环境钩子挂死（P-024 复发根因），慢检查手动后台跑 |
