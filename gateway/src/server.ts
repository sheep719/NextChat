/**
 * NextChat 自建后端网关
 *
 * 定位：NextChat 的「自定义 endpoint」（OpenAI 兼容）+ 多模型路由 + 统一鉴权。
 *
 * 端点：
 *   POST /v1/chat/completions   聊天补全（支持 SSE 流式透传）      需鉴权
 *   GET  /v1/models             可用模型列表（按客户端白名单过滤）   需鉴权
 *   POST /v1/auth/token         用 API Key 换取 JWT（仅认 API Key） 需鉴权
 *   GET  /v1/auth/whoami        查看当前调用方身份                  需鉴权
 *   GET  /healthz               健康检查                            免鉴权
 *
 * 鉴权由 src/auth.ts 统一处理：支持 API Key 与 JWT(HS256) 两种凭证，
 * 未通过一律 401 / 403，未配置任何凭证时网关拒绝启动（fail-closed）。
 */
import Fastify from "fastify";
import { Readable } from "node:stream";
import {
  CHAT_REQUIRE_USER,
  CORS_ALLOWED_ORIGINS,
  HOST,
  PORT,
  REGISTRATION_ENABLED,
  UPSTREAM_TIMEOUT_MS,
  listModels,
  providers,
  resolveProvider,
} from "./config.js";
import {
  ALLOW_ANONYMOUS,
  AUTH_MODE,
  AuthError,
  AuthIdentity,
  JWT_DEFAULT_TTL_SEC,
  assertAuthConfigured,
  assertModelAllowed,
  assertScope,
  assertUser,
  authenticate,
  describeIdentity,
  hasAnyCredential,
  isVisibleTo,
  apiKeys,
  jwtEnabled,
  maskSecret,
  signJwt,
} from "./auth.js";
import { DB_PATH, db, toPublicUser } from "./db.js";
import {
  deleteCloudState,
  getCloudState,
  listCloudState,
  putCloudState,
} from "./cloud-state.js";
import {
  checkEmail,
  checkPassword,
  checkUsername,
  countUsers,
  createUser,
  findUserById,
  issueUserToken,
  verifyCredentials,
} from "./users.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
  getOwnedConversation,
  listConversations,
  listMessages,
} from "./conversations.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthIdentity;
    /** onRequest 阶段算好的 CORS 响应头（hijack 分支写 raw 时需要） */
    cors?: Record<string, string>;
  }
}

const app = Fastify({
  logger: {
    level: "info",
    // 精简日志，避免打印凭证
    redact: ["req.headers.authorization", "req.headers['x-api-key']"],
  },
  bodyLimit: 20 * 1024 * 1024,
});

/* ============================== CORS ============================== */

const CORS_ALLOW_ALL = CORS_ALLOWED_ORIGINS.includes("*");

/**
 * 按来源白名单生成 CORS 响应头。
 * NextChat 以自定义 endpoint 直连时，浏览器会发跨域请求（并带 Authorization 触发预检），
 * 因此这里必须在网关侧显式放行；不在白名单内的来源不给任何 CORS 头，由浏览器直接拦截。
 */
function corsHeaders(origin: string | undefined): Record<string, string> {
  const o = (origin || "").trim();
  const allowed = CORS_ALLOW_ALL ? "*" : CORS_ALLOWED_ORIGINS.includes(o) ? o : "";
  if (!allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-credentials": CORS_ALLOW_ALL ? "false" : "true",
    "access-control-expose-headers":
      "x-gateway-provider, x-gateway-client, x-request-id",
    vary: "Origin",
  };
}

app.addHook("onRequest", async (req, reply) => {
  const cors = corsHeaders(req.headers.origin);
  for (const [k, v] of Object.entries(cors)) reply.header(k, v);
  req.cors = cors; // 供 hijack 分支使用（raw 写入不走 reply.header）
});

