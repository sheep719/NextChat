/**
 * ═══════════════════════════════════════════════════════════
 * server.ts — 服务端配置中心（仅 Node 环境）
 * 管什么：所有"不能进浏览器"的环境变量 —— 各厂商 API Key、访问码、
 *         功能开关（禁 GPT4 / 隐藏密钥输入框等）
 * 关键机制：本文件导出的内容只会出现在服务端（API Route / SSR），
 *         Next.js 会把 import 它的代码划入 server bundle，
 *         浏览器 bundle 里永远没有这些值 —— 密钥隔离的第一道墙
 * 姊妹文件：app/config/build.ts（构建期）| 通过 app/api/config/route.ts
 *         把"安全子集"（8 个非敏感字段）下发给前端
 * ═══════════════════════════════════════════════════════════
 */
import md5 from "spark-md5";
import { DEFAULT_MODELS, DEFAULT_GA_ID } from "../constant";
import { isGPT4Model } from "../utils/model";

/**
 * ProcessEnv 类型声明 —— 给环境变量补上 TypeScript 类型
 * 没有这段的话 process.env.XXX 全是 string | undefined，
 * key 名拼错不报错；声明后写错编译期直接红。
 * 全部可选（?）：不设也能跑，服务端按"未配置该厂商"处理
 */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PROXY_URL?: string; // docker only

      OPENAI_API_KEY?: string;
      CODE?: string;

      BASE_URL?: string;
      OPENAI_ORG_ID?: string; // openai only

      VERCEL?: string;
      BUILD_MODE?: "standalone" | "export";
      BUILD_APP?: string; // is building desktop app

      HIDE_USER_API_KEY?: string; // disable user's api key input
      DISABLE_GPT4?: string; // allow user to use gpt-4 or not
      ENABLE_BALANCE_QUERY?: string; // allow user to query balance or not
      DISABLE_FAST_LINK?: string; // disallow parse settings from url or not
      CUSTOM_MODELS?: string; // to control custom models
      DEFAULT_MODEL?: string; // to control default model in every new chat window
      VISION_MODELS?: string; // to control vision models

      // stability only
      STABILITY_URL?: string;
      STABILITY_API_KEY?: string;

      // azure only
      AZURE_URL?: string; // https://{azure-url}/openai/deployments/{deploy-name}
      AZURE_API_KEY?: string;
      AZURE_API_VERSION?: string;

      // google only
      GOOGLE_API_KEY?: string;
      GOOGLE_URL?: string;

      // google tag manager
      GTM_ID?: string;

      // anthropic only
      ANTHROPIC_URL?: string;
      ANTHROPIC_API_KEY?: string;
      ANTHROPIC_API_VERSION?: string;

      // baidu only
      BAIDU_URL?: string;
      BAIDU_API_KEY?: string;
      BAIDU_SECRET_KEY?: string;

      // bytedance only
      BYTEDANCE_URL?: string;
      BYTEDANCE_API_KEY?: string;

      // alibaba only
      ALIBABA_URL?: string;
      ALIBABA_API_KEY?: string;

      // tencent only
      TENCENT_URL?: string;
      TENCENT_SECRET_KEY?: string;
      TENCENT_SECRET_ID?: string;

      // moonshot only
      MOONSHOT_URL?: string;
      MOONSHOT_API_KEY?: string;

      // iflytek only
      IFLYTEK_URL?: string;
      IFLYTEK_API_KEY?: string;
      IFLYTEK_API_SECRET?: string;

      DEEPSEEK_URL?: string;
      DEEPSEEK_API_KEY?: string;

      // xai only
      XAI_URL?: string;
      XAI_API_KEY?: string;

      // chatglm only
      CHATGLM_URL?: string;
      CHATGLM_API_KEY?: string;

      // siliconflow only
      SILICONFLOW_URL?: string;
      SILICONFLOW_API_KEY?: string;

      // 302.AI only
      AI302_URL?: string;
      AI302_API_KEY?: string;

      // custom template for preprocessing user input
      DEFAULT_INPUT_TEMPLATE?: string;

      ENABLE_MCP?: string; // enable mcp functionality
    }
  }
}

/**
 * 访问码集合：环境变量 CODE="code1,code2" 逗号分隔多个
 * ★ 安全考点：存的是 md5 哈希而不是明文 —— 校验时同样哈希后比对，
 *   明文访问码不驻留服务端内存；校验逻辑在 app/api/access.ts
 * ★ 弱点（可主动讲）：md5 无盐，理论上可彩虹表逆推，访问码强度
 *   依赖足够长随机；且无速率限制，可被暴力枚举 —— 你的 JWT 用户
 *   系统替换的正是这套机制，这就是两个项目的衔接故事
 */
