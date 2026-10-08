/**
 * 网关统一鉴权模块：API Key / JWT(HS256)。
 *
 * 设计要点
 * 1. 单一入口 `authenticate(headers)`：所有受保护端点只调这一处，未授权请求一律 401/403。
 * 2. 双凭证并行：
 *    - API Key：静态长密钥，适合服务端 / 本机客户端长期持有；
 *    - JWT：由 API Key 换取（POST /v1/auth/token）或离线签发，带 exp / scope / models / providers，
 *      适合下发给浏览器端（可设短 TTL、可限模型）。
 * 3. 失败即关闭（fail-closed）：未配置任何凭证且未显式开启 ALLOW_ANONYMOUS 时，网关拒绝启动，
 *    避免出现"没配 key 就全放行"的裸奔状态。
 * 4. 零依赖：JWT 用 node:crypto 的 HMAC 实现，不引入 jsonwebtoken 等包。
 */
import crypto from "node:crypto";
import { loadEnv } from "./env.js";

loadEnv();

/* ================================ 类型 ================================ */

export type AuthMode = "apikey" | "jwt" | "both";
export type AuthType = "apikey" | "jwt" | "anonymous";

/**
 * 调用方类别：
 * - `user`：登录用户（JWT 带 typ=user，由 /api/auth/login 签发）
 * - `client`：服务端/网关客户端（API Key 或普通 JWT）
 * - `anonymous`：显式开启 ALLOW_ANONYMOUS 后的匿名访问
 */
export type IdentityKind = "user" | "client" | "anonymous";

export interface AuthIdentity {
  /** 调用方标识，用于日志与限流分桶 */
  clientId: string;
  authType: AuthType;
  /** 是登录用户还是服务端客户端——聊天接口据此要求"必须登录" */
  kind: IdentityKind;
  /** 登录用户 ID（仅 kind=user 时有值） */
  userId?: number;
  /** null = 未声明 scope，放行全部；否则需在列表内 */
  scopes: string[] | null;
  /** null = 不限模型；元素支持 `qwen-*` 前缀通配 */
  allowedModels: string[] | null;
  /** null = 不限 provider */
  allowedProviders: string[] | null;
  /** JWT 过期时间（秒），API Key 为 undefined */
  exp?: number;
}

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/* ============================== 配置读取 ============================== */

function str(v: string | undefined, fallback = ""): string {
  return v === undefined ? fallback : v.trim();
}

function bool(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(str(v).toLowerCase());
}

/** apikey / jwt / both —— 决定接受哪种凭证 */
export const AUTH_MODE: AuthMode = (() => {
  const m = str(process.env.AUTH_MODE, "both").toLowerCase();
  return (["apikey", "jwt", "both"] as const).includes(m as AuthMode)
    ? (m as AuthMode)
    : "both";
})();

/** 显式开启才允许匿名访问；默认 false（未授权必拒绝） */
export const ALLOW_ANONYMOUS = bool(process.env.ALLOW_ANONYMOUS);

export const JWT_SECRET = str(process.env.JWT_SECRET);
export const JWT_ISSUER = str(process.env.JWT_ISSUER);
export const JWT_AUDIENCE = str(process.env.JWT_AUDIENCE);
export const JWT_ALGS: string[] = (() => {
  const list = str(process.env.JWT_ALGS, "HS256")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return list.length ? list : ["HS256"];
})();
export const JWT_DEFAULT_TTL_SEC = Number(
  process.env.JWT_DEFAULT_TTL_SEC || 3600,
);
/** 签发上限，防止下发永久令牌 */
export const JWT_MAX_TTL_SEC = Number(
  process.env.JWT_MAX_TTL_SEC || 12 * 3600,
);
export const JWT_CLOCK_SKEW_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || 60);

/* ============================ API Key 注册表 ============================ */

export interface ApiKeyEntry {
  key: string;
  clientId: string;
}

/**
 * 解析 `GATEWAY_API_KEYS`（推荐，逗号分隔）与旧变量 `GATEWAY_API_KEY`（兼容保留）。
 * 每条格式：`key` 或 `key:clientId`。
 */
