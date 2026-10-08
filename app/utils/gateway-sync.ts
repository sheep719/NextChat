/**
 * 会话云端同步（整包快照方案）。
 *
 * 为什么是整包快照：ChatSession 结构复杂且会演进（mask / memoryPrompt / stat / tools …），
 * 逐字段映射进关系表必然丢字段。这里把整份 sessions 当一个不透明 JSON 快照存网关，
 * 换取"换设备看到的和原来一模一样"。
 *
 * 时序（关键）：
 *   1. 应用启动/登录 → pull()：拉云端快照，与本地按 session.lastUpdate 合并
 *   2. 合并结果写回本地 store，并立刻 push 一次（让"本地独有的会话"上线）
 *   3. 之后会话变更 → subscribe 触发 debounce 上传（3s）
 *
 * 冲突：PUT 带 baseUpdatedAt（上次拉/推时服务端的 updatedAt），
 * 服务端更旧则直接写；服务端更新 → 409，拉取服务端最新再合并后重试一次。
 */
import { useEffect, useState } from "react";
import { SYNC_STATE_KEY } from "../constant";
import { ChatSession, useChatStore } from "../store/chat";
import { normalizeBase, useAuthStore } from "../store/auth";

const SYNC_DEBOUNCE_MS = 3000;
const MAX_PUSH_RETRY = 1;

/** 同步日志前缀（浏览器控制台可用 `[cloud-sync]` 过滤） */
const TAG = "[cloud-sync]";

export interface ChatSnapshot {
  /** 前端 StoreKey.Chat 的版本，便于将来做结构性迁移 */
  schema?: number;
  sessions: ChatSession[];
  exportedAt?: number;
}

interface PullResult {
  status: "idle" | "ok" | "empty" | "failed";
  pulled: number;
  message?: string;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/** 两个会话集合按 id 合并，保留 lastUpdate 较新的一份 */
export function mergeSessions(
  local: ChatSession[],
  remote: ChatSession[],
): ChatSession[] {
  const map = new Map<string, ChatSession>();
  for (const s of local ?? []) {
    if (s?.id) map.set(s.id, s);
  }
  for (const s of remote ?? []) {
    if (!s?.id) continue;
    const exist = map.get(s.id);
    const newer = !exist || (s.lastUpdate ?? 0) > (exist.lastUpdate ?? 0);
    if (newer) map.set(s.id, s);
  }
  return [...map.values()].sort(
    (a, b) => (b.lastUpdate ?? 0) - (a.lastUpdate ?? 0),
  );
}

class ChatSyncer {
  /** 服务端快照时间，作为下次 PUT 的乐观锁依据 */
  private serverUpdatedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pulling = false;
  private pushing = false;
  private lastSignature = "";
  private listeners = new Set<(s: SyncStatus) => void>();
  /** 首次合并是否已经做过"选中会话"决策（只在登录后的第一次 pull 生效） */
  private didInitialSelect = false;

  status: SyncStatus = { state: "idle", lastError: "", lastSyncTime: 0 };

  subscribe(fn: (s: SyncStatus) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((fn) => fn(this.status));
  }

  /**
   * 本地会话指纹，用于跳过无意义的上传。
   *
   * 必须基于**内容**而不是对象引用：ChatStore 更新消息时是就地 mutate 数组元素，
   * `state.sessions === prev.sessions` 会一直是 true（subscribe 里比引用会漏掉所有变更）。
   * 这里把 id / lastUpdate / 消息条数 / 正文总长度 / 主题一起算进指纹。
   */
  private signature(sessions: ChatSession[]) {
    return sessions
      .map((s) => {
        const body = (s.messages ?? []).reduce(
          (n, m) =>
            n +
            (typeof (m as any)?.content === "string"
              ? (m as any).content.length
              : 32),
          0,
        );
        return `${s.id}:${s.lastUpdate ?? 0}:${
          s.messages?.length ?? 0
        }:${body}:${s.topic ?? ""}`;
      })
      .join("|");
  }

