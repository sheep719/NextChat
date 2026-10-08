/**
 * SQLite 数据层（better-sqlite3，同步 API）。
 *
 * 设计约定
 * - 库文件默认 `gateway/data/gateway.db`，由 `DB_PATH` 覆盖（相对路径按网关 cwd 解析）。
 * - 建表用 `CREATE TABLE IF NOT EXISTS`，可重复执行，即"迁移"——进程启动时跑一次。
 * - 时间统一存 epoch 毫秒（INTEGER），避免时区/字符串格式问题。
 * - 外键级联开启（`PRAGMA foreign_keys = ON`），删用户即删其会话与消息。
 * - SQLite 起步：后续换 Postgres/MySQL 只需替换本文件，上层 `users.ts` / `conversations.ts` 不动。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadEnv } from "./env.js";

loadEnv();

export const DB_PATH = (process.env.DB_PATH || "data/gateway.db").trim();

export const nowMs = (): number => Date.now();

/** 建表语句：幂等，可重复执行 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT             UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       TEXT    NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL DEFAULT '',
  model      TEXT    NOT NULL DEFAULT '',
  provider   TEXT    NOT NULL DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_user
  ON conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  model           TEXT    NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv
  ON messages (conversation_id, seq);

-- 云端状态快照：前端整包状态（如 ChatStore 的会话集合）按 key 存一份。
-- payload 是不透明 JSON，网关不解析其内容——协议演进不需要改表结构。
CREATE TABLE IF NOT EXISTS cloud_state (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_key  TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, state_key)
);
`;

function resolveDbPath(): string {
  const p = path.isAbsolute(DB_PATH) ? DB_PATH : path.resolve(process.cwd(), DB_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

export const db = new Database(resolveDbPath());

db.pragma("journal_mode = WAL"); // 读写并发更好
db.pragma("foreign_keys = ON"); // 启用外键级联
db.exec(SCHEMA);

/* ================================ 行类型 ================================ */

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  password_hash: string;
  role: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ConversationRow {
  id: number;
  uuid: string;
  user_id: number;
  title: string;
  model: string;
  provider: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  seq: number;
  role: string;
  content: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: number;
}

/** 云端状态快照行 */
export interface CloudStateRow {
  user_id: number;
  state_key: string;
  payload: string;
  version: number;
  updated_at: number;
}

/** 对外暴露的用户信息（永远不含 password_hash） */
export interface PublicUser {
  id: number;
  username: string;
  email: string | null;
  role: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
