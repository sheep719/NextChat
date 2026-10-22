/**
 * access.ts — 访问控制与厂商配置的 zustand store（前端层）
 *
 * 职责：
 * 1. 用户自填厂商配置（url / apiKey / accessCode）的本地持久化；
 * 2. 从 /api/config 拉取服务端下发的 8 个功能开关。
 *
 * 边界说明：本文件中的校验（isValidXxx / isAuthorized）属于前端拦截，
 * 用于决定 UI 显隐与是否发起请求；真正的鉴权在服务端 app/api/auth.ts。
 * 前端校验无法阻止伪造请求直接调用接口，两层各司其职。
 */
import {
  GoogleSafetySettingsThreshold,
  ServiceProvider,
  StoreKey,
  ApiPath,
  OPENAI_BASE_URL,
  ANTHROPIC_BASE_URL,
  GEMINI_BASE_URL,
  BAIDU_BASE_URL,
  BYTEDANCE_BASE_URL,
  ALIBABA_BASE_URL,
  TENCENT_BASE_URL,
  MOONSHOT_BASE_URL,
  STABILITY_BASE_URL,
  IFLYTEK_BASE_URL,
  DEEPSEEK_BASE_URL,
  XAI_BASE_URL,
  CHATGLM_BASE_URL,
  SILICONFLOW_BASE_URL,
  AI302_BASE_URL,
} from "../constant";
import { getHeaders } from "../client/api";
import { getClientConfig } from "../config/client";
import { createPersistStore } from "../utils/store";
import { ensure } from "../utils/clone";
import { DEFAULT_CONFIG } from "./config";
import { getModelProvider } from "../utils/model";

let fetchState = 0; // 0 not fetch, 1 fetching, 2 done

// ── 构建形态决定请求走向 ─────────────────────────────────────
// isApp = true（桌面版 export 构建）：直连厂商官网 base URL（没有服务端可用）
// isApp = false（Web 版）：走自家服务端代理路由 /api/xxx（ApiPath）
// 这就是 ApiPath 存在的原因——Web 版请求必须过服务端一道，密钥才能留在后端
const isApp = getClientConfig()?.buildMode === "export";

const DEFAULT_OPENAI_URL = isApp ? OPENAI_BASE_URL : ApiPath.OpenAI;

const DEFAULT_GOOGLE_URL = isApp ? GEMINI_BASE_URL : ApiPath.Google;

const DEFAULT_ANTHROPIC_URL = isApp ? ANTHROPIC_BASE_URL : ApiPath.Anthropic;

const DEFAULT_BAIDU_URL = isApp ? BAIDU_BASE_URL : ApiPath.Baidu;

const DEFAULT_BYTEDANCE_URL = isApp ? BYTEDANCE_BASE_URL : ApiPath.ByteDance;

const DEFAULT_ALIBABA_URL = isApp ? ALIBABA_BASE_URL : ApiPath.Alibaba;

const DEFAULT_TENCENT_URL = isApp ? TENCENT_BASE_URL : ApiPath.Tencent;

const DEFAULT_MOONSHOT_URL = isApp ? MOONSHOT_BASE_URL : ApiPath.Moonshot;

const DEFAULT_STABILITY_URL = isApp ? STABILITY_BASE_URL : ApiPath.Stability;

const DEFAULT_IFLYTEK_URL = isApp ? IFLYTEK_BASE_URL : ApiPath.Iflytek;

const DEFAULT_DEEPSEEK_URL = isApp ? DEEPSEEK_BASE_URL : ApiPath.DeepSeek;

const DEFAULT_XAI_URL = isApp ? XAI_BASE_URL : ApiPath.XAI;

const DEFAULT_CHATGLM_URL = isApp ? CHATGLM_BASE_URL : ApiPath.ChatGLM;

const DEFAULT_SILICONFLOW_URL = isApp
  ? SILICONFLOW_BASE_URL
  : ApiPath.SiliconFlow;

const DEFAULT_AI302_URL = isApp ? AI302_BASE_URL : ApiPath["302.AI"];