const ACCESS_CODES = (function getAccessCodes(): Set<string> {
  const code = process.env.CODE;

  try {
    const codes = (code?.split(",") ?? [])
      .filter((v) => !!v)
      .map((v) => md5.hash(v.trim()));
    return new Set(codes);
  } catch (e) {
    return new Set();
  }
})();

/**
 * 多密钥轮询：KEY="sk-a,sk-b,sk-c" → 每次调用随机挑一个
 * 目的：多 key 分摊速率限制（rate limit），单个 key 打满不影响服务
 * ★ 高含金量谈资：console.log 把选中的 key 明文打进服务端日志！
 *   生产环境日志多人可见、还会被采集进日志平台，这是泄漏点。
 *   修复只需打成 `sk-...${apiKey.slice(-4)}` ——
 *   "我读源码时发现上游日志泄漏密钥"是绝佳的踩坑故事
 */
function getApiKey(keys?: string) {
  const apiKeyEnvVar = keys ?? "";
  const apiKeys = apiKeyEnvVar.split(",").map((v) => v.trim());
  const randomIndex = Math.floor(Math.random() * apiKeys.length);
  const apiKey = apiKeys[randomIndex];
  if (apiKey) {
    console.log(
      `[Server Config] using ${randomIndex + 1} of ${
        apiKeys.length
      } api key - ${apiKey}`,
    );
  }

  return apiKey;
}

/**
 * 服务端配置总出口：每次调用收集一遍环境变量并加工
 * ⚠️ 是函数而非顶层常量 —— 保证热重载/多进程下读到的都是最新值
 * 守卫：process 不存在说明被 import 进了浏览器 bundle，直接抛错
 *       （运行时保险丝：宁可崩也不让密钥进浏览器）
 *
 * 三个加工逻辑：
 * 1. isXxx 布尔旗标 —— "该厂商配没配 key"，前端用它决定设置页
 *    要不要显示该厂商入口（注意判定标准不统一：Azure 看 URL，
 *    其余看 API_KEY，因为 Azure 的部署信息在 URL 路径里）
 * 2. customModels 加工 —— DISABLE_GPT4=1 时给 GPT4 系模型名拼 "-"
 *    前缀（"-" = 从模型列表剔除，NextChat 约定的 DSL）
 * 3. allowedWebDavEndpoints —— 云同步端点白名单
 */
