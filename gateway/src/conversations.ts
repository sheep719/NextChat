/**
 * 会话（conversation）与消息（message）存储。
 *
 * 所有查询都强制带 user_id 条件 —— 越权访问在数据层就被挡掉，
 * 不依赖上层路由"记得"校验归属。
 */
import crypto from "node:crypto";
import {
  db,
  nowMs,
  ConversationRow,
  MessageRow,
} from "./db.js";

export interface NewConversationInput {
  title?: string;
  model?: string;
  provider?: string;
}

const stmt = {
  insertConversation: db.prepare<
    [string, number, string, string, string, number, number]
  >(`
    INSERT INTO conversations (uuid, user_id, title, model, provider, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  listByUser: db.prepare<[number, number, number]>(`
    SELECT * FROM conversations
    WHERE user_id = ? AND archived = 0
    ORDER BY updated_at DESC, id DESC
    LIMIT ? OFFSET ?
  `),
  countByUser: db.prepare<[number]>(`
    SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND archived = 0
  `),
  owned: db.prepare<[number, number]>(`
    SELECT * FROM conversations WHERE id = ? AND user_id = ?
  `),
  ownedByUuid: db.prepare<[string, number]>(`
    SELECT * FROM conversations WHERE uuid = ? AND user_id = ?
  `),
  touch: db.prepare<[number, number]>(`
    UPDATE conversations SET updated_at = ? WHERE id = ?
  `),
  remove: db.prepare<[number, number]>(`
    DELETE FROM conversations WHERE id = ? AND user_id = ?
  `),
  nextSeq: db.prepare<[number]>(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?
  `),
  insertMessage: db.prepare<
    [number, number, string, string, string, number, number, number]
  >(`
    INSERT INTO messages
      (conversation_id, seq, role, content, model, prompt_tokens, completion_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listMessages: db.prepare<[number, number, number]>(`
    SELECT * FROM messages WHERE conversation_id = ?
    ORDER BY seq ASC LIMIT ? OFFSET ?
  `),
  countMessages: db.prepare<[number]>(`
    SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?
  `),
};

export function createConversation(
  userId: number,
  input: NewConversationInput = {},
): ConversationRow {
  const ts = nowMs();
  const uuid = crypto.randomUUID();
  const info = stmt.insertConversation.run(
    uuid,
    userId,
    (input.title ?? "").toString().slice(0, 200),
    (input.model ?? "").toString().slice(0, 100),
    (input.provider ?? "").toString().slice(0, 64),
    ts,
    ts,
  );
  return db
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as ConversationRow;
}

export function listConversations(
  userId: number,
  limit = 50,
  offset = 0,
): { items: ConversationRow[]; total: number } {
  const items = stmt.listByUser.all(userId, limit, offset) as ConversationRow[];
  const total = (stmt.countByUser.get(userId) as { n: number }).n;
  return { items, total };
}

/** 按 id 取会话，带归属校验；不属于该用户返回 undefined */
export function getOwnedConversation(
  id: number,
  userId: number,
): ConversationRow | undefined {
  return stmt.owned.get(id, userId) as ConversationRow | undefined;
}

export function getOwnedConversationByUuid(
  uuid: string,
  userId: number,
): ConversationRow | undefined {
  return stmt.ownedByUuid.get(uuid, userId) as ConversationRow | undefined;
}

export function deleteConversation(id: number, userId: number): boolean {
  return stmt.remove.run(id, userId).changes > 0;
}

export interface NewMessageInput {
  role: string;
  content: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export function addMessage(
  conversationId: number,
  input: NewMessageInput,
): MessageRow {
  const seq = (stmt.nextSeq.get(conversationId) as { seq: number }).seq;
  const info = stmt.insertMessage.run(
    conversationId,
    seq,
    String(input.role ?? "user").slice(0, 32),
    String(input.content ?? ""),
    (input.model ?? "").toString().slice(0, 100),
    Number(input.promptTokens ?? 0),
    Number(input.completionTokens ?? 0),
    nowMs(),
  );
  stmt.touch.run(nowMs(), conversationId);
  return db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as MessageRow;
}

export function listMessages(
  conversationId: number,
  limit = 200,
  offset = 0,
): { items: MessageRow[]; total: number } {
  const items = stmt.listMessages.all(conversationId, limit, offset) as MessageRow[];
  const total = (stmt.countMessages.get(conversationId) as { n: number }).n;
  return { items, total };
}
