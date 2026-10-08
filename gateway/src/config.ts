/**
 * 网关配置：provider 注册表 + 模型路由表。
 *
 * 路由策略（按顺序）：
 *   1. 精确匹配：model 名在 provider.models 中
 *   2. 前缀匹配：model 名以 provider.modelPrefixes 中任一前缀开头
 *
 * 所有 provider 均要求 OpenAI 兼容接口（POST {baseUrl}/chat/completions）。
 */
import { loadEnv } from "./env.js";

loadEnv();

export interface ProviderConfig {
  /** provider 标识（展示用） */
  name: string;
  /** OpenAI 兼容 base，如 https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseUrl: string;
  /** 上游真实 API key（转发时替换 Authorization） */
  apiKey: string;
  /** chat completions 路径，默认 /chat/completions */
  chatPath: string;
  /** 精确模型名列表 */
  models: string[];
  /** 模型名前缀匹配 */
  modelPrefixes: string[];
}

function str(v: string | undefined, fallback = ""): string {
  return v === undefined ? fallback : v.trim();
}

export const PORT = Number(process.env.PORT || 3600);
export const HOST = str(process.env.HOST, "127.0.0.1");

function bool(v: string | undefined, fallback = false): boolean {
  const s = str(v).toLowerCase();
  if (!s) return fallback;
  return ["1", "true", "yes", "on"].includes(s);
}

/** 聊天接口是否要求"必须是登录用户"（typ=user 的 JWT）。默认 true */
export const CHAT_REQUIRE_USER = bool(process.env.CHAT_REQUIRE_USER, true);

/** 是否开放注册。关闭后只能通过已有账号/直接写库新增用户 */
export const REGISTRATION_ENABLED = bool(process.env.REGISTRATION_ENABLED, true);

/**
 * 允许跨域访问的来源白名单（NextChat 以「自定义 endpoint」直连网关时是浏览器发起的跨域请求）。
 * 逗号分隔，填 `*` 表示允许任意来源（仅建议本地调试）。
 */
export const CORS_ALLOWED_ORIGINS: string[] = str(
  process.env.GATEWAY_CORS_ORIGINS,
  "http://localhost:3000,http://127.0.0.1:3000",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 上游转发超时（毫秒），流式期间为整体超时 */
export const UPSTREAM_TIMEOUT_MS = Number(
  process.env.UPSTREAM_TIMEOUT_MS || 10 * 60 * 1000,
);

/**
 * provider 注册表 —— 新增一家只需在此追加一项 + .env 加 key。
 */
export const providers: ProviderConfig[] = [
  {
    name: "alibaba",
    baseUrl: str(
      process.env.ALIBABA_BASE_URL,
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ),
    apiKey: str(process.env.ALIBABA_API_KEY),
    chatPath: "/chat/completions",
    models: ["qwen-plus", "qwen-turbo", "qwen-max", "qwen-long"],
    modelPrefixes: ["qwen2", "qwen2.5", "qwen3", "qvq"],
  },
  {
    name: "deepseek",
    baseUrl: str(process.env.DEEPSEEK_BASE_URL, "https://api.deepseek.com/v1"),
    apiKey: str(process.env.DEEPSEEK_API_KEY),
    chatPath: "/chat/completions",
    models: ["deepseek-chat", "deepseek-reasoner"],
    modelPrefixes: [],
  },
  {
    name: "zhipu",
    baseUrl: str(process.env.ZHIPU_BASE_URL, "https://open.bigmodel.cn/api/paas/v4"),
    apiKey: str(process.env.ZHIPU_API_KEY),
    chatPath: "/chat/completions",
    models: [],
    modelPrefixes: ["glm-4", "glm-4.5", "glm-4.6"],
  },
];

/**
 * 模型名 → provider 路由解析。
 * @returns 命中的 provider；未命中返回 null
 */
export function resolveProvider(model: string): ProviderConfig | null {
  const m = (model || "").trim();
  if (!m) return null;

  // 1. 精确匹配
  const exact = providers.find((p) => p.models.includes(m));
  if (exact) return exact;

  // 2. 前缀匹配
  const byPrefix = providers.find((p) =>
    p.modelPrefixes.some((prefix) => m.startsWith(prefix)),
  );
  if (byPrefix) return byPrefix;

  return null;
}

/** 汇总所有 provider 的模型清单（供 GET /v1/models） */
export function listModels(): { id: string; provider: string; ready: boolean }[] {
  const out: { id: string; provider: string; ready: boolean }[] = [];
  for (const p of providers) {
    const ready = p.apiKey.length > 0;
    for (const m of p.models) out.push({ id: m, provider: p.name, ready });
    if (p.models.length === 0) {
      // 无精确模型列表时，至少暴露 provider 占位说明
      out.push({
        id: `(${p.name}: 前缀匹配 ${p.modelPrefixes.join("/")})`,
        provider: p.name,
        ready,
      });
    }
  }
  return out;
}
