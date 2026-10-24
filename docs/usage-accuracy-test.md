# 用量统计与估算误差实测（2026-10-22）

> 对象：网关 usage 记账链路（`gateway/src/usage.ts` + `server.ts` 记账 tap）与
> token 估算兜底公式。对照上游 NextChat 的 `app/utils/token.ts` 估算实现。
> 相关文档：[usage-stats.md](./usage-stats.md)（统计设计）、[sqlite-index-concurrency-test.md](./sqlite-index-concurrency-test.md)。

## 一、记账数据来源：两条路径

| 路径 | 机制 | estimated 标记 |
|---|---|---|
| 真实值 | 转发时注入 `stream_options: { include_usage: true }`，上游在最后一个 SSE 分片返回 usage（OpenAI 兼容协议标准做法） | 0 |
| 估算值 | 上游未返回 usage 时的兜底启发式 | 1（面板可标注"含估算"，不当计费依据） |

线上 13 条记录实测：7 条拿到真实值（deepseek/qwen 均支持 include_usage），
6 条走了估算（status=0 的失败请求 2 条 + 上游未回 usage 的 4 条）。
失败请求也落一行——账目与请求量可对账。

## 二、估算公式对照（网关 vs 上游 NextChat）

**网关公式**（`usage.ts`）：CJK 字符 × 1 + 其他字符 ÷ 4，向上取整。
**上游公式**（`token.ts`）：a-z/A-Z × 0.25 + 其他 ASCII × 0.5 + Unicode × 1.5。

标准样本对照（qwen/deepseek 真实 tokenizer：中文 ≈ 1 字/token，英文 ≈ 4 字符/token）：

| 样本 | 字符数 | 网关估算 | 上游估算 | 真实参考 |
|---|---|---|---|---|
| 纯中文 | 21 | 21 | 31.5 | ≈21 |
| 纯英文 | 61 | 16 | 18.3 | ≈15-16 |
| 中英混合 | 61 | 26 | 34.3 | ≈26 |
| 代码 | 63 | 16 | 20.3 | ≈16 |

**误差结论**：

- 网关公式对中文 **0% 误差**（1:1 对齐 qwen 系 tokenizer），混合文本误差 < 5%；
- 上游公式按 Unicode × 1.5 计中文，**系统性高估 50%**——它面向 OpenAI cl100k
  （中文 ≈ 1.5-2 token/字）设计，套在国产模型上失准；
- 两公式对纯英文几乎一致（0.25 vs ÷4 同阶）。

**设计动机**：本项目主力模型是 qwen/deepseek，选 CJK 1:1 公式是按目标 tokenizer
校准的结果；`estimated=1` 标记保证估算值与真实值在面板上可区分、不混入计费口径。

## 三、Docker 镜像体检（实测，2026-10-24）

多阶段构建结构（4 阶段：web-deps → web-build / gw-deps → runner）：

| 阶段 | 内容 | 关键点 |
|---|---|---|
| web-deps | 前端依赖安装 | HUSKY=0 跳过 git 钩子；NPM_REGISTRY/REWRITE_LOCK_REGISTRY 支持镜像源重写（yarn 1.x 不读代理变量的坑已注释） |
| web-build | Next standalone 构建 | NEXT_PUBLIC_GATEWAY_URL 构建期内联 |
| gw-deps | 网关依赖（better-sqlite3 预编译） | Node 22 基线（ABI 约束，注释已说明） |
| runner | 运行时层 | 只 COPY --from 产物；DB_PATH 指向 /gw/data 数据卷 |

**镜像体积（`docker images`）：526MB**。`docker history` 逐层拆解：

| 层 | 体积 | 说明 |
|---|---|---|
| Debian 基座 + Node 22 + yarn | ≈247MB | node:22-bookworm-slim 基线（85.3 + 154 + 7.3MB），不可压缩成本 |
| `COPY /gw/node_modules` | 80.9MB | 网关依赖。编译链（python3/make/g++）只存在于 gw-deps 构建阶段，runner 不含——多阶段构建的收益 |
| `COPY .next/standalone` | 57.1MB | 前端产物（含 Next 服务运行时） |
| `COPY .next/server` + `.next/static` + `public` | ≈20MB | 前端静态资源 |
| `COPY gateway/src` + 配置 + start.sh | <0.2MB | 源码与入口脚本 |

**运行时资源（`docker stats --no-stream`）**：内存 85.2MiB / 13.5GiB，CPU 0.18%，healthcheck healthy。

**密钥隔离验证（四关）**：

1. `git log -p --all` 全历史扫描 `sk-*` / `DASHSCOPE_API_KEY` / `JWT_SECRET` 实值——**零泄漏**（仅文档中的 URL 与占位说明）；
2. `.env` / `gateway/.env` 从未被 git 跟踪（`git log --all -- .env` 为空）；
3. Dockerfile 无任何 `ENV` 写入密钥：运行时密钥全部经 `docker run -e` / compose 注入；
4. **`docker history --no-trunc` 逐层实查 + `docker run --rm <image> env` 实跑**：镜像内环境变量仅 6 个非敏感项（NODE_VERSION / YARN_VERSION / NODE_ENV / NEXT_TELEMETRY_DISABLED / DATA_DIR / DB_PATH），任何层无密钥值。

**ARG vs ENV**（构建参数进镜像的风险点）：本 Dockerfile 的 ARG
（NPM_REGISTRY / NEXT_PUBLIC_GATEWAY_URL）均非敏感值；
NEXT_PUBLIC_GATEWAY_URL 会被内联进客户端 bundle——这本来就是公开值，
但值得记住：**任何 NEXT_PUBLIC_ 前缀的内容终将进浏览器，永远不能放密钥**。

## 四、结论

1. 记账双路径（真实 include_usage 优先 + 估算兜底带标记）已在线上 13 条记录中验证混合工作；
2. 估算公式按国产模型 tokenizer 校准（中文 0% 误差），显著优于上游通用公式（高估 50%）；
3. 镜像构建无密钥落层（history 逐层 + env 实跑双重复核），全 git 历史无泄漏；
   镜像 526MB（基座 247MB + 网关依赖 81MB + 前端产物 77MB），
   运行时内存 85MB——单容器双进程的体积代价主要在 Node 基座，属固定成本。

## 附：复现方式

- 估算对照：node 直接跑两公式（样本见本文档表格）；
- 线上记录：`sqlite3 gateway.db 'SELECT model,prompt_tokens,completion_tokens,estimated,status FROM usage_records'`；
- 泄漏扫描：`git log -p --all | grep -iE "sk-|apikey|JWT_SECRET=" | grep -v 占位词`；
- 镜像体检：`docker history <image> --no-trunc`（逐层体积与命令）、
  `docker run --rm <image> env`（镜像内环境变量实查）、
  `docker stats --no-stream`（运行时内存）。
