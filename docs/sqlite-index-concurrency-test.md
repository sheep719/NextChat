# SQLite 索引与并发实测（2026-10-22）

> 对象：网关数据层（better-sqlite3，`gateway/src/db.ts`）。
> 方法：副本库上造数对比索引前后的查询计划（EXPLAIN QUERY PLAN）与耗时；
> 双进程并发写验证 WAL 行为。实验脚本不入仓（本地 scratch）。
> 相关文档：[schema.md](./schema.md)（表结构）、[frontend-cloud-sync.md](./frontend-cloud-sync.md)（同步层）。

## 一、线上库现状（实验前侦察）

- `journal_mode = wal`（`db.ts` 启动即设，一直生效）
- 二级索引 4 个：`idx_conversations_user (user_id, updated_at DESC)`、
  `idx_messages_conv (conversation_id, seq)`、`idx_usage_user_time`、`idx_usage_time`
- 真实查询计划抽查：会话列表查询走 `SEARCH ... USING INDEX`；
  **usage 按 model 聚合是 `SCAN` + `USE TEMP B-TREE`**（全表扫描，见第四节）
- 观察到 `gateway.db-wal` 达 1.2MB 未 checkpoint（主库仅 4KB）——WAL 合并时机见第五节

## 二、索引收益实测（100 万行宽表，行含 200 字节 payload）

| 查询 | 无索引计划 | 有索引计划 | 无索引耗时 | 有索引耗时 | 提速 |
|---|---|---|---|---|---|
| `WHERE user_id = 7`（命中 ~4.2 万行） | `SCAN conversations` | `SEARCH USING INDEX idx_conv_user` | 0.029 ms | 0.006 ms | **4.7×** |
| 同上 + `ORDER BY updated_at DESC` | `SCAN` + `USE TEMP B-TREE FOR ORDER BY` | `SEARCH USING INDEX`（索引序即结果序） | **442.8 ms** | **0.007 ms** | **62212×** |

**核心结论**：

1. **索引的第一杀手锏是免排序，不是免扫描**。`ORDER BY` 场景 442ms→0.007ms（6 万倍），
   远大于纯过滤场景的 4.7 倍——复合索引 `(user_id, updated_at DESC)` 的第二列
   让结果天然按序产出，直接消灭 TEMP B-TREE 排序。这就是列表页
   "按用户取会话按时间倒序"查询的理想索引形态。
2. **小表上索引可能负优化**（1 万行实测 0.005→0.010ms，反而慢一倍）：
   索引查找要"查 B 树 → 回表取整行"，小数据量下全表扫描更快。
   当前线上库（1 条会话）加索引的收益为零——索引是为数据增长预留的。
3. **EXPLAIN QUERY PLAN 是唯一事实**：判断"索引是否生效"不看代码看计划——
   `SCAN`（全表）vs `SEARCH ... USING INDEX`（走索引）。

## 三、复合索引最左前缀（实测）

`idx_conv_user (user_id, updated_at)` 上只按 `updated_at` 查询（跳过 user_id）：

```
计划: SCAN conversations   ← 索引失效，退化为全表扫描
```

B+ 树按第一列有序、第二列仅在同组内有序——跳过最左列无法定位。
对应网关真实约束：所有会话 SQL 都强制带 `user_id`（既是安全边界，
也恰好是索引最左列，安全设计与索引设计天然对齐）。

## 四、已识别的优化点：usage 聚合全表扫描

线上真实查询计划：

```
EXPLAIN QUERY PLAN SELECT model, COUNT(*) FROM usage_records GROUP BY model
→ SCAN usage_records | USE TEMP B-TREE FOR GROUP BY
```

副本库 1 万行实测：加 `idx_usage_model(model)` 后 1.410ms → 0.328ms（4.3×），
且 `TEMP B-TREE` 消失（索引序即分组序）。

**决策：暂不加**。当前 13 行数据、统计接口每日聚合一次，1ms 级全表扫描
毫无瓶颈；等 usage 过万行再补（写入路径每行多维护一个索引也是成本）。
这是"为已知问题保留优化路径，但不提前优化"的取舍。

## 五、WAL 并发写实测

双进程（`spawn` 同起）各写 500 行进同一表，事务包裹：

| 指标 | 结果 |
|---|---|
| 进程 A | 500 行 / 3ms / 0 次 SQLITE_BUSY |
| 进程 B | 500 行 / 2ms / 0 次 SQLITE_BUSY |
| 最终校验 | 1000 行整，A/B 各 500，无丢失 |

**机制**：WAL 模式下写写互斥但由 SQLite 内部排队（better-sqlite3 同步 API
天然串行化提交），读不阻塞写、写不阻塞读。`delete` journal 模式下同样的
并发会直接抛 `SQLITE_BUSY`（写锁独占）。

**WAL 文件增长**：写操作先进 `-wal` 文件，checkpoint 时才合并回主库。
默认策略 1000 页自动触发；观测到本库 `-wal` 1.2MB 未合并属正常范围
（下次写连接关闭或达到阈值自动 checkpoint，也可 `PRAGMA wal_checkpoint(TRUNCATE)` 手动触发）。

## 六、结论

1. 索引收益随数据规模与查询形态分化：过滤 4.7×，**免排序 6 万倍**——
   `ORDER BY` 列进复合索引是收益最大的设计；
2. 最左前缀必须与查询谓词对齐（本项目安全边界 `user_id` 恰为最左列）；
3. WAL 下 better-sqlite3 多进程并发写零冲突（1000/1000 行，0 BUSY）；
4. usage 聚合的 SCAN 已识别、有量化优化路径（4.3×），按需启用。

## 附：复现参数

- 造数：100 万行 `WITH RECURSIVE`（3.4s）或逐行 `INSERT` 事务包裹（10 万行 190ms）
- 计时：预热 1 次 + 50~200 次均值（`process.hrtime.bigint`）
- 环境：Windows 11 / Node 22.22.2 / better-sqlite3 13.x / AMD 8845H
