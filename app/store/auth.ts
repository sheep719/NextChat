/**
 * 自建网关的登录态 store。
 *
 * 职责边界：
 * - 只管"我是谁"：令牌、用户信息、网关地址
 * - 不碰会话数据（那是 useChatStore 的事），不管同步逻辑（那是 utils/gateway-sync.ts 的事）
 *
 * 登录后会把网关地址与令牌写进 useAccessStore（useCustomConfig + openaiUrl + openaiApiKey），
 * 这样聊天请求会带着 Authorization 直连网关——与网关的 CHAT_REQUIRE_USER=true 正好对上。
 */
import { DEFAULT_GATEWAY_URL, ServiceProvider, StoreKey } from "../constant";
import { createPersistStore } from "../utils/store";
import { useAccessStore } from "./access";

export interface GatewayUser {
  id: number;
  username: string;
  email: string | null;
  role: string;
  status: string;
}

interface AuthSuccess {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  user?: GatewayUser;
}

const DEFAULT_AUTH_STATE = {
  token: "",
  user: null as GatewayUser | null,
  gatewayUrl: normalizeBase(
    process.env.NEXT_PUBLIC_GATEWAY_URL || DEFAULT_GATEWAY_URL,
  ),
  /** 上次成功同步的时间戳，仅供 UI 展示 */
  lastSyncTime: 0,
};

export function normalizeBase(raw: string): string {
  return (raw || DEFAULT_GATEWAY_URL).trim().replace(/\/+$/, "");
}

async function callAuthApi(
  base: string,
  path: string,
  body: unknown,
): Promise<AuthSuccess> {
  const res = await fetch(normalizeBase(base) + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    throw new Error("网关返回了无法解析的内容");
  }

  if (!res.ok || !json?.access_token) {
    throw new Error(
      json?.error?.message || json?.message || `HTTP ${res.status}`,
    );
  }
  return json as AuthSuccess;
}

/**
 * 把网关地址与令牌写入 access store，让聊天请求直连网关。
 * 注意 openaiUrl 不带 /v1 —— NextChat 客户端会自己拼 "v1/chat/completions"。
 */
function bindToAccessStore(token: string, gatewayUrl: string) {
  const access = useAccessStore.getState();
  access.update((a) => {
    a.useCustomConfig = true;
    a.provider = ServiceProvider.OpenAI;
    a.openaiUrl = normalizeBase(gatewayUrl);
    a.openaiApiKey = token;
  });
}

export const useAuthStore = createPersistStore(
  DEFAULT_AUTH_STATE,
  (set, get) => ({
    setGatewayUrl(url: string) {
      set({ gatewayUrl: normalizeBase(url) });
    },

    markSyncTime() {
      set({ lastSyncTime: Date.now() });
    },

    async login(username: string, password: string): Promise<GatewayUser> {
      const base = get().gatewayUrl;
      const data = await callAuthApi(base, "/api/auth/login", {
        username: username.trim(),
        password,
      });
      bindToAccessStore(data.access_token, base);
      const user = data.user ?? (await fetchMe(base, data.access_token));
      set({ token: data.access_token, user });
      return user;
    },

    async register(
      username: string,
      password: string,
      email?: string,
    ): Promise<GatewayUser> {
      const base = get().gatewayUrl;
      const data = await callAuthApi(base, "/api/auth/register", {
        username: username.trim(),
        password,
        email: email?.trim() || undefined,
      });
      bindToAccessStore(data.access_token, base);
      const user = data.user ?? (await fetchMe(base, data.access_token));
      set({ token: data.access_token, user });
      return user;
    },

    /**
     * 校验当前令牌是否仍然有效（过期/被删会清空登录态）。
     * 返回 true 表示可以继续用。
     */
    async refresh(): Promise<boolean> {
      const { token, gatewayUrl } = get();
      if (!token) return false;
      try {
        const user = await fetchMe(gatewayUrl, token);
        set({ user });
        return true;
      } catch {
        set({ token: "", user: null, lastSyncTime: 0 });
        return false;
      }
    },

    logout() {
      // 保留本地会话数据，只清登录态——用户重新登录时可以再合并上传
      set({ token: "", user: null, lastSyncTime: 0 });
      const access = useAccessStore.getState();
      access.update((a) => {
        a.openaiApiKey = "";
      });
    },
  }),
  {
    name: StoreKey.Auth,
    version: 1,
  },
);

/** GET /api/auth/me —— 拿当前用户信息，顺带验证令牌 */
export async function fetchMe(
  base: string,
  token: string,
): Promise<GatewayUser> {
  const res = await fetch(normalizeBase(base) + "/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    throw new Error("网关返回了无法解析的内容");
  }
  if (!res.ok) {
    throw new Error(json?.error?.message || `HTTP ${res.status}`);
  }
  return (json.user ?? json) as GatewayUser;
}
