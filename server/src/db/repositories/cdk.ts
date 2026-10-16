// CDK 公共库仓储
//
// 一张表、没有归属：谁提交的、谁能兑换都只是记录，**资源本身是共享的**。
// 关键约束是 normalized 上的 UNIQUE —— 去空格、去连字符、转大写之后同一个值，
// 重复提交直接撞唯一键（不依赖"先查再插"这种有竞态的写法）。
import { BaseRepo, newId, now } from "./base.ts";

export type CdkStatus = "available" | "not_started" | "exhausted";

export type CdkRow = {
  id: string;
  code: string;
  normalized: string;
  status: CdkStatus;
  reward_json: string | null;
  submitted_by: string;
  submitted_at: number;
  account_id: string | null;
  last_error: string | null;
  success_count: number;
  last_redeemed_by: string | null;
  last_redeemed_at: number | null;
  updated_at: number;
};

export type InsertCdkInput = {
  code: string;
  normalized: string;
  status: CdkStatus;
  reward?: unknown;
  submittedBy: string;
  accountId?: string | null;
  lastError?: string | null;
  /** 提交时就用这个账号领到了 → 成功次数从 1 起算 */
  alreadyRedeemed?: boolean;
};

export class CdkRepo extends BaseRepo {
  /** 归一化键是否已存在（用于提交前的友好提示；真正防重靠 UNIQUE 约束） */
  existsNormalized(normalized: string): boolean {
    return Boolean(this.db.get<{ c: number }>("SELECT 1 AS c FROM cdk_codes WHERE normalized = ?", normalized));
  }

  insert(input: InsertCdkInput): CdkRow {
    const id = newId();
    const ts = now();
    this.db.run(
      `INSERT INTO cdk_codes
         (id, code, normalized, status, reward_json, submitted_by, submitted_at,
          account_id, last_error, success_count, last_redeemed_by, last_redeemed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.code,
      input.normalized,
      input.status,
      input.reward === undefined || input.reward === null ? null : JSON.stringify(input.reward),
      input.submittedBy,
      ts,
      input.accountId ?? null,
      input.lastError ?? null,
      input.alreadyRedeemed ? 1 : 0,
      input.alreadyRedeemed ? input.submittedBy : null,
      input.alreadyRedeemed ? ts : null,
      ts,
    );
    return this.findById(id)!;
  }

  findById(id: string): CdkRow | undefined {
    return this.db.get<CdkRow>("SELECT * FROM cdk_codes WHERE id = ?", id);
  }

  findByNormalized(normalized: string): CdkRow | undefined {
    return this.db.get<CdkRow>("SELECT * FROM cdk_codes WHERE normalized = ?", normalized);
  }

  /** 列表：支持状态 / 关键词 / 只看自己 筛选 + 分页 */
  list(opts: { status?: CdkStatus | "all"; search?: string; submittedBy?: string; limit?: number; offset?: number } = {}): CdkRow[] {
    const { where, params } = this.filter(opts);
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const offset = Math.max(0, opts.offset ?? 0);
    return this.db.all<CdkRow>(
      `SELECT * FROM cdk_codes ${where} ORDER BY submitted_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
  }

  /** 当前筛选条件下的总数（分页用） */
  count(opts: { status?: CdkStatus | "all"; search?: string; submittedBy?: string } = {}): number {
    const { where, params } = this.filter(opts);
    const r = this.db.get<{ c: number }>(`SELECT count(*) AS c FROM cdk_codes ${where}`, ...params);
    return Number(r?.c ?? 0);
  }

  private filter(opts: { status?: CdkStatus | "all"; search?: string; submittedBy?: string }): {
    where: string;
    params: (string | number)[];
  } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.status && opts.status !== "all") {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.submittedBy) {
      where.push("submitted_by = ?");
      params.push(opts.submittedBy);
    }
    if (opts.search?.trim()) {
      where.push("(code LIKE ? OR normalized LIKE ?)");
      const needle = `%${opts.search.trim().toUpperCase().replace(/[\s-]+/g, "")}%`;
      params.push(needle, needle);
    }
    return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  countByStatus(): Record<CdkStatus, number> {
    const rows = this.db.all<{ status: CdkStatus; c: number }>(
      "SELECT status, count(*) AS c FROM cdk_codes GROUP BY status",
    );
    const out: Record<CdkStatus, number> = { available: 0, not_started: 0, exhausted: 0 };
    for (const r of rows) out[r.status] = Number(r.c);
    return out;
  }

  /** 兑换成功：累加成功次数并记录奖励（奖励只在第一次有值时不覆盖，保留最初的摘要） */
  markRedeemed(id: string, userId: string, reward?: unknown): void {
    this.db.run(
      `UPDATE cdk_codes
          SET success_count = success_count + 1,
              last_redeemed_by = ?,
              last_redeemed_at = ?,
              last_error = NULL,
              reward_json = COALESCE(reward_json, ?),
              updated_at = ?
        WHERE id = ?`,
      userId,
      now(),
      reward === undefined || reward === null ? null : JSON.stringify(reward),
      now(),
      id,
    );
  }

  /** 兑换时发现码已失效 → 标记为用尽（保留记录，便于事后追查是谁提交的） */
  markExhausted(id: string, reason: string): void {
    this.db.run(
      "UPDATE cdk_codes SET status = 'exhausted', last_error = ?, updated_at = ? WHERE id = ?",
      reason,
      now(),
      id,
    );
  }

  /** 状态修正（例如「未开始」的码过一段时间后可以领了 → 由兑换流程自动改回可用） */
  markStatus(id: string, status: CdkStatus, lastError: string | null = null): void {
    this.db.run(
      "UPDATE cdk_codes SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
      status,
      lastError,
      now(),
      id,
    );
  }

  /** 删除自己的提交（只有提交者能删） */
  deleteOwned(id: string, userId: string): boolean {
    return Number(this.db.run("DELETE FROM cdk_codes WHERE id = ? AND submitted_by = ?", id, userId).changes) > 0;
  }

  /** 管理员删除任意码（不限提交人） */
  deleteById(id: string): boolean {
    return Number(this.db.run("DELETE FROM cdk_codes WHERE id = ?", id).changes) > 0;
  }
}