/**
 * 访问 store 的默认状态，分为三部分：
 * 1. 用户输入：accessCode / useCustomConfig / provider；
 * 2. 16 家厂商的 url 与 key（用户在设置页填写后覆盖默认值）；
 * 3. 服务端下发的 8 个开关字段（见 api/config/route.ts 的 DANGER_CONFIG），
 *    fetch() 成功后覆盖此处初始值。
 *
 * 两类配置的持久化策略不同：用户填写的 apiKey 持久化到 localStorage；
 * 服务端下发的配置不持久化，每次启动重新拉取。
 */
const DEFAULT_ACCESS_STATE = {
  accessCode: "",
  useCustomConfig: false,

  provider: ServiceProvider.OpenAI,

  // openai
  openaiUrl: DEFAULT_OPENAI_URL,
  openaiApiKey: "",

  // azure
  azureUrl: "",
  azureApiKey: "",
  azureApiVersion: "2023-08-01-preview",

  // google ai studio
  googleUrl: DEFAULT_GOOGLE_URL,
  googleApiKey: "",
  googleApiVersion: "v1",
  googleSafetySettings: GoogleSafetySettingsThreshold.BLOCK_ONLY_HIGH,

  // anthropic
  anthropicUrl: DEFAULT_ANTHROPIC_URL,
  anthropicApiKey: "",
  anthropicApiVersion: "2023-06-01",

  // baidu
  baiduUrl: DEFAULT_BAIDU_URL,
  baiduApiKey: "",
  baiduSecretKey: "",

  // bytedance
  bytedanceUrl: DEFAULT_BYTEDANCE_URL,
  bytedanceApiKey: "",

  // alibaba
  alibabaUrl: DEFAULT_ALIBABA_URL,
  alibabaApiKey: "",

  // moonshot
  moonshotUrl: DEFAULT_MOONSHOT_URL,
  moonshotApiKey: "",

  //stability
  stabilityUrl: DEFAULT_STABILITY_URL,
  stabilityApiKey: "",

  // tencent
  tencentUrl: DEFAULT_TENCENT_URL,
  tencentSecretKey: "",
  tencentSecretId: "",

  // iflytek
  iflytekUrl: DEFAULT_IFLYTEK_URL,
  iflytekApiKey: "",
  iflytekApiSecret: "",

  // deepseek
  deepseekUrl: DEFAULT_DEEPSEEK_URL,
  deepseekApiKey: "",

  // xai
  xaiUrl: DEFAULT_XAI_URL,
  xaiApiKey: "",

  // chatglm
  chatglmUrl: DEFAULT_CHATGLM_URL,
  chatglmApiKey: "",

  // siliconflow
  siliconflowUrl: DEFAULT_SILICONFLOW_URL,
  siliconflowApiKey: "",

  // 302.AI
  ai302Url: DEFAULT_AI302_URL,
  ai302ApiKey: "",

  // server config
  needCode: true,
  hideUserApiKey: false,
  hideBalanceQuery: false,
  disableGPT4: false,
  disableFastLink: false,
  customModels: "",
  defaultModel: "",
  visionModels: "",

  // tts config
  edgeTTSVoiceName: "zh-CN-YunxiNeural",
};

/**
 * createPersistStore：zustand + persist 中间件封装（见 utils/store.ts）
 * name = StoreKey.Access = "access-control" → localStorage 的键名
 * 打开浏览器 DevTools → Application → Local Storage 能看到这个键，
 * 里面就是用户填的所有厂商 key（明文存本地——已知风险，见安全评估）
 */