// 预检请求：不带凭证，浏览器不会附带 Authorization，故免鉴权
app.options("/*", async (req, reply) => {
  const cors = corsHeaders(req.headers.origin);
  if (!cors["access-control-allow-origin"]) {
    reply.code(403).send({
      error: { message: "Origin not allowed by gateway CORS policy", type: "invalid_request_error" },
    });
    return;
  }
  // 必须包含 PUT / DELETE：前端快照同步用 PUT 上传、DELETE 清除，
  // 预检少了这两个方法，浏览器会直接拦掉请求（页面上看不到任何报错，只是同步静默失败）
  reply.header(
    "access-control-allow-methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  reply.header("access-control-allow-headers", "Authorization, Content-Type, X-Api-Key");
  reply.header("access-control-max-age", "86400");
  reply.code(204).send();
});

/* ============================== 鉴权 ============================== */

/** 免鉴权路径（注册/登录本身就是为了拿凭证，不能再要求凭证） */
const PUBLIC_PATHS = new Set([
  "/healthz",
  "/api/auth/register",
  "/api/auth/login",
]);
/** 自行处理鉴权的路径（签发令牌只认 API Key） */
const SELF_AUTH_PATHS = new Set(["/v1/auth/token"]);

function unauthorized(reply: any, err: AuthError): void {
  reply.header("www-authenticate", 'Bearer realm="nextchat-gateway"');
  reply.code(err.status).send({
    error: {
      message: err.message,
      type: err.status === 401 ? "invalid_request_error" : "permission_error",
      code: err.code,
    },
  });
}

app.addHook("preHandler", async (req, reply) => {
  if (req.method === "OPTIONS") return;
  if (PUBLIC_PATHS.has(req.url)) return;
  if (SELF_AUTH_PATHS.has(req.url)) return;

  try {
    req.auth = authenticate(req.headers as Record<string, unknown>);
  } catch (e) {
    if (e instanceof AuthError) {
      req.log.warn(`[auth] reject ${req.method} ${req.url} -> ${e.status} ${e.code}`);
      unauthorized(reply, e);
      return reply;
    }
    throw e;
  }
});

/* ======================== 用户注册 / 登录 ======================== */

/** 要求"必须是登录用户"；不满足时已写入响应，返回 false */
function requireUser(req: any, reply: any, what: string): boolean {
  try {
    assertUser(req.auth, what);
    return true;
  } catch (e) {
    if (e instanceof AuthError) {
      unauthorized(reply, e);
      return false;
    }
    throw e;
  }
}

/** 要求 scope；不满足时已写入响应，返回 false */
function requireScope(req: any, reply: any, scope: string): boolean {
  try {
    assertScope(req.auth, scope);
    return true;
  } catch (e) {
    if (e instanceof AuthError) {
      unauthorized(reply, e);
      return false;
    }
    throw e;
  }
}

interface CredentialsBody {
  username?: string;
  password?: string;
  email?: string;
}

app.post("/api/auth/register", async (req, reply) => {
  if (!REGISTRATION_ENABLED) {
    reply.code(403).send({
      error: {
        message: "注册已关闭（REGISTRATION_ENABLED=false）",
        type: "permission_error",
        code: "registration_disabled",
      },
    });
    return;
  }

  const body = (req.body ?? {}) as CredentialsBody;
  const bad =
    checkUsername(String(body.username ?? "")) ??
    checkPassword(String(body.password ?? "")) ??
    checkEmail(body.email);
  if (bad) {
    reply.code(400).send({
      error: { message: bad, type: "invalid_request_error", code: "invalid_input" },
    });
    return;
  }

  const result = createUser({
    username: String(body.username!).trim(),
    password: String(body.password!),
    email: body.email ?? null,
  });

  if (!result.ok) {
    reply.code(result.code === "username_taken" ? 409 : 400).send({
      error: { message: result.message, type: "invalid_request_error", code: result.code },
    });
    return;
  }

  const { user, ...token } = issueUserToken(result.user as any);
  req.log.info(`[user] register username=%s id=%s`, user.username, user.id);
  reply.code(201).send({ user, ...token });
});

app.post("/api/auth/login", async (req, reply) => {
  const body = (req.body ?? {}) as CredentialsBody;
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");

  if (!username || !password) {
    reply.code(400).send({
      error: {
        message: "缺少 username 或 password",
        type: "invalid_request_error",
        code: "invalid_input",
      },
    });
    return;
  }

  const row = verifyCredentials(username, password);
  if (!row) {
    // 不区分"用户不存在"与"口令错误"，避免账号枚举
    req.log.warn(`[user] login failed for %s`, username);
    reply.code(401).send({
      error: {
        message: "用户名或口令错误",
        type: "invalid_request_error",
        code: "invalid_credentials",
      },
    });
    return;
  }

  req.log.info(`[user] login ok id=%s username=%s`, row.id, row.username);
  return issueUserToken(row);
});

app.get("/api/auth/me", async (req, reply) => {
  if (!requireUser(req, reply, "GET /api/auth/me")) return;
  const id = req.auth!;
  const row = findUserById(id.userId!);
  if (!row) {
    reply.code(401).send({
      error: {
        message: "令牌对应的用户已不存在",
        type: "invalid_request_error",
        code: "invalid_token",
      },
    });
    return;
  }
  return {
    user: toPublicUser(row),
    token: {
      client_id: id.clientId,
      auth_type: id.authType,
      kind: id.kind,
      scopes: id.scopes,
      exp: id.exp ?? null,
    },
  };
});

/* ========================== 会话 / 消息 ========================== */

const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

app.post("/api/conversations", async (req, reply) => {
  if (!requireUser(req, reply, "POST /api/conversations")) return;
  if (!requireScope(req, reply, "conversation.write")) return;

  const body = (req.body ?? {}) as { title?: string; model?: string; provider?: string };
  const conv = createConversation(req.auth!.userId!, {
    title: body.title ?? "新的对话",
    model: body.model ?? "",
    provider: body.provider ?? "",
  });
  reply.code(201).send({ conversation: conv });
});

app.get("/api/conversations", async (req, reply) => {
  if (!requireUser(req, reply, "GET /api/conversations")) return;
  if (!requireScope(req, reply, "conversation.read")) return;

  const q = (req.query ?? {}) as { limit?: string; offset?: string };
  const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
  const { items, total } = listConversations(req.auth!.userId!, limit, offset);
  return { object: "list", total, limit, offset, data: items };
});

app.get("/api/conversations/:id", async (req, reply) => {
  if (!requireUser(req, reply, "GET /api/conversations/:id")) return;
  if (!requireScope(req, reply, "conversation.read")) return;

  const id = Number((req.params as { id: string }).id);
  const conv = getOwnedConversation(id, req.auth!.userId!);
  if (!conv) {
    reply.code(404).send({
      error: { message: "会话不存在或不属于当前用户", type: "invalid_request_error", code: "not_found" },
    });
    return;
  }
  const q = (req.query ?? {}) as { limit?: string };
  const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 1000);
  const messages = listMessages(conv.id, limit, 0);
  return { conversation: conv, messages: messages.items, total: messages.total };
});