  /**
   * 拉云端快照并与本地合并。
   * @returns 是否发生了本地写入（true 表示本地被云端更新过）
   */
  async pull(): Promise<PullResult> {
    const { token, gatewayUrl } = useAuthStore.getState();
    if (!token) return { status: "idle", pulled: 0 };
    if (this.pulling) return { status: "idle", pulled: 0 };
    this.pulling = true;
    this.emit({ state: "pulling", lastError: "" });

    try {
      console.log(TAG, "pulling", gatewayUrl);
      const res = await fetch(
        `${normalizeBase(gatewayUrl)}/api/sync/state?key=${encodeURIComponent(
          SYNC_STATE_KEY,
        )}`,
        { headers: authHeaders(token) },
      );
      if (!res.ok) {
        const msg = `拉取失败 HTTP ${res.status}`;
        console.error(TAG, msg);
        this.emit({ state: "failed", lastError: msg });
        return { status: "failed", pulled: 0, message: msg };
      }
      const json = await res.json();
      this.serverUpdatedAt = Number(json?.updatedAt ?? 0);

      const remoteSessions: ChatSession[] = json?.payload?.sessions ?? [];
      if (!remoteSessions.length) {
        // 云端没有：把本地现有会话顶上去（首次登录迁移）
        this.emit({ state: "ok", lastSyncTime: Date.now() });
        await this.push(true);
        return { status: "empty", pulled: 0 };
      }

      const localSessions = useChatStore.getState().sessions ?? [];
      const merged = mergeSessions(localSessions, remoteSessions);

      const changed =
        merged.length !== localSessions.length ||
        merged.some((s, i) => s !== localSessions[i]);

      if (changed) {
        useChatStore.getState().update((state) => {
          const prevId = state.sessions?.[state.currentSessionIndex]?.id;
          state.sessions = merged;

          // 1) 先尽量停在同一条会话上
          let nextIndex = merged.findIndex((s) => s.id === prevId);
          if (nextIndex < 0) {
            nextIndex = Math.min(state.currentSessionIndex, merged.length - 1);
          }
          if (nextIndex < 0) nextIndex = 0; // merged 为空时兜底

          // 2) 登录后的首次恢复：当前停在空会话、而云端有带内容的会话时，
          //    自动切到最近一条有内容的会话。
          //    否则换设备后默认停在"新建的空会话"上，用户会以为历史没同步过来。
          if (!this.didInitialSelect) {
            this.didInitialSelect = true;
            const currentHasMessages =
              (merged[nextIndex]?.messages?.length ?? 0) > 0;
            if (!currentHasMessages) {
              const newestWithMessages = merged.findIndex(
                (s) => (s.messages?.length ?? 0) > 0,
              );
              if (newestWithMessages >= 0) nextIndex = newestWithMessages;
            }
          }

          state.currentSessionIndex = nextIndex;
        });
      }

      this.lastSignature = this.signature(merged);
      this.emit({ state: "ok", lastSyncTime: Date.now() });
      useAuthStore.getState().markSyncTime();

      // 本地可能有云端没有的会话，合并后回推一次
      await this.push(true);
      return { status: "ok", pulled: remoteSessions.length };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.emit({ state: "failed", lastError: msg });
      return { status: "failed", pulled: 0, message: msg };
    } finally {
      this.pulling = false;
    }
  }