export const getServerSideConfig = () => {
  if (typeof process === "undefined") {
    throw Error(
      "[Server Config] you are importing a nodejs-only module outside of nodejs",
    );
  }

  const disableGPT4 = !!process.env.DISABLE_GPT4;
  let customModels = process.env.CUSTOM_MODELS ?? "";
  let defaultModel = process.env.DEFAULT_MODEL ?? "";
  let visionModels = process.env.VISION_MODELS ?? "";

  if (disableGPT4) {
    if (customModels) customModels += ",";
    customModels += DEFAULT_MODELS.filter((m) => isGPT4Model(m.name))
      .map((m) => "-" + m.name)
      .join(",");
    if (defaultModel && isGPT4Model(defaultModel)) {
      defaultModel = "";
    }
  }

  const isStability = !!process.env.STABILITY_API_KEY;

  const isAzure = !!process.env.AZURE_URL;
  const isGoogle = !!process.env.GOOGLE_API_KEY;
  const isAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const isTencent = !!process.env.TENCENT_API_KEY;

  const isBaidu = !!process.env.BAIDU_API_KEY;
  const isBytedance = !!process.env.BYTEDANCE_API_KEY;
  const isAlibaba = !!process.env.ALIBABA_API_KEY;
  const isMoonshot = !!process.env.MOONSHOT_API_KEY;
  const isIflytek = !!process.env.IFLYTEK_API_KEY;
  const isDeepSeek = !!process.env.DEEPSEEK_API_KEY;
  const isXAI = !!process.env.XAI_API_KEY;
  const isChatGLM = !!process.env.CHATGLM_API_KEY;
  const isSiliconFlow = !!process.env.SILICONFLOW_API_KEY;
  const isAI302 = !!process.env.AI302_API_KEY;
  // const apiKeyEnvVar = process.env.OPENAI_API_KEY ?? "";
  // const apiKeys = apiKeyEnvVar.split(",").map((v) => v.trim());
  // const randomIndex = Math.floor(Math.random() * apiKeys.length);
  // const apiKey = apiKeys[randomIndex];
  // console.log(
  //   `[Server Config] using ${randomIndex + 1} of ${apiKeys.length} api key`,
  // );

  const allowedWebDavEndpoints = (
    process.env.WHITE_WEBDAV_ENDPOINTS ?? ""
  ).split(",");

  return {
    baseUrl: process.env.BASE_URL,
    apiKey: getApiKey(process.env.OPENAI_API_KEY),
    openaiOrgId: process.env.OPENAI_ORG_ID,

    isStability,
    stabilityUrl: process.env.STABILITY_URL,
    stabilityApiKey: getApiKey(process.env.STABILITY_API_KEY),

    isAzure,
    azureUrl: process.env.AZURE_URL,
    azureApiKey: getApiKey(process.env.AZURE_API_KEY),
    azureApiVersion: process.env.AZURE_API_VERSION,

    isGoogle,
    googleApiKey: getApiKey(process.env.GOOGLE_API_KEY),
    googleUrl: process.env.GOOGLE_URL,

    isAnthropic,
    anthropicApiKey: getApiKey(process.env.ANTHROPIC_API_KEY),
    anthropicApiVersion: process.env.ANTHROPIC_API_VERSION,
    anthropicUrl: process.env.ANTHROPIC_URL,

    isBaidu,
    baiduUrl: process.env.BAIDU_URL,
    baiduApiKey: getApiKey(process.env.BAIDU_API_KEY),
    baiduSecretKey: process.env.BAIDU_SECRET_KEY,

    isBytedance,
    bytedanceApiKey: getApiKey(process.env.BYTEDANCE_API_KEY),
    bytedanceUrl: process.env.BYTEDANCE_URL,

    isAlibaba,
    alibabaUrl: process.env.ALIBABA_URL,
    alibabaApiKey: getApiKey(process.env.ALIBABA_API_KEY),

    isTencent,
    tencentUrl: process.env.TENCENT_URL,
    tencentSecretKey: getApiKey(process.env.TENCENT_SECRET_KEY),
    tencentSecretId: process.env.TENCENT_SECRET_ID,

    isMoonshot,
    moonshotUrl: process.env.MOONSHOT_URL,
    moonshotApiKey: getApiKey(process.env.MOONSHOT_API_KEY),

    isIflytek,
    iflytekUrl: process.env.IFLYTEK_URL,
    iflytekApiKey: process.env.IFLYTEK_API_KEY,
    iflytekApiSecret: process.env.IFLYTEK_API_SECRET,

    isDeepSeek,
    deepseekUrl: process.env.DEEPSEEK_URL,
    deepseekApiKey: getApiKey(process.env.DEEPSEEK_API_KEY),

    isXAI,
    xaiUrl: process.env.XAI_URL,
    xaiApiKey: getApiKey(process.env.XAI_API_KEY),

    isChatGLM,
    chatglmUrl: process.env.CHATGLM_URL,
    chatglmApiKey: getApiKey(process.env.CHATGLM_API_KEY),

    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareKVNamespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID,
    cloudflareKVApiKey: getApiKey(process.env.CLOUDFLARE_KV_API_KEY),
    cloudflareKVTTL: process.env.CLOUDFLARE_KV_TTL,

    isSiliconFlow,
    siliconFlowUrl: process.env.SILICONFLOW_URL,
    siliconFlowApiKey: getApiKey(process.env.SILICONFLOW_API_KEY),

    isAI302,
    ai302Url: process.env.AI302_URL,
    ai302ApiKey: getApiKey(process.env.AI302_API_KEY),

    gtmId: process.env.GTM_ID,
    gaId: process.env.GA_ID || DEFAULT_GA_ID,

    needCode: ACCESS_CODES.size > 0,
    code: process.env.CODE,
    codes: ACCESS_CODES,

    proxyUrl: process.env.PROXY_URL,
    isVercel: !!process.env.VERCEL,

    hideUserApiKey: !!process.env.HIDE_USER_API_KEY,
    disableGPT4,
    hideBalanceQuery: !process.env.ENABLE_BALANCE_QUERY,
    disableFastLink: !!process.env.DISABLE_FAST_LINK,
    customModels,
    defaultModel,
    visionModels,
    allowedWebDavEndpoints,
    enableMcp: process.env.ENABLE_MCP === "true",
  };
};