app.post("/api/conversations/:id/messages", async (req, reply) => {
  if (!requireUser(req, reply, "POST /api/conversations/:id/messages")) return;
  if (!requireScope(req, reply, "conversation.write")) return;

  const id = Number((req.params as { id: string }).id);
  const conv = getOwnedConversation(id, req.auth!.userId!);
  if (!conv) {
    reply.code(404).send({
      error: { message: "会话不存在或不属于当前用户", type: "invalid_request_error", code: "not_found" },
    });
    return;
  }

  const body = (req.body ?? {}) as { role?: string; content?: string; model?: string };
  const role = String(body.role ?? "user");
  const content = String(body.content ?? "");
  if (!MESSAGE_ROLES.has(role)) {
    reply.code(400).send({
      error: {
        message: `role 必须是 ${[...MESSAGE_ROLES].join(" / ")} 之一`,
        type: "invalid_request_error",
        code: "invalid_input",
      },
    });
    return;
  }
  if (!content) {
    reply.code(400).send({
      error: { message: "content 不能为空", type: "invalid_request_error", code: "invalid_input" },
    });
    return;
  }

  const msg = addMessage(conv.id, {
    role,
    content,
    model: body.model ?? conv.model,
  });
  reply.code(201).send({ message: msg });
});

app.delete("/api/conversations/:id", async (req, reply) => {
  if (!requireUser(req, reply, "DELETE /api/conversations/:id")) return;
  if (!requireScope(req, reply, "conversation.write")) return;

  const id = Number((req.params as { id: string }).id);
  const ok = deleteConversation(id, req.auth!.userId!);
  if (!ok) {
    reply.code(404).send({
      error: { message: "会话不存在或不属于当前用户", type: "invalid_request_error", code: "not_found" },
    });
    return;
  }
  return { object: "conversation", id, deleted: true };
});