  /** 去抖上传 */
  schedulePush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.push();
    }, SYNC_DEBOUNCE_MS);
  }

  async push(force = false, retry = 0): Promise<boolean> {
    const { token, gatewayUrl } = useAuthStore.getState();
    if (!token) return false;
    if (this.pushing) return false;

    const sessions = useChatStore.getState().sessions ?? [];
    const sig = this.signature(sessions);
    if (!force && sig === this.lastSignature) return true; // 没变就不传

    console.log(TAG, "pushing", sessions.length, "sessions");
    this.pushing = true;
    this.emit({ state: "pushing", lastError: "" });

    const snapshot: ChatSnapshot = {
      schema: 1,
      sessions,
      exportedAt: Date.now(),
    };

    try {
      const res = await fetch(`${normalizeBase(gatewayUrl)}/api/sync/state`, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({
          key: SYNC_STATE_KEY,
          payload: snapshot,
          baseUpdatedAt: this.serverUpdatedAt,
        }),
      });

      if (res.status === 409) {
        // 云端被别的设备改过：拉下来合并再重试一次
        const json = await res.json();
        const remoteSessions: ChatSession[] =
          json?.server?.payload?.sessions ?? [];
        this.serverUpdatedAt = Number(json?.server?.updatedAt ?? 0);

        const merged = mergeSessions(sessions, remoteSessions);
        useChatStore.getState().update((state) => {
          state.sessions = merged;
        });
        this.lastSignature = this.signature(merged);

        if (retry < MAX_PUSH_RETRY) {
          this.pushing = false;
          return this.push(true, retry + 1);
        }
        return false;
      }

      if (!res.ok) {
        const msg = `上传失败 HTTP ${res.status}`;
        console.error(TAG, msg);
        this.emit({ state: "failed", lastError: msg });
        return false;
      }

      console.log(TAG, "push ok");

      const json = await res.json();
      this.serverUpdatedAt = Number(json?.updatedAt ?? this.serverUpdatedAt);
      this.lastSignature = sig;
      this.emit({ state: "ok", lastSyncTime: Date.now() });
      useAuthStore.getState().markSyncTime();
      return true;
    } catch (e: any) {
      this.emit({ state: "failed", lastError: e?.message ?? String(e) });
      return false;
    } finally {
      this.pushing = false;
    }
  }

  reset() {
    this.serverUpdatedAt = 0;
    this.lastSignature = "";
    this.didInitialSelect = false;
    this.emit({ state: "idle", lastError: "", lastSyncTime: 0 });
  }
}

export interface SyncStatus {
  state: "idle" | "pulling" | "pushing" | "ok" | "failed";
  lastError: string;
  lastSyncTime: number;
}

export const chatSyncer = new ChatSyncer();

/** 订阅同步状态（用于设置页展示"上次同步时间 / 是否失败"） */
export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(chatSyncer.status);
  useEffect(() => {
    const unsubscribe = chatSyncer.subscribe(setStatus);
    return () => {
      unsubscribe();
    };
  }, []);
  return status;
}

/**
 * 会话 → 云端自动同步：
 * - 已登录且 hydration 完成 → 拉一次
 * - ChatStore 变更 → 去抖上传
 * - 卸载/登出 → 清定时器
 */
/**
 * 等 ChatStore 从 IndexedDB 恢复完成。
 *
 * 这是必须的：若 pull 发生在 hydration 之前，`getState().sessions` 还是默认的空会话，
 * 于是 ① 会把"只有一条空会话"的快照推上去覆盖云端；② 合并写回本地后，
 * 紧接着的 hydration 又会用本地旧数据把合并结果覆盖掉——表现为"换设备看不到历史"。
 */
async function waitForChatHydration(timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  while (!useChatStore.getState()._hasHydrated) {
    if (Date.now() - t0 > timeoutMs) {
      console.warn(TAG, "chat store hydration 超时，按当前状态继续");
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function useCloudSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    let unsub: (() => void) | undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const start = async () => {
      await waitForChatHydration();
      if (cancelled) return;
      await chatSyncer.pull();
      if (cancelled) return;

      console.log(TAG, "start: subscribing chat store");
      // 注意：这里**不能**用 `state.sessions === prev.sessions` 判断——ChatStore 就地 mutate，
      // 引用永远相同。交给 push() 内部按内容指纹去重。
      unsub = useChatStore.subscribe(() => {
        chatSyncer.schedulePush();
      });
    };

    start();

    return () => {
      cancelled = true;
      unsub?.();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
