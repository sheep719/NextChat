/**
 * ═══════════════════════════════════════════════════════════
 * /api/config — 服务端配置的"安全子集"下发接口
 *
 * 回答一个核心问题：前端为什么不直接读 process.env？
 *   1. process.env 在前端 bundle 里只会暴露 NEXT_PUBLIC_ 前缀的变量，
 *      服务端变量（密钥类）前端根本拿不到
 *   2. 密钥绝不能下发——所以这里做的是"白名单式人工挑选"：
 *      从 getServerSideConfig() 的返回值里只挑 8 个非敏感字段
 *
 * 与 server.ts 的关系（Day 1 学习主线）：
 *   server.ts = 全量服务端配置（含各厂商 apiKey、codes 等）
 *   本文件   = 从中挑出 UI 需要的布尔开关和模型清单，喂给前端
 *   前端拿到的 DANGER_CONFIG 决定了设置页的显示逻辑：
 *   needCode=true → 弹访问码输入框；hideUserApiKey=true → 隐藏 key 输入框；
 *   disableGPT4=true → 模型列表剔除 GPT4 系；customModels 里 "-" 前缀同样剔除
 *
 * ⚠️ 名字叫 DANGER_CONFIG 是上游的警示传统：这个对象会被整体发给浏览器，
 *    所以每次往里加字段前都要自问"这个值敢不敢公开"——上游甚至配了
 *    RUNTIME_CONFIG_DOM（见 constant.ts）把它挂到 DOM 上供运行时读取
 * ═══════════════════════════════════════════════════════════
 */
import { NextResponse } from "next/server";

import { getServerSideConfig } from "../../config/server";

// 模块加载时取一次配置（不是每次请求都读环境变量）
const serverConfig = getServerSideConfig();

// Danger! Do not hard code any secret value here!
// 警告！不要在这里写入任何敏感信息！
/**
 * 白名单：只有这 8 个字段会被下发到浏览器
 * 全是"功能开关 + 模型名单"，没有任何 apiKey / codes / secret
 * 对照 server.ts 的返回值看：那里有 60+ 个字段，这里只放行 8 个——
 * 这个"扔掉了什么"就是密钥隔离的第二道墙（第一道是 server bundle 划分）
 */
const DANGER_CONFIG = {
  needCode: serverConfig.needCode,
  hideUserApiKey: serverConfig.hideUserApiKey,
  disableGPT4: serverConfig.disableGPT4,
  hideBalanceQuery: serverConfig.hideBalanceQuery,
  disableFastLink: serverConfig.disableFastLink,
  customModels: serverConfig.customModels,
  defaultModel: serverConfig.defaultModel,
  visionModels: serverConfig.visionModels,
};

/**
 * 全局类型导出：让前端代码能用 DangerConfig 类型标注
 * （declare global 是 TS 的全局类型注入，无需 import）
 */
declare global {
  type DangerConfig = typeof DANGER_CONFIG;
}

/**
 * GET 和 POST 共用同一个 handler —— 纯只读接口，无副作用
 * 前端入口：app/store/config.ts 里 fetch("/api/config") 拉取后
 * 通过 createDangerLruCache 缓存，避免重复请求
 */
async function handle() {
  return NextResponse.json(DANGER_CONFIG);
}

export const GET = handle;
export const POST = handle;

/**
 * runtime = "edge"：本路由跑在 Edge Runtime（CDN 边缘节点）
 * 为什么它可以 edge：只做环境变量挑选，不依赖 Node 专属能力（无 fs/数据库）
 * ★ 对比考点：你的网关涉及 SQLite 读写，只能跑 Node runtime——
 *   这就是"什么接口能上边缘、什么不能"的活例子
 * 延伸说明：edge 意味着这段代码可能跑在 Vercel 全球节点上，
 *   每个节点各自读环境变量（所以配置必须无状态、只读）
 */
export const runtime = "edge";