/* ==================== 云端状态快照（多端对话同步） ==================== */

/**
 * 前端把整份状态（如 ChatStore 的会话集合）按 key 存一份快照。
 * payload 网关不解析；换设备登录拉同一份 key 即可还原，达到"换浏览器看到历史对话"。
 */
const STATE_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_STATE_KEY = "chat";

interface SyncStateBody {
  key?: string;
  payload?: unknown;
  baseUpdatedAt?: number;
}

function readStateKey(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_STATE_KEY;
  const key = String(raw);
  return STATE_KEY_RE.test(key) ? key : null;
}

function badKey(reply: any): void {
  reply.code(400).send({
    error: {
      message: "state key 非法（允许字母数字与 _ . -，最长 64）",
      type: "invalid_request_error",
      code: "invalid_state_key",
    },
  });
}

app.get("/api/sync/state", async (req, reply) => {
  if (!requireUser(req, reply, "GET /api/sync/state")) return;
  const q = (req.query ?? {}) as { key?: string };
  const key = readStateKey(q.key);
  if (!key) return badKey(reply);

  const cur = getCloudState(req.auth!.userId!, key);
  reply.send({
    key,
    payload: cur?.payload ?? null,
    updatedAt: cur?.updatedAt ?? 0,
    version: cur?.version ?? 0,
  });
});

app.put("/api/sync/state", async (req, reply) => {
  if (!requireUser(req, reply, "PUT /api/sync/state")) return;
  const body = (req.body ?? {}) as SyncStateBody;
  const key = readStateKey(body.key);
  if (!key) return badKey(reply);
  if (body.payload === undefined) {
    reply.code(400).send({
      error: {
        message: "缺少 payload",
        type: "invalid_request_error",
        code: "missing_payload",
      },
    });
    return;
  }

  try {
    const result = putCloudState(
      req.auth!.userId!,
      key,
      body.payload,
      Number(body.baseUpdatedAt ?? 0),
    );
    if (!result.ok) {
      // 其他设备写过了：把服务端最新回给客户端，让它合并后重试
      reply.code(409).send({
        error: {
          message: "云端已被其他设备更新，请合并后重试",
          type: "conflict_error",
          code: "state_conflict",
        },
        server: {
          key,
          payload: result.server.payload,
          updatedAt: result.server.updatedAt,
          version: result.server.version,
        },
      });
      return;
    }
    reply.send({ key, updatedAt: result.updatedAt, version: result.version });
  } catch (e: any) {
    if (e?.statusCode === 413) {
      reply.code(413).send({
        error: {
          message: "快照过大（上限 8MB）",
          type: "invalid_request_error",
          code: "payload_too_large",
        },
      });
      return;
    }
    throw e;
  }
});

app.delete("/api/sync/state", async (req, reply) => {
  if (!requireUser(req, reply, "DELETE /api/sync/state")) return;
  const q = (req.query ?? {}) as { key?: string };
  const key = readStateKey(q.key);
  if (!key) return badKey(reply);
  reply.send({ key, deleted: deleteCloudState(req.auth!.userId!, key) });
});

app.get("/api/sync/state/keys", async (req, reply) => {
  if (!requireUser(req, reply, "GET /api/sync/state/keys")) return;
  reply.send({ items: listCloudState(req.auth!.userId!) });
});

/* ============================ 健康检查 ============================ */

app.get("/healthz", async () => ({
  status: "ok",
  authMode: AUTH_MODE,
  chatRequiresUser: CHAT_REQUIRE_USER,
  anonymousAllowed: ALLOW_ANONYMOUS,
  credentialsConfigured: hasAnyCredential,
  apiKeys: apiKeys.length,
  jwtEnabled,
  db: {
    path: DB_PATH,
    sqlite: (db.prepare("select sqlite_version() as v").get() as { v: string }).v,
    users: countUsers(),
  },
  providers: providers.map((p) => ({
    name: p.name,
    ready: p.apiKey.length > 0,
    baseUrl: p.baseUrl,
  })),
}));

/* ============================ 令牌签发 ============================ */

interface TokenRequestBody {
  apiKey?: string;
  clientId?: string;
  ttlSec?: number;
  scope?: string | string[];
  models?: string[];
  providers?: string[];
}

