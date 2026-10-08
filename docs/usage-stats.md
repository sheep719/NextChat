# 用量统计（C-009）

> 目标：**记录每次调用的 token 数，面板能按天展示用量**。
> 本文记录数据来源、流式场景怎么拿到真实 usage、估算兜底规则，以及面板实现与验证。

---

## 一、数据来源：为什么必须做在网关

| 方案 | 问题 |
|---|---|
| 前端自己算 | 换设备/换浏览器就断，且拿不到上游真实 usage |
| 网关记录（选它） | 所有调用必经网关，服务端权威；天然按用户隔离 |

网关在 `/v1/chat/completions` 的转发链路里记账，落 `usage_records` 表。

## 二、token 数怎么来（这是本改动的核心难点）

NextChat **默认走流式 SSE**，而流式时上游默认**不返回 usage**——
不处理的话，记到的全是 0，面板就是一条直线。

### 1. 真实值：注入 `stream_options`

OpenAI 兼容协议的标准开关：

```jsonc
{ "stream": true, "stream_options": { "include_usage": true } }
```

加上后，上游会在**最后一个 SSE 分片**里带一个 `usage`（`choices` 为空）。
网关在转发时自动注入（`USAGE_STREAM_OPTIONS=true`，默认开）。

**兼容性兜底**：少数 provider 不认这个字段会返回 400。
网关检测到响应体里提到 `stream_options` 就**自动去掉重试一次**——可用性优先于统计，
代价是这次调用改走估算。

### 2. 估算兜底

上游没给 usage 时按启发式估算，并置 `estimated=1`：

- **请求侧**：`messages` 正文累加 + 每条 4 token 的结构开销
- **响应侧**：流式时把收到的 `delta.content` 全量累加后估算（比"猜"准得多）
- **估算规则**：CJK 字符按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token

面板会显示"其中 N 条为估算值"，**估算值只作参考，不能当计费依据**。

### 3. 失败调用

上游超时/连接失败也记一行（`status=0`，token 记 0——确实没消耗），
这样"调用次数"口径才准确。

## 三、数据表

```sql
CREATE TABLE IF NOT EXISTS usage_records (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER          REFERENCES users(id) ON DELETE CASCADE,
  client_id         TEXT    NOT NULL DEFAULT '',
  model             TEXT    NOT NULL DEFAULT '',
  provider          TEXT    NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  estimated         INTEGER NOT NULL DEFAULT 0,  -- 1=估算
  stream            INTEGER NOT NULL DEFAULT 0,
  status            INTEGER NOT NULL DEFAULT 0,  -- 上游 HTTP 状态，0=没响应
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_records (user_id, created_at DESC);
```

`user_id` 可为空：网关 API Key（非登录用户）发起的调用记不到具体用户。

## 四、端点（均需登录用户）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/usage/daily?days=30` | 按天聚合（本地时区），**空日期补 0**，前端直接画 |
| GET | `/api/usage/summary` | 今日 / 近 7 天 / 近 30 天 / 累计 四个口径 |
| GET | `/api/usage/recent?limit=20` | 最近原始记录（对账用） |

按天分组用 SQL：

```sql
strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')
```

## 五、前端面板

- 位置：侧边栏新增「用量」入口 → HashRouter 子页 `Path.Usage = "/usage"`
  （与设置页同级，不用新建 Next 路由，也不用重复做登录守卫）
- 图表：**Recharts 3**，`ComposedChart`：
  - 柱状（堆叠）：输入 token + 输出 token
  - 折线（右轴）：调用次数
- 顶部四张卡片：今日 / 近 7 天 / 近 30 天 / 累计
- 范围切换：7 / 30 / 90 天
- 数据获取：直接用 `useAuthStore` 里的 token 打网关 `/api/usage/*`，
  不额外建 store（面板是只读展示，同步语义不复杂）

## 六、验证

### 网关侧（curl + mock 上游，全部通过）

| 场景 | 结果 |
|---|---|
| 非流式 | 真实 usage（上游 JSON 带 usage）→ `estimated=0` |
| 流式 + 注入 `stream_options` | 真实 usage（末尾分片）→ `estimated=0` |
| 流式 + 关掉注入 | 估算兜底 → `estimated=1`，输入按 messages、输出按正文累加 |
| 按天聚合 | 7 天返回 7 条，空日期补 0 |
| 汇总 | 今日/7天/30天/累计 四口径齐全 |
| 用户隔离 | B 用户看不到 A 的数据 |
| 匿名访问 | 401 |

### 前端 E2E（CDP，10/10 通过）

```
PASS  未登录访问主页 → 跳转 /login
PASS  注入登录态后主页可用
PASS  用量页渲染出 Recharts 图表
PASS  图表含柱状（prompt+completion 堆叠）
PASS  图表含调用次数折线
PASS  今日卡片 = 网关 summary.today.totalTokens
PASS  累计卡片 = 网关 summary.all.totalTokens
PASS  默认范围 30 天
PASS  切换到 7 天：范围文案更新且 X 轴回到 10 月区间
PASS  估算提示出现且条数正确
```

面板显示「今日 64 token / 3 次调用 / 其中 1 条为估算」，
与网关 `/api/usage/summary` 完全一致。

## 七、已知限制 / 后续

- **估算不是计费**：只用于看趋势。要精确计费需要上游返回 usage（多数 provider 支持）
- **不是实时**：面板每次打开/点刷新才拉；调用记录在流结束后写入（客户端中断也会记）
- **未做**：按模型拆分、费用估算（需要维护价格表，会过时）
- **未做**：用量配额/限流（有表之后很容易加）