function parseApiKeys(raw: string): ApiKeyEntry[] {
  const out: ApiKeyEntry[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const seg = part.trim();
    if (!seg) continue;
    const idx = seg.indexOf(":");
    const key = idx > 0 ? seg.slice(0, idx).trim() : seg;
    const clientId = idx > 0 ? seg.slice(idx + 1).trim() : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, clientId: clientId || `key-${maskSecret(key, 4)}` });
  }
  return out;
}

export const apiKeys: ApiKeyEntry[] = parseApiKeys(
  [str(process.env.GATEWAY_API_KEYS), str(process.env.GATEWAY_API_KEY)]
    .filter(Boolean)
    .join(","),
);

/* ============================== 能力开关 ============================== */

export const apiKeyEnabled = AUTH_MODE !== "jwt";
export const jwtEnabled = AUTH_MODE !== "apikey" && JWT_SECRET.length > 0;
export const hasAnyCredential = (apiKeyEnabled && apiKeys.length > 0) || jwtEnabled;

/**
 * 启动自检：没有任何凭证且未显式开启匿名 → 拒绝启动（fail-closed）。
 * 这样"未授权请求被拒绝"是默认状态，而不是靠人记得配 key。
 */
export function assertAuthConfigured(): void {
  if (hasAnyCredential || ALLOW_ANONYMOUS) return;
  throw new Error(
    [
      "网关未配置任何访问凭证，拒绝以保证安全（fail-closed）。",
      "请在 gateway/.env 中至少配置一项：",
      "  GATEWAY_API_KEYS=<key>[:clientId][,<key2>:<clientId2>]",
      "  JWT_SECRET=<随机长字符串>",
      "确为本地调试时可显式放行：ALLOW_ANONYMOUS=true",
    ].join("\n"),
  );
}

/* ================================ 工具 ================================ */

export function maskSecret(s: string, keep = 4): string {
  if (!s) return "";
  if (s.length <= keep * 2) return "*".repeat(s.length);
  return `${s.slice(0, keep)}${"*".repeat(Math.min(8, s.length - keep * 2))}${s.slice(-keep)}`;
}

/** 定长比较，避免时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

const ALG_TO_NODE: Record<string, string> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
};

function clampTtl(ttlSec: number): number {
  const n = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : JWT_DEFAULT_TTL_SEC;
  return Math.min(Math.max(n, 60), JWT_MAX_TTL_SEC);
}

/** 匹配白名单：支持 `*` 全通、精确值、`abc*` 前缀通配 */
function matchWildcard(list: string[], value: string): boolean {
  return list.some(
    (p) => p === "*" || p === value || (p.endsWith("*") && value.startsWith(p.slice(0, -1))),
  );
}

/* ================================ 凭证 ================================ */

/** 从 Authorization: Bearer 或 X-Api-Key 中取出凭证 */
export function extractCredential(headers: Record<string, unknown>): string | null {
  const auth = String(headers?.["authorization"] ?? "").trim();
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
  }
  const xKey = String(headers?.["x-api-key"] ?? "").trim();
  return xKey || null;
}

function isJwtShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/.test(token);
}

export function matchApiKey(token: string): ApiKeyEntry | null {
  for (const entry of apiKeys) {
    if (safeEqual(entry.key, token)) return entry;
  }
  return null;
}

/* ============================== JWT 签发 ============================== */

export interface SignJwtInput {
  sub: string;
  ttlSec?: number;
  scope?: string[] | string;
  models?: string[];
  providers?: string[];
  /** 令牌类别，写入 `typ` claim；"user" 表示登录用户 */
  typ?: string;
  /** 附加 claim（如 uid / username），不会覆盖 exp/iat/sub 等核心字段 */
  extra?: Record<string, unknown>;
}

