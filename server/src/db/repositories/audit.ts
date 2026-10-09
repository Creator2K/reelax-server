// 审计仓储
//
// 记录「谁在什么时候对什么做了什么」：登录、审批、封禁、改角色、增删账号与代理、
// 改口令。用于事后追查，也是多用户部署的基本要求。
import { BaseRepo, now, pageParams } from "./base.ts";

export type AuditRow = {
  id: number;
  user_id: string | null;
  action: string;
  target: string | null;
  detail_json: string | null;
  ip: string | null;
  created_at: number;
};

export const AUDIT_ACTIONS = {
  LOGIN_OK: "auth.login.ok",
  LOGIN_FAIL: "auth.login.fail",
  LOGOUT: "auth.logout",
  REGISTER: "auth.register",
  PASSWORD_CHANGED: "auth.password.changed",
  PROFILE_CHANGED: "auth.profile.changed",
  USER_APPROVED: "admin.user.approved",
  USER_REJECTED: "admin.user.rejected",
  USER_BANNED: "admin.user.banned",
  USER_STATUS_CHANGED: "admin.user.status",
  USER_ROLE_CHANGED: "admin.user.role",
  INVITE_CREATED: "admin.invite.created",
  INVITE_DELETED: "admin.invite.deleted",
  ACCOUNT_CREATED: "account.created",
  ACCOUNT_UPDATED: "account.updated",
  ACCOUNT_DELETED: "account.deleted",
  ACCOUNT_STARTED: "account.started",
  ACCOUNT_STOPPED: "account.stopped",
  ACCOUNT_CREDENTIALS_UPDATED: "account.credentials.updated",
  MODULE_UPDATED: "account.module.updated",
  PROXY_CREATED: "proxy.created",
  PROXY_UPDATED: "proxy.updated",
  PROXY_DELETED: "proxy.deleted",
  PROXY_TESTED: "proxy.tested",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export class AuditRepo extends BaseRepo {
  record(input: {
    userId?: string | null;
    action: AuditAction | string;
    target?: string | null;
    detail?: unknown;
    ip?: string | null;
  }): void {
    let detailJson: string | null = null;
    if (input.detail !== undefined && input.detail !== null) {
      try {
        detailJson = JSON.stringify(input.detail);
      } catch {
        detailJson = JSON.stringify({ note: "detail 序列化失败" });
      }
    }
    this.db.run(
      `INSERT INTO audit_events (user_id, action, target, detail_json, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.userId ?? null,
      input.action,
      input.target ?? null,
      detailJson,
      input.ip ?? null,
      now(),
    );
  }

  listForUser(userId: string, opts: { limit?: number; offset?: number } = {}): AuditRow[] {
    const { limit, offset } = pageParams(opts.limit, opts.offset, 200);
    return this.db.all<AuditRow>(
      "SELECT * FROM audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
      userId,
      limit,
      offset,
    );
  }

  list(opts: { action?: string; userId?: string; limit?: number; offset?: number } = {}): AuditRow[] {
    const { limit, offset } = pageParams(opts.limit, opts.offset, 200);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.action) {
      where.push("action = ?");
      params.push(opts.action);
    }
    if (opts.userId) {
      where.push("user_id = ?");
      params.push(opts.userId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit, offset);
    return this.db.all<AuditRow>(
      `SELECT * FROM audit_events ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
    );
  }

  countAll(): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM audit_events");
    return Number(r?.c ?? 0);
  }

  deleteOlderThan(cutoff: number): number {
    return Number(this.db.run("DELETE FROM audit_events WHERE created_at < ?", cutoff).changes);
  }
}
