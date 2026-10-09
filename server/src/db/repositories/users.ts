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
  /** 账号额度覆盖：NULL = 跟随全局默认 */
  quota_override: number | null;
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

  /**
   * 列表查询。支持搜索与筛选（后台用户管理用）。
   *
   * 搜索匹配登录标识与显示名，大小写不敏感（SQLite 的 LIKE 对 ASCII 本来就不敏感，
   * 这里再 lower() 一次保证行为一致）。
   * 只允许白名单字段拼 SQL —— 不把用户输入直接塞进语句。
   */
  list(
    opts: {
      status?: UserStatus;
      role?: UserRole;
      /** 搜索词：匹配用户名或显示名 */
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): UserRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.role) {
      where.push("role = ?");
      params.push(opts.role);
    }
    const q = opts.q?.trim();
    if (q) {
      where.push("(lower(email) LIKE ? OR lower(display_name) LIKE ?)");
      const like = `%${q.toLowerCase()}%`;
      params.push(like, like);
    }

    const sql =
      `SELECT * FROM users` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 100, opts.offset ?? 0);

    return this.db.all<UserRow>(sql, ...params);
  }

  /** 与 list 同条件的总数（分页要用） */
  count(opts: { status?: UserStatus; role?: UserRole; q?: string } = {}): number {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.role) {
      where.push("role = ?");
      params.push(opts.role);
    }
    const q = opts.q?.trim();
    if (q) {
      where.push("(lower(email) LIKE ? OR lower(display_name) LIKE ?)");
      const like = `%${q.toLowerCase()}%`;
      params.push(like, like);
    }
    const row = this.db.get<{ c: number }>(
      `SELECT count(*) AS c FROM users` + (where.length ? ` WHERE ${where.join(" AND ")}` : ""),
      ...params,
    );
    return Number(row?.c ?? 0);
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

  /**
   * 设置该用户的账号额度覆盖。
   * `null` = 清除覆盖，跟随全局默认（设置页里的「每个用户可挂账号数」）。
   */
  setQuotaOverride(id: string, quota: number | null): boolean {
    const v = quota == null ? null : Math.max(1, Math.floor(quota));
    return Number(this.db.run("UPDATE users SET quota_override = ? WHERE id = ?", v, id).changes) > 0;
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
