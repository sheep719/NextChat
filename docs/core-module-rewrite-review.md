# 核心模块重写演练：与生产实现的偏差分析

## 背景与目的

为验证对网关核心路径的理解是否达到"可脱离参考实现独立重建"的程度，做了一轮重写演练：不看 `gateway/src` 对应实现，只凭接口约定和需求描述重写四个模块，用预先写好的验收测试驱动；全部通过后再与生产实现逐段 diff，记录偏差。

演练暴露的差距集中在**踩坑后才补的设计细节**上——这正是本次演练的目的：找出理解盲区，而不是复刻代码。理解完整度的判据很简单：没踩过坑的细节最容易丢。

## 演练范围与结果

| 模块 | 参考实现 | 验收项 | 结果 |
|---|---|---|---|
| 口令哈希 + JWT 签发/校验 | `gateway/src/auth.ts` | 11 | 11/11 |
| 多模型路由 | `gateway/src/config.ts` | 8 | 8/8 |
| SSE 流式转发 | `gateway/src/server.ts`（hijack 段） | 4 | 4/4 |
| SQLite schema | `gateway/src/db.ts` | 13 | 13/13 |

演练文件位于 `scratch/`（不入库），验收测试与实现同文件，`node scratch/<file>.mjs` 可重复执行。

---

## 1. 口令哈希 + JWT（vs auth.ts）

**重写内容**：scryptSync 加盐哈希、timingSafeEqual 定长比较、dummy 哈希防账号枚举、JWT 三段签发（HS256，签名覆盖前两段整体）、校验链（alg 白名单先于验签、exp 检查）。

**与生产实现一致的关键点**：

- 盐每用户独立随机生成，不共享
- 用户不存在时跑一次同等开销的 dummy 哈希，抹平"用户不存在秒回 / 密码错误等哈希"的响应时间差
- 算法白名单校验先于验签——若按客户端声明的 alg 验签，`alg:none` 变体就进门了
- 签名比较走 timingSafeEqual，先比长度再定长比较

**已知设计差距（重写版未覆盖，生产实现有）**：

1. **safeEqual 的 sha256 前置**：`timingSafeEqual` 要求等长 buffer，长度不等直接抛异常。生产实现对两侧先做一次 sha256 摘要再比较——把任意长度输入规整为定长，长度差异也走恒定时间路径，还顺手吞掉了比较异常。
2. **nbf + 时钟偏差容忍**：payload 校验含 not-before 检查并留 CLOCK_SKEW 余量——多实例部署时各机时钟不可能完全对齐。
3. **fail-closed 落在配置层**：`assertAuthConfigured` 在进程启动时拒绝缺 JWT_SECRET 的服务起起来，而不是等运行时每个请求判空——错误配置应该在启动瞬间炸掉，不是在第一笔流量上。

> **批注（演练者补）**：＿＿＿

---

## 2. 多模型路由（vs config.ts）

**重写内容**：`resolveProvider(model)`（精确匹配 → 前缀匹配 → null）+ `buildUpstreamUrl(provider)`（尾斜杠容错）。

**与生产实现逐行等价的部分**：

- 匹配顺序：`models.includes` 精确优先，`modelPrefixes.some` 前缀兜底，均不中返回 null。精确优先就是防前缀"抢道"——`deepseek-reasoner` 这类精确命中的模型不该被别家前缀截走
- 入参 trim + 空串短路返回 null
- `baseUrl.replace(/\/$/, "")` 去尾斜杠后拼 chatPath——与 server.ts L875 拼接处写法一致
- 前缀用 `.some()` 遍历数组，天然支持多前缀配置（生产配置如 `["qwen2", "qwen2.5", "qwen3", "qvq"]`）

**调用方职责（重写范围外，生产实现 server.ts 有）**：

- 路由不中回 404 错误体 `{ code: "model_not_found", message: '... See GET /v1/models' }`——错误信息带上模型清单入口，调用方可自助排障，不用翻日志猜
- 路由命中后还有两道闸：`assertModelAllowed`（JWT 声明里的模型/provider 白名单）和 apiKey 空检查（503 `provider_not_configured`，报错里直接写明缺哪个环境变量）

> **批注（演练者补）**：＿＿＿

---

## 3. SSE 流式转发（vs server.ts hijack 段）★ 本轮最有价值的差距

