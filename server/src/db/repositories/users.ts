// 用户仓储
import { BaseRepo, newId, nn, now, toInt } from "./base.ts";
import type { Row } from "../client.ts";

export type UserRole = "user" | "admin";
export type UserStatus = "pending" | "approved" | "banned";

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  approved_by: string | null;
  approved_at: number | null;
  created_at: number;
  last_login_at: number | null;
};

export type CreateUserInput = {
  email: string;
  passwordHash: string;
  displayName: string;
  role?: UserRole;
  status?: UserStatus;
  approvedBy?: string | null;
};

export class UsersRepo extends BaseRepo {
  countAll(): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM users");
    return Number(r?.c ?? 0);
  }

  countByStatus(status: UserStatus): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM users WHERE status = ?", status);
    return Number(r?.c ?? 0);
  }

  findById(id: string): UserRow | undefined {
    return this.db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
  }

  /** 邮箱大小写不敏感（与 idx_users_email 的 lower(email) 索引一致） */
  findByEmail(email: string): UserRow | undefined {
    return this.db.get<UserRow>("SELECT * FROM users WHERE lower(email) = lower(?)", email.trim());
  }

  existsEmail(email: string): boolean {
    return Boolean(this.findByEmail(email));
  }

  list(opts: { status?: UserStatus; limit?: number; offset?: number } = {}): UserRow[] {
    if (opts.status) {
      return this.db.all<UserRow>(
        "SELECT * FROM users WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        opts.status,
        opts.limit ?? 100,
        opts.offset ?? 0,
      );
    }
    return this.db.all<UserRow>(
      "SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?",
      opts.limit ?? 100,
      opts.offset ?? 0,
    );
  }

  create(input: CreateUserInput): UserRow {
    const id = newId();
    const ts = now();
    const role: UserRole = input.role ?? "user";
    const status: UserStatus = input.status ?? "pending";
    this.db.run(
      `INSERT INTO users (id, email, password_hash, display_name, role, status, approved_by, approved_at, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.email.trim(),
      input.passwordHash,
      input.displayName.trim(),
      role,
      status,
      nn(input.approvedBy),
      status === "approved" ? ts : null,
      ts,
    );
    const row = this.findById(id);
    if (!row) throw new Error("创建用户后读取失败");
    return row;
  }

  setStatus(id: string, status: UserStatus, approvedBy?: string | null): boolean {
    const res = this.db.run(
      "UPDATE users SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?",
      status,
      nn(approvedBy),
      status === "approved" ? now() : null,
      id,
    );
    return Number(res.changes) > 0;
  }

  setRole(id: string, role: UserRole): boolean {
    return Number(this.db.run("UPDATE users SET role = ? WHERE id = ?", role, id).changes) > 0;
  }

  updateDisplayName(id: string, displayName: string): boolean {
    return Number(this.db.run("UPDATE users SET display_name = ? WHERE id = ?", displayName.trim(), id).changes) > 0;
  }

  updatePasswordHash(id: string, passwordHash: string): boolean {
    return Number(this.db.run("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, id).changes) > 0;
  }

  touchLastLogin(id: string): void {
    this.db.run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), id);
  }

  /** 管理员数量：用于「不能把最后一个管理员降级/封禁」的保护 */
  countAdmins(): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM users WHERE role = 'admin' AND status != 'banned'");
    return Number(r?.c ?? 0);
  }

  /** 完整行（含 password_hash）仅用于登录；其余场景用 toPublic */
  static toPublic(row: UserRow): Omit<UserRow, "password_hash"> & { hasPassword: boolean } {
    const { password_hash: _hash, ...rest } = row;
    return { ...rest, hasPassword: Boolean(_hash) };
  }
}

export function userRowToApi(row: UserRow): {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
  lastLoginAt: number | null;
} {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: Number(row.created_at),
    lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
  };
}

export { toInt };
export type { Row };