export function signJwt(input: SignJwtInput): { token: string; expiresIn: number; exp: number } {
  if (!JWT_SECRET) {
    throw new AuthError(500, "jwt_not_configured", "JWT_SECRET 未配置，无法签发令牌");
  }
  const alg = JWT_ALGS.find((a) => ALG_TO_NODE[a]) ?? "HS256";
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = clampTtl(input.ttlSec ?? JWT_DEFAULT_TTL_SEC);
  const exp = now + expiresIn;

  const scope = Array.isArray(input.scope)
    ? input.scope
    : typeof input.scope === "string"
      ? input.scope.split(/[\s,]+/).filter(Boolean)
      : undefined;

  const payload: Record<string, unknown> = {};
  // 先放附加 claim，再放核心字段，避免 extra 覆盖 sub/exp 等关键声明
  if (input.extra) Object.assign(payload, input.extra);
  Object.assign(payload, { sub: input.sub, iat: now, nbf: now, exp });
  if (input.typ) payload["typ"] = input.typ;
  if (JWT_ISSUER) payload["iss"] = JWT_ISSUER;
  if (JWT_AUDIENCE) payload["aud"] = JWT_AUDIENCE;
  if (scope && scope.length) payload["scope"] = scope.join(" ");
  if (input.models?.length) payload["models"] = input.models;
  if (input.providers?.length) payload["providers"] = input.providers;

  const head = b64urlEncode(JSON.stringify({ alg, typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(
    crypto.createHmac(ALG_TO_NODE[alg], JWT_SECRET).update(`${head}.${body}`).digest(),
  );

  return { token: `${head}.${body}.${sig}`, expiresIn, exp };
}

/* ============================== JWT 校验 ============================== */

function toClaimList(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string") return v.split(/[\s,]+/).filter(Boolean);
  return null;
}

export function verifyJwt(token: string): AuthIdentity {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthError(401, "invalid_token", "Malformed JWT");
  }
  const [head, body, sig] = parts;

  let header: { alg?: string };
  try {
    header = JSON.parse(b64urlDecode(head).toString("utf8"));
  } catch {
    throw new AuthError(401, "invalid_token", "Malformed JWT header");
  }
  const alg = String(header?.alg ?? "");
  if (!JWT_ALGS.includes(alg) || !ALG_TO_NODE[alg]) {
    throw new AuthError(401, "invalid_token", `Unsupported JWT alg "${alg || "?"}"`);
  }

  const expected = b64urlEncode(
    crypto.createHmac(ALG_TO_NODE[alg], JWT_SECRET).update(`${head}.${body}`).digest(),
  );
  if (!safeEqual(expected, sig)) {
    throw new AuthError(401, "invalid_token", "JWT signature verification failed");
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    throw new AuthError(401, "invalid_token", "Malformed JWT payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload["exp"] === "number" && now > payload["exp"] + JWT_CLOCK_SKEW_SEC) {
    throw new AuthError(401, "token_expired", "JWT has expired");
  }
  if (typeof payload["nbf"] === "number" && now < payload["nbf"] - JWT_CLOCK_SKEW_SEC) {
    throw new AuthError(401, "invalid_token", "JWT not valid yet");
  }
  if (JWT_ISSUER && payload["iss"] !== JWT_ISSUER) {
    throw new AuthError(401, "invalid_token", "JWT issuer mismatch");
  }
  if (JWT_AUDIENCE) {
    const aud = payload["aud"];
    const ok = Array.isArray(aud) ? aud.includes(JWT_AUDIENCE) : aud === JWT_AUDIENCE;
    if (!ok) throw new AuthError(401, "invalid_token", "JWT audience mismatch");
  }

  const sub = typeof payload["sub"] === "string" && payload["sub"] ? payload["sub"] : "";
  const isUser = payload["typ"] === "user";
  return {
    clientId: sub || `jwt-${maskSecret(body, 6)}`,
    authType: "jwt",
    kind: isUser ? "user" : "client",
    userId: typeof payload["uid"] === "number" ? payload["uid"] : undefined,
    scopes: toClaimList(payload["scope"]),
    allowedModels: toClaimList(payload["models"]),
    allowedProviders: toClaimList(payload["providers"]),
    exp: typeof payload["exp"] === "number" ? payload["exp"] : undefined,
  };
}

/* ============================== 统一入口 ============================== */

const ANONYMOUS_IDENTITY: AuthIdentity = {
  clientId: "anonymous",
  authType: "anonymous",
  kind: "anonymous",
  scopes: null,
  allowedModels: null,
  allowedProviders: null,
};

/** API Key 换来的身份（服务端/网关客户端，非登录用户） */
function clientIdentity(clientId: string): AuthIdentity {
  return {
    clientId,
    authType: "apikey",
    kind: "client",
    scopes: null,
    allowedModels: null,
    allowedProviders: null,
  };
}

/**
 * 校验请求凭证。
 * @param opts.requireApiKey 为 true 时只接受 API Key（用于签发令牌的端点，
 *        避免 JWT 自我续签造成永久凭证）。
 */
export function authenticate(
  headers: Record<string, unknown>,
  opts: { requireApiKey?: boolean } = {},
): AuthIdentity {
  const token = extractCredential(headers);

  if (!token) {
    if (ALLOW_ANONYMOUS && !opts.requireApiKey) return { ...ANONYMOUS_IDENTITY };
    throw new AuthError(
      401,
      "missing_credentials",
      "Missing credentials. Send `Authorization: Bearer <API key or JWT>`.",
    );
  }

  // 令牌签发端点：只认 API Key
  if (opts.requireApiKey) {
    if (!apiKeyEnabled) {
      throw new AuthError(401, "apikey_not_enabled", "AUTH_MODE=jwt，不接受 API Key 凭证");
    }
    const entry = matchApiKey(token);
    if (!entry) {
      throw new AuthError(401, "invalid_api_key", "Valid gateway API key required");
    }
    return clientIdentity(entry.clientId);
  }

  // JWT 形状 → 走 JWT 校验（校验失败不再回退 API Key，避免两种凭证混淆）
  if (isJwtShape(token)) {
    if (!jwtEnabled) {
      throw new AuthError(401, "jwt_not_enabled", "AUTH_MODE=apikey，不接受 JWT 凭证");
    }
    return verifyJwt(token);
  }

  if (!apiKeyEnabled) {
    throw new AuthError(401, "apikey_not_enabled", "AUTH_MODE=jwt，只接受 JWT 凭证");
  }
  const entry = matchApiKey(token);
  if (!entry) {
    throw new AuthError(401, "invalid_api_key", "Invalid gateway API key");
  }
  return clientIdentity(entry.clientId);
}

/* ============================ 授权（scope / 白名单） ============================ */

/**
 * 要求"必须是登录用户"（kind=user）。
 * 用于把聊天等面向终端用户的接口与服务端/网关凭证（API Key）隔开。
 */
export function assertUser(id: AuthIdentity, what: string): void {
  if (id.kind === "user") return;
  throw new AuthError(
    403,
    "user_auth_required",
    `${what} 仅接受登录用户凭证（typ=user 的 JWT）：请先 POST /api/auth/login。` +
      `网关 API Key 属于服务端/管理凭证，不能用于该接口`,
  );
}

/** scope 未声明（null）时放行，声明了则必须命中 */
export function assertScope(id: AuthIdentity, scope: string): void {
  if (!id.scopes) return;
  if (id.scopes.includes("*") || id.scopes.includes("admin") || id.scopes.includes(scope)) return;
  throw new AuthError(
    403,
    "insufficient_scope",
    `Token lacks required scope "${scope}" (granted: ${id.scopes.join(" ") || "none"})`,
  );
}

export function assertModelAllowed(
  id: AuthIdentity,
  model: string,
  providerName: string,
): void {
  if (id.allowedProviders && !matchWildcard(id.allowedProviders, providerName)) {
    throw new AuthError(
      403,
      "provider_not_allowed",
      `Client "${id.clientId}" is not allowed to use provider "${providerName}"`,
    );
  }
  if (id.allowedModels && !matchWildcard(id.allowedModels, model)) {
    throw new AuthError(
      403,
      "model_not_allowed",
      `Client "${id.clientId}" is not allowed to use model "${model}"`,
    );
  }
}

/** 模型可见性过滤（GET /v1/models 只返回该客户端可用的模型） */
export function isVisibleTo(
  id: AuthIdentity,
  modelId: string,
  providerName: string,
): boolean {
  if (id.allowedProviders && !matchWildcard(id.allowedProviders, providerName)) return false;
  if (id.allowedModels && !matchWildcard(id.allowedModels, modelId)) return false;
  return true;
}

export function describeIdentity(id: AuthIdentity): string {
  const bits = [`${id.authType}:${id.clientId}`];
  if (id.scopes) bits.push(`scope=${id.scopes.join(" ")}`);
  if (id.allowedModels) bits.push(`models=${id.allowedModels.join(",")}`);
  if (id.allowedProviders) bits.push(`providers=${id.allowedProviders.join(",")}`);
  return bits.join(" ");
}
