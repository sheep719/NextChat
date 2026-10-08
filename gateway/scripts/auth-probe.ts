/**
 * 网关自检脚本：鉴权 + 用户注册登录 + 会话/消息 + 聊天接口绑定。
 *
 * 用法（需先启动网关）：
 *   npm run probe
 *
 * 结果同时打印到 stdout 并写入 scripts/auth-probe-result.txt
 * （本机 bash 管道不可靠，统一写文件再读）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { signJwt, JWT_SECRET, JWT_ISSUER } from "../src/auth.js";

const GW = process.env.PROBE_URL || "http://127.0.0.1:3600";
const OUT: string[] = [];
const log = (s = "") => OUT.push(s);

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail: string) {
  if (ok) pass++;
  else fail++;
  log(`${ok ? "PASS" : "FAIL"} | ${label} | ${detail}`);
}

interface Res {
  status: number;
  headers: Headers;
  json: any;
  text: string;
  frames: number;
}

async function call(p: string, init: RequestInit = {}): Promise<Res> {
  const res = await fetch(GW + p, init);
  const ct = res.headers.get("content-type") || "";

  if (ct.includes("event-stream")) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let frames = 0;
    let content = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.startsWith("data: ")) continue;
        frames++;
        const d = l.slice(6);
        if (d === "[DONE]") continue;
        try {
          const j = JSON.parse(d);
          content += j.choices?.[0]?.delta?.content ?? "";
        } catch {}
      }
    }
    return { status: res.status, headers: res.headers, json: null, text: content, frames };
  }

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text, frames: 0 };
}

const jsonHeaders = (token?: string | null, extra: Record<string, string> = {}) => {
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
};

const postJson = (p: string, token: string | null | undefined, body: unknown, extra: Record<string, string> = {}) =>
  call(p, { method: "POST", headers: jsonHeaders(token, extra), body: JSON.stringify(body) });

const chatBody = (model: string, stream = false) => ({
  model,
  stream,
  messages: [{ role: "user", content: "说两个字" }],
  max_tokens: 16,
  temperature: 0.1,
});

/** 注意：token 允许 undefined（登录令牌来自 JSON 解析，静态类型为 string | undefined），
 *  统一归一为 null，语义等价于"不带凭证" */
const chat = (
  token: string | null | undefined,
  model: string,
  stream = false,
  extraHeaders: Record<string, string> = {},
) => postJson("/v1/chat/completions", token ?? null, chatBody(model, stream), extraHeaders);

/** 手工签发用户令牌（可自定义 scope/models，也可突破 ttl 下限构造过期令牌） */
function mintUserToken(opts: {
  uid?: number;
  username?: string;
  scope?: string[];
  models?: string[];
  ttlSec?: number;
} = {}): string {
  return signJwt({
    sub: `user:${opts.uid ?? 1}`,
    ttlSec: opts.ttlSec ?? 600,
    scope: opts.scope,
    models: opts.models,
    typ: "user",
    extra: { uid: opts.uid ?? 1, username: opts.username ?? "probe-user", role: "user" },
  }).token;
}

