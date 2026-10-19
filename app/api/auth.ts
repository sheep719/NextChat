/**
 * auth.ts — 服务端鉴权入口
 *
 * 职责：各 /api/xxx 代理路由在处理请求前调用 auth(req, provider)，
 * 完成三件事：
 *   1. 解析 Authorization 头，区分访问码与用户自带的 API Key；
 *   2. 两道校验：访问码校验（needCode）与是否允许自带 key（hideUserApiKey）；
 *   3. 用户未提供 key 时，按 ModelProvider 注入服务端配置的系统 key。
 *
 * 与前端 store/access.ts 的分工：前端的 isAuthorized() 仅决定 UI 显隐，
 * 绕过前端伪造的请求会在此处被拦截并返回 401。
 *
 * 返回值设计：不抛异常，返回 {error, msg} 交由调用方决定响应格式，
 * 鉴权失败属于正常业务分支，以返回值表达比异常更直观。
 */
import { NextRequest } from "next/server";
import { getServerSideConfig } from "../config/server";
import md5 from "spark-md5";
import { ACCESS_CODE_PREFIX, ModelProvider } from "../constant";

/**
 * 获取客户端 IP：依次取 req.ip、x-real-ip、x-forwarded-for 的第一项
 * 取 forwarded-for 首项的原因：请求每经过一层代理会追加一个 IP，
 * 首项为真实客户端，末项为离服务端最近的代理。
 * 注意：x-forwarded-for 可被伪造，直连服务端时该值不可信，
 * 因此 IP 仅用于日志审计，不参与鉴权决策。
 */
function getIP(req: NextRequest) {
  let ip = req.ip ?? req.headers.get("x-real-ip");
  const forwardedFor = req.headers.get("x-forwarded-for");

  if (!ip && forwardedFor) {
    ip = forwardedFor.split(",").at(0) ?? "";
  }

  return ip;
}

/**
 * 区分访问码 vs 用户自己的 API Key：靠前缀 "nk-"（constant.ts 的 ACCESS_CODE_PREFIX）
 * - 以 nk- 开头 → 访问码（走服务端鉴权，服务端出 key）
 * - 否则 → 用户自带的厂商 API Key（透传，服务端不出 key）
 * 设计巧思：一个 Authorization 头复用两种身份，靠前缀消歧
 */
function parseApiKey(bearToken: string) {
  const token = bearToken.trim().replaceAll("Bearer ", "").trim();
  const isApiKey = !token.startsWith(ACCESS_CODE_PREFIX);

  return {
    accessCode: isApiKey ? "" : token.slice(ACCESS_CODE_PREFIX.length),
    apiKey: isApiKey ? token : "",
  };
}

/**
 * 访问码校验：对用户输入做 md5 后，与 server.ts 预存的哈希集合比对，
 * 两侧均为哈希值，明文访问码不落地（哈希集合见 server.ts 的 ACCESS_CODES）
 *
 * 注意：这里的日志会把用户输入的访问码明文写入服务端日志，
 * 与 server.ts 中 getApiKey 的密钥日志问题同类，存在泄漏风险
 */
export function auth(req: NextRequest, modelProvider: ModelProvider) {
  const authToken = req.headers.get("Authorization") ?? "";

  // check if it is openai api key or user token
  const { accessCode, apiKey } = parseApiKey(authToken);

  const hashedCode = md5.hash(accessCode ?? "").trim();

  const serverConfig = getServerSideConfig();
  console.log("[Auth] allowed hashed codes: ", [...serverConfig.codes]);
  console.log("[Auth] got access code:", accessCode);
  console.log("[Auth] hashed access code:", hashedCode);
  console.log("[User IP] ", getIP(req));
  console.log("[Time] ", new Date().toLocaleString());

  if (serverConfig.needCode && !serverConfig.codes.has(hashedCode) && !apiKey) {
    return {
      error: true,
      msg: !accessCode ? "empty access code" : "wrong access code",
    };
  }

  if (serverConfig.hideUserApiKey && !!apiKey) {
    return {
      error: true,
      msg: "you are not allowed to access with your own api key",
    };
  }

  // 用户未携带 key 时，从服务端配置注入系统 key（由管理员提供上游凭证）
  // 按 ModelProvider（协议族）而非 ServiceProvider 分发，注入协议对应的 key。
  // 两个特例：
  //   - Iflytek 的 key 为 "apiKey:apiSecret" 拼接格式（其鉴权协议要求）
  //   - GPT 分支依据 URL 路径区分 Azure 与 OpenAI（二者复用协议，按路径分流）
  // 实现方式：req.headers.set 直接改写请求头，下游代码无感知
  if (!apiKey) {
    const serverConfig = getServerSideConfig();

    // const systemApiKey =
    //   modelProvider === ModelProvider.GeminiPro
    //     ? serverConfig.googleApiKey
    //     : serverConfig.isAzure
    //     ? serverConfig.azureApiKey
    //     : serverConfig.apiKey;

    let systemApiKey: string | undefined;

    switch (modelProvider) {
      case ModelProvider.Stability:
        systemApiKey = serverConfig.stabilityApiKey;
        break;
      case ModelProvider.GeminiPro:
        systemApiKey = serverConfig.googleApiKey;
        break;
      case ModelProvider.Claude:
        systemApiKey = serverConfig.anthropicApiKey;
        break;
      case ModelProvider.Doubao:
        systemApiKey = serverConfig.bytedanceApiKey;
        break;
      case ModelProvider.Ernie:
        systemApiKey = serverConfig.baiduApiKey;
        break;
      case ModelProvider.Qwen:
        systemApiKey = serverConfig.alibabaApiKey;
        break;
      case ModelProvider.Moonshot:
        systemApiKey = serverConfig.moonshotApiKey;
        break;
      case ModelProvider.Iflytek:
        systemApiKey =
          serverConfig.iflytekApiKey + ":" + serverConfig.iflytekApiSecret;
        break;
      case ModelProvider.DeepSeek:
        systemApiKey = serverConfig.deepseekApiKey;
        break;
      case ModelProvider.XAI:
        systemApiKey = serverConfig.xaiApiKey;
        break;
      case ModelProvider.ChatGLM:
        systemApiKey = serverConfig.chatglmApiKey;
        break;
      case ModelProvider.SiliconFlow:
        systemApiKey = serverConfig.siliconFlowApiKey;
        break;
      case ModelProvider.GPT:
      default:
        if (req.nextUrl.pathname.includes("azure/deployments")) {
          systemApiKey = serverConfig.azureApiKey;
        } else {
          systemApiKey = serverConfig.apiKey;
        }
    }

    if (systemApiKey) {
      console.log("[Auth] use system api key");
      req.headers.set("Authorization", `Bearer ${systemApiKey}`);
    } else {
      console.log("[Auth] admin did not provide an api key");
    }
  } else {
    console.log("[Auth] use user api key");
  }

  return {
    error: false,
  };
}
