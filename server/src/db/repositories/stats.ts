// 每日统计仓储
//
// 与 daily-digest 日报、统计页共用一份 T+0 累计数据（按本地日）。
// 用 UPSERT 累加，服务重启不清零（这点比内存统计可靠）。
import { BaseRepo, now } from "./base.ts";

export type DailyStatsRow = {
  id: number;
  account_id: string;
  user_id: string;
  day: string;
  casts: number;
  fish: number;
  gold: number;
  experience: number;
  income: number;
  bait_cost: number;
  net_gold: number;
  gear: number;
  chests: number;
  relics: number;
  updated_at: number;
};

export type StatsDelta = {
  casts?: number;
  fish?: number;
  gold?: number;
  experience?: number;
  income?: number;
  baitCost?: number;
  gear?: number;
  chests?: number;
  relics?: number;
};

/** 本地日 YYYY-MM-DD（与前端 lib/format.ts 的 localDay 同口径） */
export function localDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class StatsRepo extends BaseRepo {
  /** 累加一次结算量 */
  add(accountId: string, userId: string, delta: StatsDelta, day = localDay()): void {
    const d = {
      casts: Math.round(delta.casts ?? 0),
      fish: Math.round(delta.fish ?? 0),
      gold: Math.round(delta.gold ?? 0),
      experience: Math.round(delta.experience ?? 0),
      income: Math.round(delta.income ?? 0),
      baitCost: Math.round(delta.baitCost ?? 0),
      gear: Math.round(delta.gear ?? 0),
      chests: Math.round(delta.chests ?? 0),
      relics: Math.round(delta.relics ?? 0),
    };
    const netGold = (d.income || d.gold) - d.baitCost;

    this.db.run(
      `INSERT INTO account_stats_daily
         (account_id, user_id, day, casts, fish, gold, experience, income, bait_cost, net_gold, gear, chests, relics, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, day) DO UPDATE SET
         casts      = casts      + excluded.casts,
         fish       = fish       + excluded.fish,
         gold       = gold       + excluded.gold,
         experience = experience + excluded.experience,
         income     = income     + excluded.income,
         bait_cost  = bait_cost  + excluded.bait_cost,
         net_gold   = net_gold   + excluded.net_gold,
         gear       = gear       + excluded.gear,
         chests     = chests     + excluded.chests,
         relics     = relics     + excluded.relics,
         updated_at = excluded.updated_at`,
      accountId,
      userId,
      day,
      d.casts,
      d.fish,
      d.gold,
      d.experience,
      d.income,
      d.baitCost,
      netGold,
      d.gear,
      d.chests,
      d.relics,
      now(),
    );
  }

  get(accountId: string, day: string): DailyStatsRow | undefined {
    return this.db.get<DailyStatsRow>(
      "SELECT * FROM account_stats_daily WHERE account_id = ? AND day = ?",
      accountId,
      day,
    );
  }

  /** ★ 用户维度查询，强制带 user_id */
  listForUser(
    userId: string,
    opts: { from?: string; to?: string; accountId?: string; limit?: number } = {},
  ): DailyStatsRow[] {
    const where: string[] = ["user_id = ?"];
    const params: (string | number)[] = [userId];
    if (opts.from) {
      where.push("day >= ?");
      params.push(opts.from);
    }
    if (opts.to) {
      where.push("day <= ?");
      params.push(opts.to);
    }
    if (opts.accountId) {
      where.push("account_id = ?");
      params.push(opts.accountId);
    }
    params.push(Math.min(Math.max(1, opts.limit ?? 200), 1000));
    return this.db.all<DailyStatsRow>(
      `SELECT * FROM account_stats_daily WHERE ${where.join(" AND ")} ORDER BY day DESC, account_id LIMIT ?`,
      ...params,
    );
  }

  /** 某天所有账号的汇总（日报用） */
  sumForUserDay(userId: string, day: string): Omit<DailyStatsRow, "id" | "account_id" | "user_id" | "day" | "updated_at"> {
    const r = this.db.get<{
      casts: number | null;
      fish: number | null;
      gold: number | null;
      experience: number | null;
      income: number | null;
      bait_cost: number | null;
      net_gold: number | null;
      gear: number | null;
      chests: number | null;
      relics: number | null;
    }>(
      `SELECT sum(casts) AS casts, sum(fish) AS fish, sum(gold) AS gold, sum(experience) AS experience,
              sum(income) AS income, sum(bait_cost) AS bait_cost, sum(net_gold) AS net_gold,
              sum(gear) AS gear, sum(chests) AS chests, sum(relics) AS relics
         FROM account_stats_daily WHERE user_id = ? AND day = ?`,
      userId,
      day,
    );
    return {
      casts: Number(r?.casts ?? 0),
      fish: Number(r?.fish ?? 0),
      gold: Number(r?.gold ?? 0),
      experience: Number(r?.experience ?? 0),
      income: Number(r?.income ?? 0),
      bait_cost: Number(r?.bait_cost ?? 0),
      net_gold: Number(r?.net_gold ?? 0),
      gear: Number(r?.gear ?? 0),
      chests: Number(r?.chests ?? 0),
      relics: Number(r?.relics ?? 0),
    };
  }

  deleteOlderThan(day: string): number {
    return Number(this.db.run("DELETE FROM account_stats_daily WHERE day < ?", day).changes);
  }

  /** 删除某用户的全部统计（删除用户时显式调用；统计表虽有外键但按 user_id 清更彻底） */
  deleteForUser(userId: string): number {
    return Number(this.db.run("DELETE FROM account_stats_daily WHERE user_id = ?", userId).changes);
  }
}