/** 手工签发（可突破 ttl 下限，用于构造过期令牌） */
function craftJwt(payload: Record<string, any>): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function main() {
  const apiKey = (process.env.GATEWAY_API_KEYS || "").split(",")[0].split(":")[0].trim();
  const username = `probe_${crypto.randomBytes(4).toString("hex")}`;
  const password = "probe-pass-2026";

  log("=== 网关自检：鉴权 + 用户体系 + 会话 ===");
  log(`gateway: ${GW}`);
  log(`api key: ${apiKey ? apiKey.slice(0, 6) + "..." : "(未配置)"}`);
  log("");

  if (!apiKey) {
    log("未读到 GATEWAY_API_KEYS，无法继续");
    return;
  }

  /* ---------- 1. 健康检查 ---------- */
  const health = await call("/healthz");
  check(
    "healthz 免鉴权（含库信息）",
    health.status === 200 && !!health.json?.db,
    `status=${health.status} authMode=${health.json?.authMode} sqlite=${health.json?.db?.sqlite} users=${health.json?.db?.users} chatRequiresUser=${health.json?.chatRequiresUser}`,
  );

  /* ==================== 用户注册 / 登录 ==================== */

  const reg = await postJson("/api/auth/register", null, { username, password });
  const userToken: string | undefined = reg.json?.access_token;
  const userId: number | undefined = reg.json?.user?.id;
  check(
    "注册 → 201 且直接返回令牌",
    reg.status === 201 && !!userToken,
    `status=${reg.status} id=${userId} username=${reg.json?.user?.username} expires_in=${reg.json?.expires_in}`,
  );
  if (!userToken) {
    log("注册失败，后续用户用例跳过");
    return;
  }

  const dup = await postJson("/api/auth/register", null, { username, password });
  check(
    "重复注册 → 409 username_taken",
    dup.status === 409 && dup.json?.error?.code === "username_taken",
    `status=${dup.status} code=${dup.json?.error?.code}`,
  );

  const weak = await postJson("/api/auth/register", null, { username: "weak_user_x", password: "123" });
  check(
    "弱口令注册 → 400 invalid_input",
    weak.status === 400 && weak.json?.error?.code === "invalid_input",
    `status=${weak.status} msg=${weak.json?.error?.message}`,
  );

  const badName = await postJson("/api/auth/register", null, { username: "ab", password });
  check("非法用户名 → 400", badName.status === 400, `status=${badName.status}`);

  const loginOk = await postJson("/api/auth/login", null, { username, password });
  const loginToken: string | undefined = loginOk.json?.access_token;
  check(
    "登录（正确口令）→ 200",
    loginOk.status === 200 && !!loginToken,
    `status=${loginOk.status} user=${loginOk.json?.user?.username} expires_in=${loginOk.json?.expires_in}`,
  );

  const loginBad = await postJson("/api/auth/login", null, { username, password: "wrong-password" });
  check(
    "登录（错误口令）→ 401 invalid_credentials",
    loginBad.status === 401 && loginBad.json?.error?.code === "invalid_credentials",
    `status=${loginBad.status} code=${loginBad.json?.error?.code}`,
  );

  const loginNoUser = await postJson("/api/auth/login", null, {
    username: "no_such_user_zzz",
    password: "whatever-pass",
  });
  check(
    "登录（不存在的用户）→ 401（不泄露账号是否存在）",
    loginNoUser.status === 401 && loginNoUser.json?.error?.code === "invalid_credentials",
    `status=${loginNoUser.status}`,
  );

  const me = await call("/api/auth/me", { headers: jsonHeaders(loginToken) });
  check(
    "me（用户令牌）→ 200",
    me.status === 200 && me.json?.user?.username === username,
    `status=${me.status} user=${me.json?.user?.username} kind=${me.json?.token?.kind}`,
  );
  const meNoToken = await call("/api/auth/me");
  check("me（无凭证）→ 401", meNoToken.status === 401, `status=${meNoToken.status}`);

  /* ==================== 会话 / 消息 ==================== */

  const conv = await postJson("/api/conversations", loginToken, {
    title: "探针会话",
    model: "qwen-plus",
  });
  const convId: number | undefined = conv.json?.conversation?.id;
  check(
    "创建会话 → 201",
    conv.status === 201 && !!convId,
    `status=${conv.status} id=${convId} uuid=${conv.json?.conversation?.uuid?.slice(0, 8)}`,
  );

  const msg1 = await postJson(`/api/conversations/${convId}/messages`, loginToken, {
    role: "user",
    content: "你好",
  });
  check(
    "会话加消息 → 201（seq 自增）",
    msg1.status === 201 && msg1.json?.message?.seq === 1,
    `status=${msg1.status} seq=${msg1.json?.message?.seq} role=${msg1.json?.message?.role}`,
  );

  await postJson(`/api/conversations/${convId}/messages`, loginToken, {
    role: "assistant",
    content: "你好，有什么可以帮你？",
  });

  const badRole = await postJson(`/api/conversations/${convId}/messages`, loginToken, {
    role: "boss",
    content: "x",
  });
  check("非法 role → 400", badRole.status === 400, `status=${badRole.status}`);

  const convList = await call("/api/conversations", { headers: jsonHeaders(loginToken) });
  check(
    "会话列表 → 200（只含自己的）",
    convList.status === 200 && convList.json?.total >= 1,
    `status=${convList.status} total=${convList.json?.total}`,
  );

  const convDetail = await call(`/api/conversations/${convId}`, { headers: jsonHeaders(loginToken) });
  check(
    "会话详情 → 200（含 2 条消息）",
    convDetail.status === 200 && convDetail.json?.messages?.length === 2,
    `status=${convDetail.status} messages=${convDetail.json?.messages?.length}`,
  );

  // 越权：另注册一个用户，访问上面那个会话
  const otherName = `other_${crypto.randomBytes(3).toString("hex")}`;
  const other = await postJson("/api/auth/register", null, { username: otherName, password });
  const otherToken = other.json?.access_token;
  const crossRead = await call(`/api/conversations/${convId}`, { headers: jsonHeaders(otherToken) });
  check(
    "越权读取他人会话 → 404",
    crossRead.status === 404,
    `status=${crossRead.status} code=${crossRead.json?.error?.code}`,
  );
  const crossWrite = await postJson(`/api/conversations/${convId}/messages`, otherToken, {
    role: "user",
    content: "越权写入",
  });
  check("越权写入他人会话 → 404", crossWrite.status === 404, `status=${crossWrite.status}`);

  const convNoToken = await call("/api/conversations");
  check("会话列表（无凭证）→ 401", convNoToken.status === 401, `status=${convNoToken.status}`);

  const convWithApiKey = await call("/api/conversations", { headers: jsonHeaders(apiKey) });
  check(
    "会话列表（网关 API Key）→ 403 需登录用户",
    convWithApiKey.status === 403,
    `status=${convWithApiKey.status} code=${convWithApiKey.json?.error?.code}`,
  );

  /* ==================== 聊天接口绑定登录用户 ==================== */

  const chatUser = await chat(loginToken, "qwen-plus");
  check(
    "chat（登录用户）→ 200 阿里真实转发",
    chatUser.status === 200,
    `status=${chatUser.status} provider=${chatUser.headers.get("x-gateway-provider")} reply=${JSON.stringify(
      (chatUser.json?.choices?.[0]?.message?.content ?? chatUser.json?.error?.message ?? "").slice(0, 30),
    )}`,
  );

  const chatStream = await chat(loginToken, "qwen-plus", true);
  check(
    "chat（登录用户）流式 → 200 SSE",
    chatStream.status === 200 && chatStream.frames > 0,
    `status=${chatStream.status} frames=${chatStream.frames} text=${JSON.stringify(chatStream.text.slice(0, 16))}`,
  );

  const chatApiKey = await chat(apiKey, "qwen-plus");
  check(
    "chat（网关 API Key）→ 403 user_auth_required",
    chatApiKey.status === 403 && chatApiKey.json?.error?.code === "user_auth_required",
    `status=${chatApiKey.status} code=${chatApiKey.json?.error?.code}`,
  );

  const chatNone = await chat(null, "qwen-plus");
  check("chat（无凭证）→ 401", chatNone.status === 401, `status=${chatNone.status} code=${chatNone.json?.error?.code}`);

  const gwJwt = await postJson("/v1/auth/token", null, { apiKey, clientId: "probe-client", ttlSec: 600 });
  const gwToken = gwJwt.json?.access_token;
  check(
    "网关 API Key 换 JWT → 200",
    gwJwt.status === 200 && !!gwToken,
    `status=${gwJwt.status} client=${gwJwt.json?.client_id}`,
  );
  const chatGwJwt = await chat(gwToken, "qwen-plus");
  check(
    "chat（网关服务端 JWT）→ 403 非登录用户",
    chatGwJwt.status === 403 && chatGwJwt.json?.error?.code === "user_auth_required",
    `status=${chatGwJwt.status} code=${chatGwJwt.json?.error?.code}`,
  );

  /* ==================== 令牌安全 ==================== */

  // 登录令牌若缺失则退化为空串：篡改令牌用例期望 401，空串同样不会通过鉴权
  const parts = String(loginToken ?? "").split(".");
  const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -3)}AAA`;
  const chatTampered = await chat(tampered, "qwen-plus");
  check(
    "篡改签名的用户令牌 → 401 invalid_token",
    chatTampered.status === 401 && chatTampered.json?.error?.code === "invalid_token",
    `status=${chatTampered.status} code=${chatTampered.json?.error?.code}`,
  );

  const now = Math.floor(Date.now() / 1000);
  const expired = craftJwt({
    sub: "user:1",
    typ: "user",
    uid: 1,
    iat: now - 7200,
    nbf: now - 7200,
    // 需超出 JWT_CLOCK_SKEW_SEC（默认 60s）容差
    exp: now - 3600,
    ...(JWT_ISSUER ? { iss: JWT_ISSUER } : {}),
  });
  const chatExpired = await chat(expired, "qwen-plus");
  check(
    "过期的用户令牌 → 401 token_expired",
    chatExpired.status === 401 && chatExpired.json?.error?.code === "token_expired",
    `status=${chatExpired.status} code=${chatExpired.json?.error?.code}`,
  );

  const noScope = mintUserToken({ uid: userId, username, scope: ["models.read"] });
  const chatNoScope = await chat(noScope, "qwen-plus");
  check(
    "scope 不含 chat.completions → 403 insufficient_scope",
    chatNoScope.status === 403 && chatNoScope.json?.error?.code === "insufficient_scope",
    `status=${chatNoScope.status} code=${chatNoScope.json?.error?.code}`,
  );

  const limitedModel = mintUserToken({
    uid: userId,
    username,
    scope: ["chat.completions"],
    models: ["deepseek-chat"],
  });
  const chatWrongModel = await chat(limitedModel, "qwen-plus");
  check(
    "模型白名单越权（qwen-plus）→ 403 model_not_allowed",
    chatWrongModel.status === 403 && chatWrongModel.json?.error?.code === "model_not_allowed",
    `status=${chatWrongModel.status} code=${chatWrongModel.json?.error?.code}`,
  );
  const chatAllowedModel = await chat(limitedModel, "deepseek-chat");
  check(
    "模型白名单内（deepseek-chat）→ 通过鉴权（上游无 key 则 503）",
    chatAllowedModel.status === 200 || chatAllowedModel.status === 503,
    `status=${chatAllowedModel.status} code=${chatAllowedModel.json?.error?.code ?? "-"}`,
  );

  /* ==================== 其他端点 ==================== */

  const modelsUser = await call("/v1/models", { headers: jsonHeaders(loginToken) });
  check("模型列表（用户令牌）→ 200", modelsUser.status === 200, `status=${modelsUser.status} count=${modelsUser.json?.data?.length}`);
  const modelsNone = await call("/v1/models");
  check("模型列表（无凭证）→ 401", modelsNone.status === 401, `status=${modelsNone.status}`);

  const unknownModel = await chat(loginToken, "gpt-4o-none");
  check("未注册模型 → 404 model_not_found", unknownModel.status === 404, `status=${unknownModel.status}`);

  const r16 = await fetch(GW + "/v1/chat/completions", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  check(
    "CORS 预检（白名单来源）→ 204",
    r16.status === 204 && r16.headers.get("access-control-allow-origin") === "http://localhost:3000",
    `status=${r16.status} acao=${r16.headers.get("access-control-allow-origin")}`,
  );
  const r17 = await fetch(GW + "/v1/chat/completions", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  });
  check("CORS 预检（非白名单来源）→ 拒绝", r17.status === 403, `status=${r17.status}`);

  const r18 = await chat("sk-wrong-key-000000", "qwen-plus", false, { Origin: "http://localhost:3000" });
  check(
    "模拟 NextChat 跨域 + 错 key → 401（带 CORS 头）",
    r18.status === 401 && !!r18.headers.get("access-control-allow-origin"),
    `status=${r18.status} acao=${r18.headers.get("access-control-allow-origin")}`,
  );
  const r19 = await chat(loginToken, "qwen-plus", true, { Origin: "http://localhost:3000" });
  check(
    "模拟 NextChat 跨域 + 用户令牌流式 → 200 SSE",
    r19.status === 200 && r19.frames > 0,
    `status=${r19.status} frames=${r19.frames} ct=${r19.headers.get("content-type")}`,
  );

  /* ---------- 收尾：删除探针会话 ---------- */
  const del = await call(`/api/conversations/${convId}`, {
    method: "DELETE",
    headers: jsonHeaders(loginToken),
  });
  check("删除会话 → 200", del.status === 200, `status=${del.status} deleted=${del.json?.deleted}`);
  const afterDel = await call(`/api/conversations/${convId}`, { headers: jsonHeaders(loginToken) });
  check("删除后再取 → 404", afterDel.status === 404, `status=${afterDel.status}`);

  log("");
  log(`=== 汇总：PASS ${pass} / FAIL ${fail} ===`);
}

main()
  .catch((e) => {
    log(`脚本异常: ${e?.stack ?? e}`);
    fail++;
  })
  .finally(() => {
    const text = OUT.join("\n");
    fs.writeFileSync(
      path.resolve(process.cwd(), "scripts/auth-probe-result.txt"),
      text,
      "utf-8",
    );
    process.stdout.write(text + "\n");
  });
