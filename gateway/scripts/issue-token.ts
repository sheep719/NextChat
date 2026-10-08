/**
 * 签发网关 JWT（离线签发，或经网关 /v1/auth/token 用 API Key 换取）。
 *
 * 用法：
 *   npm run token -- --client nextchat-web --ttl 3600
 *   npm run token -- --client nextchat-web --scope "chat.completions models.read"
 *   npm run token -- --client nextchat-web --models "qwen-*,deepseek-chat" --providers alibaba
 *   npm run token -- --exchange --key sk-gateway-local-2026 --client nextchat-web
 *
 * 说明：离线签发直接用 gateway/.env 里的 JWT_SECRET，不需要网关在跑；
 *      --exchange 则走 HTTP 用 API Key 换令牌（可验证网关端签发链路）。
 */
import { signJwt, JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE } from "../src/auth.js";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function listArg(name: string): string[] | undefined {
  const v = arg(name);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

const GATEWAY_URL = arg("url", "http://127.0.0.1:3600");

async function main() {
  const clientId = arg("client", "nextchat-web");
  const ttl = Number(arg("ttl", "3600"));
  const scope = arg("scope");
  const models = listArg("models");
  const providers = listArg("providers");

  if (has("exchange")) {
    const apiKey = arg("key");
    if (!apiKey) {
      console.error("缺少 --key <API Key>（用 API Key 换令牌）");
      process.exit(1);
    }
    const res = await fetch(`${GATEWAY_URL.replace(/\/$/, "")}/v1/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, clientId, ttlSec: ttl, scope: scope || undefined, models, providers }),
    });
    const json = (await res.json()) as any;
    if (!res.ok) {
      console.error(`HTTP ${res.status}`, JSON.stringify(json, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  if (!JWT_SECRET) {
    console.error("gateway/.env 中未配置 JWT_SECRET，无法离线签发（或用 --exchange 走网关）");
    process.exit(1);
  }

  const { token, expiresIn, exp } = signJwt({
    sub: clientId,
    ttlSec: ttl,
    scope: scope || undefined,
    models,
    providers,
  });

  console.log(
    JSON.stringify(
      {
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
        expires_at: exp,
        client_id: clientId,
        iss: JWT_ISSUER || null,
        aud: JWT_AUDIENCE || null,
        scope: scope || null,
        models: models ?? null,
        providers: providers ?? null,
      },
      null,
      2,
    ),
  );
  console.error(
    `\n用法：NextChat 设置 → 自定义接口地址填网关地址，API Key 填上面 access_token\n` +
      `（或 curl -H "Authorization: Bearer ${token.slice(0, 24)}..." ${GATEWAY_URL}/v1/chat/completions）`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
