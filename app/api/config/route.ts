/**
 * /api/config — 服务端配置的安全子集下发接口
 *
 * 前端不直接读取 process.env 的原因：
 *   1. 前端 bundle 中只会注入 NEXT_PUBLIC_ 前缀的变量，服务端变量本就不可见；
 *   2. 密钥类配置不可下发，因此本接口采用白名单方式人工挑选，
 *      从 getServerSideConfig() 的返回值中只取 8 个非敏感字段。
 *
 * 与 server.ts 的分工：
 *   server.ts 持有全量服务端配置（含各厂商 apiKey、访问码等）；
 *   本文件从中挑出 UI 所需的布尔开关与模型清单返回给前端。
 *   前端据 DANGER_CONFIG 决定设置页的展示逻辑：
 *   needCode=true 时弹出访问码输入框；hideUserApiKey=true 时隐藏密钥输入框；
 *   disableGPT4=true 时模型列表剔除 GPT4 系列，customModels 中的 "-" 前缀同理。
 *
 * 命名说明：DANGER_CONFIG 是上游沿用的警示命名，该对象会被整体发送至浏览器，
 * 新增字段前需确认其是否适合公开。
 */
import { NextResponse } from "next/server";

import { getServerSideConfig } from "../../config/server";

// 模块加载时取一次配置（不是每次请求都读环境变量）
const serverConfig = getServerSideConfig();

// Danger! Do not hard code any secret value here!
// 警告！不要在这里写入任何敏感信息！
/**
 * 白名单：仅以下 8 个字段会下发至浏览器
 * 全部为功能开关与模型名单，不含任何 apiKey、访问码或 secret。
 * 对照 getServerSideConfig() 的返回值（60+ 个字段），此处只放行 8 个，
 * 未下发的部分即密钥隔离的实际边界。
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
 * 全局类型导出：供前端代码以 DangerConfig 类型标注
 * （declare global 为 TS 的全局类型注入，使用方无需 import）
 */
declare global {
  type DangerConfig = typeof DANGER_CONFIG;
}

/**
 * GET 与 POST 复用同一 handler：纯只读接口，无副作用
 * 前端入口：app/store/config.ts 中 fetch("/api/config")，结果经
 * createDangerLruCache 缓存，避免重复请求
 */
async function handle() {
  return NextResponse.json(DANGER_CONFIG);
}

export const GET = handle;
export const POST = handle;

/**
 * runtime = "edge"：本路由运行于 Edge Runtime（CDN 边缘节点）
 * 可以部署到边缘的原因：仅做环境变量挑选，不依赖 Node 专属能力（fs、数据库等）。
 * 对照：涉及 SQLite 读写的接口只能使用 Node runtime。
 * 边缘环境下每个节点各自读取环境变量，因此配置需保持无状态、只读。
 */
export const runtime = "edge";
