/**
 * ═══════════════════════════════════════════════════════════
 * auth.ts — 服务端鉴权入口（Day 1 五文件的最后一个）
 *
 * 职责：每个 /api/xxx 代理路由在处理请求前都先调 auth(req, provider)
 * 做三件事：
 *   1. 解析 Authorization 头，区分"访问码"和"用户自己的 API Key"
 *   2. 两道闸门：访问码校验（needCode）+ 是否允许自带 key（hideUserApiKey）
 *   3. 用户没给 key 时，按 ModelProvider 注入服务端配置的系统 key
 *
 * ★ 与前端 store/access.ts 的分工（Day 1 自测题 5 的完整答案）：
 *   前端 isAuthorized() 只决定 UI 显隐；真正的拦截在这里——
 *   伪造请求绕过前端，打到这里照样被 401。"前端拦体验，服务端拦攻击"
 *
 * ★ 返回值设计：不抛异常，返回 {error, msg} 让调用方决定响应格式——
 *   鉴权失败也是业务流的一部分，用返回值比异常更清晰
 * ═══════════════════════════════════════════════════════════
 */
import { NextRequest } from "next/server";
import { getServerSideConfig } from "../config/server";
import md5 from "spark-md5";
import { ACCESS_CODE_PREFIX, ModelProvider } from "../constant";

/**
 * 取真实客户端 IP：优先级 req.ip → x-real-ip → x-forwarded-for 第一个
 * 为什么取 forwardedFor 的第一个：代理链每过一层就追加一个 IP，
 * 链首才是真实客户端（链尾是离服务端最近的代理）
 * ★ 注意：x-forwarded-for 可伪造，直接打服务端的话这里拿到的就是假的——
 *   所以 IP 只能用于日志审计，不能用于安全决策
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
 * 访问码校验核心：md5(用户输入) 与 server.ts 里预存的 md5 集合比对
 * —— 两边都是哈希值，明文访问码全程不落地（呼应 server.ts 的 ACCESS_CODES）
 *
 * ★ 日志里有个细节问题：第 37 行把用户输入的访问码明文打进日志了
 *   （和 server.ts 的 getApiKey 泄漏是同类问题），发现这种"上游自己
 *   也没做好"的点，面试时讲出来很加分
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

  // 用户没带 key → 从服务端配置注入系统 key（"管理员买单"模式）
  // ★ 与 constant.ts 的呼应：这里按 ModelProvider（协议族）分发，
  //   而不是按 ServiceProvider（服务商）——注入的是协议对应的 key
  //   特例两个：
  //   - Iflytek 的 key 是 "apiKey:apiSecret" 拼接（它家鉴权要求）
  //   - GPT 分支里用 URL 路径区分 Azure / OpenAI（复用协议，分流看路径）
  // 手法：req.headers.set 直接改写请求头，下游代码无感知
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