/**
 * 用 API Key 换 JWT。
 * 只接受 API Key 凭证（不接受 JWT），避免令牌自我续签产生永久凭证。
 */
app.post("/v1/auth/token", async (req, reply) => {
  const body = (req.body ?? {}) as TokenRequestBody;
  const headers = { ...(req.headers as Record<string, unknown>) };

  // 允许从 body 传 apiKey（便于脚本/前端换取），优先于 Authorization
  if (typeof body.apiKey === "string" && body.apiKey) {
    headers.authorization = `Bearer ${body.apiKey}`;
  }

  let issuer: AuthIdentity;
  try {
    issuer = authenticate(headers, { requireApiKey: true });
  } catch (e) {
    if (e instanceof AuthError) {
      req.log.warn(`[auth] token exchange rejected -> ${e.status} ${e.code}`);
      unauthorized(reply, e);
      return reply;
    }
    throw e;
  }

  if (!jwtEnabled) {
    reply.code(400).send({
      error: {
        message: "JWT is disabled (AUTH_MODE=apikey or JWT_SECRET not set)",
        type: "invalid_request_error",
        code: "jwt_disabled",
      },
    });
    return;
  }

  const scope = Array.isArray(body.scope)
    ? body.scope.join(" ")
    : typeof body.scope === "string"
      ? body.scope
      : undefined;

  const { token, expiresIn, exp } = signJwt({
    sub: body.clientId?.trim() || issuer.clientId,
    ttlSec: body.ttlSec ?? JWT_DEFAULT_TTL_SEC,
    scope,
    models: body.models,
    providers: body.providers,
  });

  req.log.info(`[auth] issued JWT for %s, ttl=%ss`, issuer.clientId, expiresIn);

  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: expiresIn,
    expires_at: exp,
    client_id: body.clientId?.trim() || issuer.clientId,
    scope: scope?.split(/[\s,]+/).filter(Boolean) ?? null,
    models: body.models ?? null,
    providers: body.providers ?? null,
  };
});

/** 查看当前调用方身份（排障用） */
app.get("/v1/auth/whoami", async (req) => {
  const id = req.auth!;
  return {
    client_id: id.clientId,
    auth_type: id.authType,
    scopes: id.scopes,
    allowed_models: id.allowedModels,
    allowed_providers: id.allowedProviders,
    exp: id.exp ?? null,
  };
});

/* ============================ 模型列表 ============================ */

app.get("/v1/models", async (req) => {
  const id = req.auth!;
  assertScope(id, "models.read");

  const models = listModels().filter((m) => isVisibleTo(id, m.id, m.provider));
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      owned_by: m.provider,
      ready: m.ready,
    })),
  };
});

/* ======================== 聊天补全（核心） ======================== */

interface ChatCompletionBody {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
  [key: string]: unknown;
}

