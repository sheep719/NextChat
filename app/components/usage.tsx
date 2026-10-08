"use client";

/**
 * 用量统计面板（改动 3）。
 *
 * 数据来自网关 `/api/usage/*`（服务端按 user_id 隔离，前端只展示自己的）。
 * 图表用 Recharts：按天画输入/输出 token 的堆叠柱状图 + 调用次数折线。
 *
 * 注意：token 可能是估算值（上游没返回 usage 时网关按内容推算）。
 * 面板会在标题下方标注"含 N 条估算"，避免把估算当真实计费。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  CartesianGrid,
  Legend,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import styles from "./usage.module.scss";

import CloseIcon from "../icons/close.svg";
import ResetIcon from "../icons/reload.svg";

import { IconButton } from "./button";
import Locale from "../locales";
import { Path } from "../constant";
import { normalizeBase, useAuthStore } from "../store/auth";

interface DailyItem {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  estimatedCalls: number;
}

interface Bucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  estimatedCalls: number;
}

interface Summary {
  today: Bucket;
  last7Days: Bucket;
  last30Days: Bucket;
  all: Bucket;
}

const EMPTY_BUCKET: Bucket = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  calls: 0,
  estimatedCalls: 0,
};

const RANGES = [7, 30, 90] as const;

function fmt(n: number): string {
  const v = Number(n ?? 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/** 2026-10-08 → 10-08，图表 X 轴用短标签 */
function shortDate(d: string): string {
  return d.length >= 10 ? d.slice(5) : d;
}

export function UsagePage() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const gatewayUrl = useAuthStore((s) => s.gatewayUrl);

  const [days, setDays] = useState<number>(30);
  const [items, setItems] = useState<DailyItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const base = normalizeBase(gatewayUrl);
      const headers = { Authorization: `Bearer ${token}` };
      const [dailyRes, summaryRes] = await Promise.all([
        fetch(`${base}/api/usage/daily?days=${days}`, { headers }),
        fetch(`${base}/api/usage/summary`, { headers }),
      ]);
      if (!dailyRes.ok || !summaryRes.ok) {
        throw new Error(
          `HTTP ${dailyRes.status}/${summaryRes.status}（${Locale.Usage.LoadFailed}）`,
        );
      }
      const dailyJson = await dailyRes.json();
      const summaryJson = await summaryRes.json();
      setItems(dailyJson?.items ?? []);
      setSummary(summaryJson ?? null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [token, gatewayUrl, days]);

  useEffect(() => {
    load();
  }, [load]);

  const chartData = useMemo(
    () =>
      items.map((d) => ({
        ...d,
        label: shortDate(d.date),
      })),
    [items],
  );

  const totalCalls = useMemo(
    () => items.reduce((n, d) => n + (d.calls ?? 0), 0),
    [items],
  );
  const estimatedCalls = useMemo(
    () => items.reduce((n, d) => n + (d.estimatedCalls ?? 0), 0),
    [items],
  );
  const totalTokens = useMemo(
    () => items.reduce((n, d) => n + (d.totalTokens ?? 0), 0),
    [items],
  );

  const today = summary?.today ?? EMPTY_BUCKET;
  const all = summary?.all ?? EMPTY_BUCKET;

  return (
    <>
      <div className="window-header" data-tauri-drag-region>
        <div className="window-header-title">
          <div className="window-header-main-title">{Locale.Usage.Title}</div>
          <div className="window-header-sub-title">{Locale.Usage.SubTitle}</div>
        </div>
        <div className="window-actions">
          <div className="window-action-button">
            <IconButton
              aria={Locale.Usage.Refresh}
              icon={<ResetIcon />}
              onClick={load}
              bordered
            />
          </div>
          <div className="window-action-button">
            <IconButton
              aria={Locale.UI.Close}
              icon={<CloseIcon />}
              onClick={() => navigate(Path.Home)}
              bordered
            />
          </div>
        </div>
      </div>

      <div className={styles["usage"]}>
        {/* 顶部四个卡片：今日 / 近 7 天 / 近 30 天 / 累计 */}
        <div className={styles["cards"]}>
          <div className={styles["card"]}>
            <div className={styles["card-title"]}>{Locale.Usage.Today}</div>
            <div className={styles["card-value"]}>{fmt(today.totalTokens)}</div>
            <div className={styles["card-sub"]}>
              {Locale.Usage.Calls}: {today.calls}
            </div>
          </div>
          <div className={styles["card"]}>
            <div className={styles["card-title"]}>{Locale.Usage.Last7Days}</div>
            <div className={styles["card-value"]}>
              {fmt(summary?.last7Days?.totalTokens ?? 0)}
            </div>
            <div className={styles["card-sub"]}>
              {Locale.Usage.Calls}: {summary?.last7Days?.calls ?? 0}
            </div>
          </div>
          <div className={styles["card"]}>
            <div className={styles["card-title"]}>
              {Locale.Usage.Last30Days}
            </div>
            <div className={styles["card-value"]}>
              {fmt(summary?.last30Days?.totalTokens ?? 0)}
            </div>
            <div className={styles["card-sub"]}>
              {Locale.Usage.Calls}: {summary?.last30Days?.calls ?? 0}
            </div>
          </div>
          <div className={styles["card"]}>
            <div className={styles["card-title"]}>{Locale.Usage.AllTime}</div>
            <div className={styles["card-value"]}>{fmt(all.totalTokens)}</div>
            <div className={styles["card-sub"]}>
              {Locale.Usage.Calls}: {all.calls}
            </div>
          </div>
        </div>

        <div className={styles["panel"]}>
          <div className={styles["panel-head"]}>
            <div className={styles["panel-title"]}>
              {Locale.Usage.DailyTitle}
              <span className={styles["hint"]}>
                {" "}
                · {Locale.Usage.Range}: {days} {Locale.Usage.Days} ·{" "}
                {Locale.Usage.TotalTokens}: {fmt(totalTokens)} ·{" "}
                {Locale.Usage.Calls}: {totalCalls}
              </span>
            </div>
            <div>
              {RANGES.map((d) => (
                <IconButton
                  key={d}
                  text={`${d}${Locale.Usage.Days}`}
                  onClick={() => setDays(d)}
                  bordered={days !== d}
                />
              ))}
            </div>
          </div>

          {error ? (
            <div className={styles["error"]}>{error}</div>
          ) : loading && !items.length ? (
            <div className={styles["empty"]}>{Locale.Usage.Loading}</div>
          ) : !items.length ? (
            <div className={styles["empty"]}>{Locale.Usage.Empty}</div>
          ) : (
            <div className={styles["chart"]}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartData}
                  margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    minTickGap={16}
                  />
                  <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip
                    formatter={(value: any, name: any) => [
                      fmt(Number(value)),
                      String(name),
                    ]}
                    labelFormatter={(label: any) => `${label}`}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar
                    yAxisId="left"
                    dataKey="promptTokens"
                    name={Locale.Usage.PromptTokens}
                    stackId="tokens"
                    fill="#4f8ef7"
                  />
                  <Bar
                    yAxisId="left"
                    dataKey="completionTokens"
                    name={Locale.Usage.CompletionTokens}
                    stackId="tokens"
                    fill="#7bd389"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="calls"
                    name={Locale.Usage.Calls}
                    stroke="#f2a33c"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {estimatedCalls > 0 && (
            <div className={styles["hint"]}>
              {Locale.Usage.EstimatedHint.replace(
                "{{n}}",
                String(estimatedCalls),
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default UsagePage;
