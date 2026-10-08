/**
 * 云端状态快照（cloud_state 表）访问层。
 *
 * 为什么是"快照"而不是逐条会话同步：
 * NextChat 的 ChatSession 结构复杂且会演进（mask / memoryPrompt / stat / tools …），
 * 逐字段映射进关系表必然丢字段。整包快照把 payload 当不透明 JSON 存，
 * 协议演进不用改表结构，也能保证"换浏览器看到的和原来一模一样"。
 *
 * 冲突策略：乐观锁。客户端 PUT 时带上它上次拉取到的 updatedAt（baseUpdatedAt），
 * 若服务端 updatedAt 更大，说明别的设备已经改过 → 返回冲突 + 服务端最新，
 * 由客户端合并后重试。这比"后写覆盖"安全，也不需要服务端理解会话结构。
 */
import { db, nowMs, type CloudStateRow } from "./db.js";

const selectStmt = db.prepare<[number, string]>(
  `SELECT * FROM cloud_state WHERE user_id = ? AND state_key = ?`,
);

// 注意：version 在首次插入时是常量 1，冲突时自增，所以只有 4 个占位符
const upsertStmt = db.prepare<[number, string, string, number]>(
  `INSERT INTO cloud_state (user_id, state_key, payload, version, updated_at)
   VALUES (?, ?, ?, 1, ?)
   ON CONFLICT (user_id, state_key)
   DO UPDATE SET payload = excluded.payload,
                 version = cloud_state.version + 1,
                 updated_at = excluded.updated_at`,
);

const listStmt = db.prepare<[number]>(
  `SELECT * FROM cloud_state WHERE user_id = ? ORDER BY updated_at DESC`,
);

const deleteStmt = db.prepare<[number, string]>(
  `DELETE FROM cloud_state WHERE user_id = ? AND state_key = ?`,
);

export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8MB，够几百个会话

export interface CloudStatePayload {
  payload: unknown;
  updatedAt: number;
  version: number;
}

export function getCloudState(
  userId: number,
  key: string,
): CloudStatePayload | null {
  const row = selectStmt.get(userId, key) as CloudStateRow | undefined;
  if (!row) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    parsed = null; // 坏数据不当机，交给上层处理
  }
  return { payload: parsed, updatedAt: row.updated_at, version: row.version };
}

export type PutCloudStateResult =
  | { ok: true; updatedAt: number; version: number }
  | { ok: false; conflict: true; server: CloudStatePayload };

/**
 * 写入快照。
 * @param baseUpdatedAt 客户端上次拉取到的 updatedAt；传 0/不传表示强制覆盖
 */
export function putCloudState(
  userId: number,
  key: string,
  payload: unknown,
  baseUpdatedAt?: number,
): PutCloudStateResult {
  const current = getCloudState(userId, key);
  if (
    baseUpdatedAt &&
    baseUpdatedAt > 0 &&
    current &&
    current.updatedAt > baseUpdatedAt
  ) {
    return { ok: false, conflict: true, server: current };
  }

  const serialized = JSON.stringify(payload ?? null);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    const err = new Error("payload_too_large");
    (err as any).statusCode = 413;
    throw err;
  }

  const ts = nowMs();
  // 同一毫秒内连续写会让 updatedAt 相同，乐观锁可能误判；
  // 这里取 max(now, current+1) 保证单调递增。
  const tsSafe = current && ts <= current.updatedAt ? current.updatedAt + 1 : ts;

  upsertStmt.run(userId, key, serialized, tsSafe);  const after = getCloudState(userId, key)!;
  return { ok: true, updatedAt: after.updatedAt, version: after.version };
}

export function listCloudState(userId: number) {
  const rows = listStmt.all(userId) as CloudStateRow[];
  return rows.map((r) => ({
    key: r.state_key,
    bytes: Buffer.byteLength(r.payload, "utf8"),
    version: r.version,
    updatedAt: r.updated_at,
  }));
}

export function deleteCloudState(userId: number, key: string): boolean {
  return deleteStmt.run(userId, key).changes > 0;
}
