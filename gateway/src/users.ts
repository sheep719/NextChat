/**
 * 用户存储与口令安全。
 *
 * - 口令用 scrypt（node:crypto，无外部依赖）加盐哈希，存 `scrypt$<saltHex>$<hashHex>`；
 *   校验用 timingSafeEqual，避免时序侧信道。
 * - 登录成功签发的是**网关那套 JWT**（见 auth.ts），只是多了 `typ: "user"` 与 `uid`，
 *   因此一套鉴权贯穿全网关，聊天接口可直接认它。
 * - 对外返回一律走 `toPublicUser()`，password_hash 永不出库。
 */
import crypto from "node:crypto";
import { db, nowMs, toPublicUser, PublicUser, UserRow } from "./db.js";
import { signJwt } from "./auth.js";

/** 登录令牌默认有效期（秒）——7 天，对齐验收标准 AC-USER-03 */
export const USER_TOKEN_TTL_SEC = Number(
  process.env.USER_TOKEN_TTL_SEC || 7 * 24 * 3600,
);

/** 用户令牌的 scope：可聊天、可看模型、可读写自己的会话 */
export const USER_SCOPES = [
  "chat.completions",
  "models.read",
  "conversation.read",
  "conversation.write",
];

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;
export const MIN_PASSWORD_LEN = 8;
export const MAX_PASSWORD_LEN = 128;

/* ============================== 口令哈希 ============================== */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, salt, hash] = (stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  let calc: Buffer;
  try {
    calc = crypto.scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
}

/* ============================== 校验 ============================== */

export function checkUsername(username: string): string | null {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return "用户名需为 3-32 位字母、数字、下划线或连字符";
  }
  return null;
}

export function checkPassword(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
    return `口令至少 ${MIN_PASSWORD_LEN} 位`;
  }
  if (password.length > MAX_PASSWORD_LEN) {
    return `口令最长 ${MAX_PASSWORD_LEN} 位`;
  }
  return null;
}

export function checkEmail(email?: string | null): string | null {
  if (email === undefined || email === null || email === "") return null; // 允许为空
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "邮箱格式不正确";
  }
  return null;
}

/* ============================== 查询 ============================== */

const stmt = {
  insertUser: db.prepare<[string, string | null, string, number, number]>(`
    INSERT INTO users (username, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  byUsername: db.prepare<[string]>(`SELECT * FROM users WHERE username = ?`),
  byId: db.prepare<[number]>(`SELECT * FROM users WHERE id = ?`),
  count: db.prepare(`SELECT COUNT(*) AS n FROM users`),
};

export function findUserByUsername(username: string): UserRow | undefined {
  return stmt.byUsername.get(username) as UserRow | undefined;
}

export function findUserById(id: number): UserRow | undefined {
  return stmt.byId.get(id) as UserRow | undefined;
}

export function countUsers(): number {
  return (stmt.count.get() as { n: number }).n;
}

export interface CreateUserInput {
  username: string;
  password: string;
  email?: string | null;
}

export type CreateUserResult =
  | { ok: true; user: PublicUser }
  | { ok: false; code: string; message: string };

export function createUser(input: CreateUserInput): CreateUserResult {
  const username = String(input?.username ?? "").trim();
  const password = String(input?.password ?? "");
  const email = (input?.email ?? "").toString().trim() || null;

  const bad =
    checkUsername(username) ?? checkPassword(password) ?? checkEmail(email);
  if (bad) return { ok: false, code: "invalid_input", message: bad };

  if (findUserByUsername(username)) {
    return { ok: false, code: "username_taken", message: `用户名 "${username}" 已被占用` };
  }

  const ts = nowMs();
  const info = stmt.insertUser.run(username, email, hashPassword(password), ts, ts);
  const row = findUserById(Number(info.lastInsertRowid))!;
  return { ok: true, user: toPublicUser(row) };
}

/** 校验登录口令；失败返回 null（不区分"用户不存在"与"口令错误"，避免账号枚举） */
export function verifyCredentials(username: string, password: string): UserRow | null {
  const row = findUserByUsername(String(username ?? "").trim());
  if (!row) {
    // 走一次同等开销的哈希，避免通过响应时间判断账号是否存在
    crypto.scryptSync(password, "dummy-salt-for-timing", 64);
    return null;
  }
  if (!verifyPassword(password, row.password_hash)) return null;
  if (row.status !== "active") return null;
  return row;
}

/* ============================ 令牌签发 ============================ */

export function issueUserToken(user: UserRow | PublicUser, ttlSec = USER_TOKEN_TTL_SEC) {
  const { token, expiresIn, exp } = signJwt({
    sub: `user:${user.id}`,
    ttlSec,
    scope: USER_SCOPES,
    // typ=user 是"登录用户"与"服务端/网关客户端"凭证的分界，聊天接口据此判定
    typ: "user",
    extra: { uid: user.id, username: user.username, role: (user as UserRow).role ?? "user" },
  });
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: expiresIn,
    expires_at: exp,
    user: toPublicUser(user as UserRow),
  };
}