**重写内容**：data 帧透传、end 正常收尾并卸监听、客户端提前断开 → `upstream.destroy()` 停止消费剩余帧。

**验收两场景通过**：

- 客户端全程在线：10/10 帧送达，上游未被销毁
- 客户端第 3 帧后断开：上游销毁且停发（不再消费剩余 7 帧），客户端不再收帧

**关键差距——提前断开的清理是四件事，重写版只做了一件**。生产实现（server.ts L1001-1006）：

```ts
const onEarlyClose = () => {
  finish(null, "");      // ① 记账：usage 落库（拿不到真实值就估算兜底）
  clearTimeout(timer);   // ② 摘掉上游超时定时器
  source.destroy();      // ③ 断管道：停止消费上游流
  controller.abort();    // ④ fetch 侧兜底终止
};
```

重写版只复现了 ③。漏掉的三件里最要命的是 ①：

- **不记账的后果**：客户端中途关页面是常态（觉得卡、误触刷新），这类请求的 token 消耗真实发生在上游，但 usage_records 一条没有——账实不符，成本统计失真。所以 finish 放在清理链第一件事的位置
- ② 定时器挂在事件循环上直到超时才摘，属轻微泄漏；流程已终止后让超时回调再跑一次毫无意义
- ③ 与 ④ 是双保险：`destroy()` 断 Readable 管道，`controller.abort()` 直接终止 fetch 侧连接，两个层面都关死

**重写版做对的部分**：正常收尾后卸掉 close 监听（对应生产实现的 `reply.raw.off("close", onEarlyClose)`），防止 end 之后客户端 close 再触发一次销毁逻辑；`recorded` 标志防重复记账与重写版的 cleanup-once 思路等价。

**差距成因**：生产实现的四件套不是一次写对的——最初只有管道透传；排障发现客户端断开后上游仍在消费（管道泄漏），补 destroy；又发现断开的请求一条账都没记，补 finish；再补 timer 清理。重写时凭最终形态的记忆只锚定了 destroy——**destroy 是理解锚点，记账和定时器是踩坑后才知道的**。这正好验证了重写演练的价值：没踩过坑的细节最容易丢。

> **批注（演练者补）**：＿＿＿

---

## 4. SQLite schema（vs db.ts）

**重写内容**：conversations 建表、列表页复合索引、近 7 天每日聚合查询。

**与生产实现一致**：

- 复合索引 `(user_id, updated_at DESC)`——第二列方向对齐 ORDER BY，查询免排序（EXPLAIN 验证无 TEMP B-TREE；该索引在 100 万行数据集上把列表查询从 442.8ms 压到 0.007ms，见 `sqlite-index-concurrency-test.md`）
- 外键 `REFERENCES users(id) ON DELETE CASCADE`、uuid 带 UNIQUE

**与上一轮重写（10-22）相比的进步**：

- 聚合查询双参数化：`WHERE conversations.user_id = ? AND messages.created_at >= ?`——上一轮时间下限是内嵌表达式，这一轮全部走占位符。参数化是防注入底线，也让执行计划可复用

**仍缺（生产实现有，重写版漏）**：

- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`：进程每次启动都执行建表语句，幂等是"启动即迁移"模式的前提
- messages 表的 `UNIQUE (conversation_id, seq)`：应用层保证消息顺序，但唯一约束是数据库层的最后防线——重放或并发写入乱序时靠它兜底
- title/model/provider 生产实现是 `NOT NULL DEFAULT ''`，重写版只写了 `DEFAULT ''`（缺 NOT NULL，NULL 仍可显式插入）

> **批注（演练者补）**：＿＿＿

---

## 结论与行动项

**理解完整度**：四个模块的核心逻辑（哈希链路安全顺序、匹配优先级、管道清理、索引设计）均可脱离参考实现重建；差距集中在踩坑后才补的设计细节（提前断开记账、幂等建表、唯一约束兜底）——重写演练的目的正在于此。

**行动项**：

- [ ] SSE 提前断开清理需覆盖全四步：记账 → 摘定时器 → 断管道 → abort（本轮重写只写出 destroy）
- [ ] schema 重写补 `IF NOT EXISTS` 与 `UNIQUE (conversation_id, seq)`
- [ ] 路由 404 错误体带 `See GET /v1/models` 指引——错误信息可自助排障，是可用性的分水岭
