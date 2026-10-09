// 日志仓储
//
// 写路径在 Logger 的 sink 上（热路径），因此插入必须够快：node:sqlite 的 prepared
// statement + 单条 INSERT 在这个量级完全够用。
// 读路径供「历史日志」页面使用（实时页走内存环形缓冲，不查库）。
import { BaseRepo, now, pageParams } from "./base.ts";
import type { LogLevel } from "../../lib/logger.ts";

export type LogRow = {
  id: number;
  user_id: string | null;
  account_id: string | null;
  level: LogLevel;
  module_id: string | null;
  tag: string;
  msg: string;
  created_at: number;
};

export type InsertLogInput = {
  userId?: string | null;
  accountId?: string | null;
  level: LogLevel;
  moduleId?: string | null;
  tag: string;
  msg: string;
  createdAt?: number;
};

export class LogsRepo extends BaseRepo {
  insert(input: InsertLogInput): void {
    this.db.run(
      `INSERT INTO logs (user_id, account_id, level, module_id, tag, msg, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.userId ?? null,
      input.accountId ?? null,
      input.level,
      input.moduleId ?? null,
      input.tag,
      input.msg,
      input.createdAt ?? now(),
    );
  }

  /** 批量插入（同一个事务，减少 fsync 次数） */
  insertMany(items: InsertLogInput[]): void {
    if (!items.length) return;
    this.db.tx(() => {
      for (const it of items) this.insert(it);
    });
  }

  /** ★ 历史查询：任意筛选都强制叠加 user_id 条件 */
  query(
    userId: string,
    opts: {
      accountId?: string | null;
      moduleId?: string | null;
      minLevel?: LogLevel | null;
      search?: string;
      limit?: number;
      offset?: number;
      before?: number;
    } = {},
  ): LogRow[] {
    const { limit, offset } = pageParams(opts.limit, opts.offset, 500);
    const where: string[] = ["user_id = ?"];
    const params: (string | number)[] = [userId];

    if (opts.accountId) {
      where.push("account_id = ?");
      params.push(opts.accountId);
    }
    if (opts.moduleId) {
      where.push("module_id = ?");
      params.push(opts.moduleId);
    }
    if (opts.minLevel) {
      const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
      const levels = (Object.keys(order) as LogLevel[]).filter((lv) => order[lv] >= order[opts.minLevel as LogLevel]);
      where.push(`level IN (${levels.map(() => "?").join(",")})`);
      params.push(...levels);
    }
    if (opts.search) {
      where.push("(tag LIKE ? OR msg LIKE ?)");
      const needle = `%${opts.search}%`;
      params.push(needle, needle);
    }
    if (opts.before) {
      where.push("created_at < ?");
      params.push(opts.before);
    }

    params.push(limit, offset);
    return this.db.all<LogRow>(
      `SELECT * FROM logs WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
    );
  }

  countForUser(userId: string): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM logs WHERE user_id = ?", userId);
    return Number(r?.c ?? 0);
  }

  /** 某账号最近的日志（账号详情页用） */
  recentForAccount(userId: string, accountId: string, limit = 100): LogRow[] {
    return this.db.all<LogRow>(
      "SELECT * FROM logs WHERE user_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT ?",
      userId,
      accountId,
      Math.min(Math.max(1, limit), 500),
    );
  }

  /** 按时间清理（保留策略） */
  deleteOlderThan(cutoff: number): number {
    return Number(this.db.run("DELETE FROM logs WHERE created_at < ?", cutoff).changes);
  }

  /**
   * 删除某用户的全部日志。
   * 注意 logs.user_id 故意不设外键（日志比用户活得久，便于事后排查），
   * 因此删除用户的 service 必须显式调用它，不能指望级联。
   */
  deleteForUser(userId: string): number {
    return Number(this.db.run("DELETE FROM logs WHERE user_id = ?", userId).changes);
  }

  /**
   * 每用户条数上限：超出时删掉最旧的。
   * 防止单用户高频日志把库撑爆（实时页只显示 1000 条，历史留 2 万条足够回溯）。
   */
  trimForUser(userId: string, keep = 20_000): number {
    const total = this.countForUser(userId);
    if (total <= keep) return 0;
    // 找到第 keep 条（从新到旧）的时间点，删掉它以及更早的
    const cutoffRow = this.db.get<{ created_at: number }>(
      "SELECT created_at FROM logs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?",
      userId,
      keep - 1,
    );
    if (!cutoffRow) return 0;
    return Number(
      this.db.run("DELETE FROM logs WHERE user_id = ? AND created_at <= ?", userId, Number(cutoffRow.created_at)).changes,
    );
  }

  /** 全量条数（管理员系统信息页用） */
  countAll(): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM logs");
    return Number(r?.c ?? 0);
  }

  /** 按用户统计条数（管理员页） */
  countsByUser(): { userId: string | null; count: number }[] {
    return this.db
      .all<{ user_id: string | null; c: number }>(
        "SELECT user_id, count(*) AS c FROM logs GROUP BY user_id ORDER BY c DESC LIMIT 200",
      )
      .map((r) => ({ userId: r.user_id, count: Number(r.c) }));
  }
}