export const useAccessStore = createPersistStore(
  { ...DEFAULT_ACCESS_STATE },

  (set, get) => ({
    enabledAccessControl() {
      this.fetch();

      return get().needCode;
    },
    getVisionModels() {
      this.fetch();
      return get().visionModels;
    },
    edgeVoiceName() {
      this.fetch();

      return get().edgeTTSVoiceName;
    },

    isValidOpenAI() {
      return ensure(get(), ["openaiApiKey"]);
    },

    isValidAzure() {
      return ensure(get(), ["azureUrl", "azureApiKey", "azureApiVersion"]);
    },

    isValidGoogle() {
      return ensure(get(), ["googleApiKey"]);
    },

    isValidAnthropic() {
      return ensure(get(), ["anthropicApiKey"]);
    },

    isValidBaidu() {
      return ensure(get(), ["baiduApiKey", "baiduSecretKey"]);
    },

    isValidByteDance() {
      return ensure(get(), ["bytedanceApiKey"]);
    },

    isValidAlibaba() {
      return ensure(get(), ["alibabaApiKey"]);
    },

    isValidTencent() {
      return ensure(get(), ["tencentSecretKey", "tencentSecretId"]);
    },

    isValidMoonshot() {
      return ensure(get(), ["moonshotApiKey"]);
    },
    isValidIflytek() {
      return ensure(get(), ["iflytekApiKey"]);
    },
    isValidDeepSeek() {
      return ensure(get(), ["deepseekApiKey"]);
    },

    isValidXAI() {
      return ensure(get(), ["xaiApiKey"]);
    },

    isValidChatGLM() {
      return ensure(get(), ["chatglmApiKey"]);
    },

    isValidSiliconFlow() {
      return ensure(get(), ["siliconflowApiKey"]);
    },

    /**
     * isAuthorized：判断当前是否具备可用配置
     * 判定逻辑为或关系 —— 16 家厂商任一配置了 key，或未启用访问控制，
     * 或已填写访问码，任一条件满足即放行。
     *
     * 该判断仅作用于前端（控制页面跳转与请求发起），
     * 服务端鉴权见 app/api/auth.ts。
     */
    isAuthorized() {
      this.fetch();

      // has token or has code or disabled access control
      return (
        this.isValidOpenAI() ||
        this.isValidAzure() ||
        this.isValidGoogle() ||
        this.isValidAnthropic() ||
        this.isValidBaidu() ||
        this.isValidByteDance() ||
        this.isValidAlibaba() ||
        this.isValidTencent() ||
        this.isValidMoonshot() ||
        this.isValidIflytek() ||
        this.isValidDeepSeek() ||
        this.isValidXAI() ||
        this.isValidChatGLM() ||
        this.isValidSiliconFlow() ||
        !this.enabledAccessControl() ||
        (this.enabledAccessControl() && ensure(get(), ["accessCode"]))
      );
    },
    /**
     * fetch：从前端获取服务端配置的入口
     *
     * 三个实现细节：
     * 1. fetchState 防重入：状态 0 → 1 → 2，只发起一次请求，后续调用直接复用结果
     *    （store 中各 getter 均先调用 this.fetch()，实现惰性初始化）；
     * 2. isApp 时直接跳过：桌面版无服务端，无法获取配置；
     * 3. defaultModel 需特殊处理：服务端下发的 defaultModel 要解析出厂商名，
     *    再回写 DEFAULT_CONFIG.modelConfig，即默认模型由服务端决定。
     */
    fetch() {
      if (fetchState > 0 || getClientConfig()?.buildMode === "export") return;
      fetchState = 1;
      fetch("/api/config", {
        method: "post",
        body: null,
        headers: {
          ...getHeaders(),
        },
      })
        .then((res) => res.json())
        .then((res) => {
          const defaultModel = res.defaultModel ?? "";
          if (defaultModel !== "") {
            const [model, providerName] = getModelProvider(defaultModel);
            DEFAULT_CONFIG.modelConfig.model = model;
            DEFAULT_CONFIG.modelConfig.providerName = providerName as any;
          }

          return res;
        })
        .then((res: DangerConfig) => {
          console.log("[Config] got config from server", res);
          set(() => ({ ...res }));
        })
        .catch(() => {
          console.error("[Config] failed to fetch config");
        })
        .finally(() => {
          fetchState = 2;
        });
    },
  }),
  {
    name: StoreKey.Access,
    version: 2,
    /**
     * localStorage schema 迁移：v1 的 token 字段在 v2 中更名为 openaiApiKey
     * 持久化数据结构变更时无法直接重置，只能通过 migrate 做字段映射，
     * 否则老用户升级后已保存的配置会丢失。
     */
    migrate(persistedState, version) {
      if (version < 2) {
        const state = persistedState as {
          token: string;
          openaiApiKey: string;
          azureApiVersion: string;
          googleApiKey: string;
        };
        state.openaiApiKey = state.token;
        state.azureApiVersion = "2023-08-01-preview";
      }

      return persistedState as any;
    },
  },
);