app.post("/v1/chat/completions", async (req, reply) => {
  const identity = req.auth!;

  // 绑定登录用户：聊天接口只认 typ=user 的 JWT（/api/auth/login 签发），
  // 网关 API Key 属服务端/管理凭证，不能调用（CHAT_REQUIRE_USER=false 可放开）
  if (CHAT_REQUIRE_USER && !requireUser(req, reply, "POST /v1/chat/completions")) return;

  try {
    assertScope(identity, "chat.completions");
  } catch (e) {
    if (e instanceof AuthError) {
      unauthorized(reply, e);
      return reply;
    }
    throw e;
  }

  const body = req.body as ChatCompletionBody;
  const model = (body?.model || "").trim();

  if (!model) {
    reply.code(400).send({
      error: { message: "Missing `model` field in request body", type: "invalid_request_error" },
    });
    return;
  }

  const provider = resolveProvider(model);
  if (!provider) {
    reply.code(404).send({
      error: {
        message: `Unknown model "${model}": no provider route configured. See GET /v1/models`,
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });
    return;
  }

  // 模型/provider 白名单（JWT 声明）
  try {
    assertModelAllowed(identity, model, provider.name);
  } catch (e) {
    if (e instanceof AuthError) {
      req.log.warn(`[auth] ${describeIdentity(identity)} denied -> ${e.code}`);
      unauthorized(reply, e);
      return reply;
    }
    throw e;
  }

  if (!provider.apiKey) {
    reply.code(503).send({
      error: {
        message: `Provider "${provider.name}" has no API key configured (set ${provider.name.toUpperCase()}_API_KEY in gateway/.env)`,
        type: "server_error",
        code: "provider_not_configured",
      },
    });
    return;
  }

  const upstreamUrl = `${provider.baseUrl.replace(/\/$/, "")}${provider.chatPath}`;
  const isStream = body.stream === true;

  req.log.info(
    `[route] client=%s(%s) model=%s -> provider=%s stream=%s`,
    identity.clientId,
    identity.authType,
    model,
    provider.name,
    isStream,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: isStream ? "text/event-stream" : "application/json",
        // 用上游 provider 的真实 key 替换（网关凭证与上游 key 隔离）
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // 统一透传响应头（剔除干扰头）
    const headers = new Headers(upstream.headers);
    // 以下由本网关/Node 自行决定，不能透传，否则会出现
    // content-length 与 transfer-encoding 冲突（undici: HPE_UNEXPECTED_CONTENT_LENGTH）
    headers.delete("content-encoding"); // fetch 已解压
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.delete("connection");
    headers.delete("www-authenticate");
    headers.set("x-gateway-provider", provider.name);
    headers.set("x-gateway-client", identity.clientId);

    // 网关侧控制头：禁用代理/浏览器缓冲，保证 SSE 实时推送
    headers.set("x-accel-buffering", "no");
    headers.set("cache-control", "no-cache");

    const headerObj: Record<string, string> = {};
    headers.forEach((v, k) => {
      headerObj[k] = v;
    });
    // hijack 分支不走 reply.header，需手动并入 CORS 头
    Object.assign(headerObj, req.cors ?? {});

    if (isStream && upstream.body) {
      // SSE 流式：hijack 后用 raw 管道原样透传，避免框架对响应体二次处理
      reply.hijack();
      reply.raw.writeHead(upstream.status, headerObj);
      Readable.fromWeb(upstream.body as any).pipe(reply.raw);
    } else {
      // 非流式：JSON 整体转发（响应头同步透传）
      const json = await upstream.text();
      reply.code(upstream.status);
      reply.headers(headerObj);
      reply.header("content-type", "application/json");
      reply.send(json);
    }
  } catch (e: any) {
    req.log.error(`[upstream] ${provider.name} error: ${e?.message}`);
    const aborted = e?.name === "AbortError";
    reply.code(aborted ? 504 : 502).send({
      error: {
        message: aborted
          ? `Upstream ${provider.name} timeout`
          : `Upstream ${provider.name} request failed: ${e?.message}`,
        type: "server_error",
      },
    });
  } finally {
    if (!isStream) clearTimeout(timer);
    // 流式场景：在连接关闭后再清理
    reply.raw.on("close", () => clearTimeout(timer));
  }
});

/* ============================== 兜底 404 ============================== */

app.setNotFoundHandler(async (req, reply) => {
  reply.code(404).send({
    error: {
      message: `No route for ${req.method} ${req.url}`,
      type: "invalid_request_error",
      code: "not_found",
    },
  });
});

/* ============================== 启动 ============================== */

try {
  assertAuthConfigured();
} catch (e: any) {
  // eslint-disable-next-line no-console
  console.error(`\n[gateway] 启动中止：${e?.message ?? e}\n`);
  process.exit(1);
}

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`gateway listening on http://${HOST}:${PORT}`);
    app.log.info(
      `providers: ${providers
        .map((p) => `${p.name}(${p.apiKey ? "ready" : "no-key"})`)
        .join(", ")}`,
    );
    app.log.info(
      `auth: mode=${AUTH_MODE} apiKeys=${apiKeys.length} jwt=${jwtEnabled} anonymous=${ALLOW_ANONYMOUS}`,
    );
    if (ALLOW_ANONYMOUS) {
      app.log.warn("ALLOW_ANONYMOUS=true — 未携带凭证的请求也会被放行（仅调试用）");
    }
    if (apiKeys.length) {
      app.log.info(
        `api key hints: ${apiKeys.map((k) => `${k.clientId}=${maskSecret(k.key)}`).join(", ")}`,
      );
    }
  })
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
