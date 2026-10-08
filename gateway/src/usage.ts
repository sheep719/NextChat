/**
 * 用量统计（改动 3）。
 *
 * 数据来源：`/v1/chat/completions` 每次调用落一行 `usage_records`。
 *
 * token 数的两种来源
 *   1. **真实值**：上游响应里的 `usage.{prompt_tokens,completion_tokens}`。
 *      流式场景默认拿不到，所以转发时会注入 `stream_options: { include_usage: true }`，
 *      让上游在最后一个 SSE 分片里带上 usage（OpenAI 兼容协议的标准做法）。
 *   2. **估算值**：上游没给 usage 时用启发式——中文按 1 字 ≈ 1 token，
 *      其余按 4 字符 ≈ 1 token，请求侧按 messages 正文累加，响应侧按流式收到的正文累加。
 *      估算结果会置 `estimated=1`，面板上可标注"含估算"，避免把估算当真实计费。
 *
 * 按天聚合在 SQL 里做（本地时区），空日期在 JS 里补零，前端不用自己补。
 */
import { db, nowMs, UsageRow } from "./db.js";

/* ============================ token 估算 ============================ */

/**
 * 粗略估算 token 数：CJK 按 1 字 1 token，其余按 4 字符 1 token。
 * 只用于"上游没返回 usage"时的兑底，不能当计费依据。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // 中日韩统一表意文字 + 假名 + 全角标点
    if (/[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/.test(ch)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/** 估算请求侧 prompt token：正文累加 + 每条消息的结构开销 */
export function estimatePromptTokens(messages: unknown[]): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    const content = (m as any)?.content;
    if (typeof content === "string") {
      total += estimateTokens(content);
    } else if (Array.isArray(content)) {
      // 多模态 content：[{type:'text',text:'...'}, ...]
      for (const part of content) {
        if (typeof part?.text === "string") total += estimateTokens(part.text);
      }
    }
    total += 4; // role / 分隔符号的开销
  }
  return total;
}

/* ============================ 写入 ============================ */

export interface NewUsageInput {
  userId: number | null;
  clientId: string;
  model: string;
  provider: string;
  promptTokens?: number;
  completionTokens?: number;
  estimated?: boolean;
  stream?: boolean;
  status?: number;
  latencyMs?: number;
}

const insertUsage = db.prepare<
  [number | null, string, string, string, number, number, number, number, number, number, number, number]
>(`
  INSERT INTO usage_records
    (user_id, client_id, model, provider,
     prompt_tokens, completion_tokens, total_tokens, estimated,
     stream, status, latency_ms, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function recordUsage(input: NewUsageInput): void {
  const prompt = Math.max(0, Math.round(Number(input.promptTokens ?? 0)));
  const completion = Math.max(0, Math.round(Number(input.completionTokens ?? 0)));
  insertUsage.run(
    input.userId ?? null,
    (input.clientId ?? "").toString().slice(0, 100),
    (input.model ?? "").toString().slice(0, 100),
    (input.provider ?? "").toString().slice(0, 64),
    prompt,
    completion,
    prompt + completion,
    input.estimated ? 1 : 0,
    input.stream ? 1 : 0,
    Number(input.status ?? 0),
    Math.max(0, Math.round(Number(input.latencyMs ?? 0))),
    nowMs(),
  );
}

/* ============================ 查询 ============================ */

export interface DailyUsageItem {
  /** 本地时区的日期，格式 YYYY-MM-DD */
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  /** 当天有多少条是估算值 */
  estimatedCalls: number;
}

const dailyStmt = db.prepare<[number, number]>(`
  SELECT
    strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
    COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
    COALESCE(SUM(completion_tokens), 0) AS completionTokens,
    COALESCE(SUM(total_tokens), 0)      AS totalTokens,
    COUNT(*)                            AS calls,
    COALESCE(SUM(estimated), 0)         AS estimatedCalls
  FROM usage_records
  WHERE user_id = ? AND created_at >= ?
  GROUP BY day
  ORDER BY day ASC
`);

/** 本地时区的日期字符串（YYYY-MM-DD） */
function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 按天聚合（含补零：没有记录的日期也返回 0）。
 * @param days 往前看多少天（含今天）
 */
export function dailyUsage(userId: number, days = 30): DailyUsageItem[] {
  const n = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
  const now = nowMs();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // 往前推 n-1 天（含今天共 n 天）
  const from = start.getTime() - (n - 1) * 24 * 60 * 60 * 1000;

  const rows = dailyStmt.all(userId, from) as (DailyUsageItem & {
    day: string;
  })[];
  const map = new Map<string, DailyUsageItem>();
  for (const r of rows) {
    map.set(r.day, {
      date: r.day,
      promptTokens: Number(r.promptTokens),
      completionTokens: Number(r.completionTokens),
      totalTokens: Number(r.totalTokens),
      calls: Number(r.calls),
      estimatedCalls: Number(r.estimatedCalls),
    });
  }

  const out: DailyUsageItem[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const ts = start.getTime() - i * 24 * 60 * 60 * 1000;
    const key = localDay(ts);
    out.push(
      map.get(key) ?? {
        date: key,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        calls: 0,
        estimatedCalls: 0,
      },
    );
  }
  return out;
}

export interface UsageSummary {
  today: UsageBucket;
  last7Days: UsageBucket;
  last30Days: UsageBucket;
  all: UsageBucket;
}

export interface UsageBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  estimatedCalls: number;
}

const bucketStmt = db.prepare<[number, number]>(`
  SELECT
    COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
    COALESCE(SUM(completion_tokens), 0) AS completionTokens,
    COALESCE(SUM(total_tokens), 0)      AS totalTokens,
    COUNT(*)                            AS calls,
    COALESCE(SUM(estimated), 0)         AS estimatedCalls
  FROM usage_records
  WHERE user_id = ? AND created_at >= ?
`);

const emptyBucket = (): UsageBucket => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  calls: 0,
  estimatedCalls: 0,
});

/** 今日 / 近 7 天 / 近 30 天 / 累计 四个口径的汇总 */
export function usageSummary(userId: number): UsageSummary {
  const now = nowMs();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;

  const pick = (from: number): UsageBucket =>
    (bucketStmt.get(userId, from) as UsageBucket) ?? emptyBucket();

  return {
    today: pick(startOfToday.getTime()),
    last7Days: pick(startOfToday.getTime() - 6 * day),
    last30Days: pick(startOfToday.getTime() - 29 * day),
    all: pick(0),
  };
}

/** 最近若干条原始记录（调试/对账用） */
export function recentUsage(userId: number, limit = 20): UsageRow[] {
  return db
    .prepare(
      `SELECT * FROM usage_records WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(limit, 1), 200)) as UsageRow[];
}
