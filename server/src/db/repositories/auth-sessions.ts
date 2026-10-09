// 登录会话仓储
//
// 安全要点：数据库里只存 token 的 SHA-256，明文 token 只存在于用户浏览器的 cookie 中。
// 这样即使数据库泄漏，也无法直接拿来登录。
import { createHash } from "node:crypto";
import { BaseRepo, newId, now } from "./base.ts";

export type AuthSessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  created_at: number;
  last_seen_at: number;
  user_agent: string | null;
  ip: string | null;
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class AuthSessionsRepo extends BaseRepo {
  create(input: {
    userId: string;
    tokenHash: string;
    ttlMs: number;
    userAgent?: string | null;
    ip?: string | null;
  }): AuthSessionRow {
    const id = newId();
    const ts = now();
    const expiresAt = ts + input.ttlMs;
    this.db.run(
      `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.tokenHash,
      expiresAt,
      ts,
      ts,
      input.userAgent ?? null,
      input.ip ?? null,
    );
    const row = this.findById(id);
    if (!row) throw new Error("创建会话后读取失败");
    return row;
  }

  findById(id: string): AuthSessionRow | undefined {
    return this.db.get<AuthSessionRow>("SELECT * FROM auth_sessions WHERE id = ?", id);
  }

  findByTokenHash(tokenHash: string): AuthSessionRow | undefined {
    return this.db.get<AuthSessionRow>("SELECT * FROM auth_sessions WHERE token_hash = ?", tokenHash);
  }

  /** 有效（未过期）会话 */
  findValidByTokenHash(tokenHash: string, at = now()): AuthSessionRow | undefined {
    return this.db.get<AuthSessionRow>(
      "SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > ?",
      tokenHash,
      at,
    );
  }

  touch(id: string, at = now()): void {
    this.db.run("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?", at, id);
  }

  /** 滑动续期：把过期时间往后推 */
  extend(id: string, ttlMs: number, at = now()): void {
    this.db.run("UPDATE auth_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?", at + ttlMs, at, id);
  }

  deleteByTokenHash(tokenHash: string): boolean {
    return Number(this.db.run("DELETE FROM auth_sessions WHERE token_hash = ?", tokenHash).changes) > 0;
  }

  deleteById(id: string): boolean {
    return Number(this.db.run("DELETE FROM auth_sessions WHERE id = ?", id).changes) > 0;
  }

  /** 删除某用户全部会话（改口令 / 封禁时调用） */
  deleteForUser(userId: string): number {
    return Number(this.db.run("DELETE FROM auth_sessions WHERE user_id = ?", userId).changes);
  }

  /** 清理过期会话，返回删除条数 */
  purgeExpired(at = now()): number {
    return Number(this.db.run("DELETE FROM auth_sessions WHERE expires_at <= ?", at).changes);
  }

  listForUser(userId: string): AuthSessionRow[] {
    return this.db.all<AuthSessionRow>(
      "SELECT * FROM auth_sessions WHERE user_id = ? ORDER BY last_seen_at DESC",
      userId,
    );
  }
}
