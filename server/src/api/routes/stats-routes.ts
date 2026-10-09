// 统计路由：/api/stats/*
//
// 数据来自 account_stats_daily（由运行时的 reportSync 累加），服务重启不清零。
import { Router } from "express";
import { z } from "zod";
import type { StatsRepo } from ".././../db/repositories/stats.ts";
import type { Repos } from "../../db/repositories/index.ts";
import type { RunnerRegistry } from "../../game/runner-registry.ts";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { query } from "../middleware/validate.ts";
import { localDay } from "../../modules/shared/format.ts";

const rangeSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  accountId: z.string().max(64).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
});

export function createStatsRouter(deps: {
  stats: StatsRepo;
  repos: Repos;
  registry: RunnerRegistry;
  sessionStats: (userId: string) => {
    accounts: number;
    running: number;
    online: number;
    castsResolved: number;
    gold: number;
    fishCount: number;
    experience: number;
  };
}): Router {
  const router = Router();
  router.use(requireApproved);

  /**
   * 汇总：本次运行累计（内存）+ 按日区间（数据库）
   * 前端总览页只用这一个接口。
   */
  router.get("/summary", (req, res) => {
    const userId = currentUserId(req);
    const total = deps.stats.sumForUserDay(userId, localDay());

    res.json({
      today: {
        day: localDay(),
        casts: total.casts,
        fish: total.fish,
        gold: total.gold,
        experience: total.experience,
        income: total.income,
        baitCost: total.bait_cost,
        netGold: total.net_gold,
        gear: total.gear,
        chests: total.chests,
        relics: total.relics,
      },
      session: deps.sessionStats(userId),
    });
  });

  /** 按日趋势 */
  router.get("/daily", query(rangeSchema), (req, res) => {
    const userId = currentUserId(req);
    const q = res.locals.query as z.infer<typeof rangeSchema>;

    const days = q.days ?? 14;
    const from = q.from ?? dayOffset(-(days - 1));
    const to = q.to ?? localDay();

    const rows = deps.stats.listForUser(userId, {
      from,
      to,
      ...(q.accountId ? { accountId: q.accountId } : {}),
      limit: 1000,
    });

    // 按日聚合（多账号时把同一天的加起来）
    const byDay = new Map<string, { day: string; casts: number; fish: number; gold: number; experience: number; netGold: number; gear: number; chests: number; relics: number }>();
    for (const r of rows) {
      const cur = byDay.get(r.day) ?? {
        day: r.day,
        casts: 0,
        fish: 0,
        gold: 0,
        experience: 0,
        netGold: 0,
        gear: 0,
        chests: 0,
        relics: 0,
      };
      cur.casts += Number(r.casts) || 0;
      cur.fish += Number(r.fish) || 0;
      cur.gold += Number(r.gold) || 0;
      cur.experience += Number(r.experience) || 0;
      cur.netGold += Number(r.net_gold) || 0;
      cur.gear += Number(r.gear) || 0;
      cur.chests += Number(r.chests) || 0;
      cur.relics += Number(r.relics) || 0;
      byDay.set(r.day, cur);
    }

    res.json([...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)));
  });

  /** 按账号分日明细（账号详情页用） */
  router.get("/accounts/:id", query(rangeSchema), (req, res) => {
    const userId = currentUserId(req);
    const accountId = req.params.id as string;
    // 归属校验：不存在或不属于自己 → 空数组（不泄漏存在性）
    if (!deps.repos.accounts.findSafe(accountId, userId)) {
      res.json([]);
      return;
    }

    const q = res.locals.query as z.infer<typeof rangeSchema>;
    const days = q.days ?? 30;
    res.json(
      deps.stats
        .listForUser(userId, { accountId, from: dayOffset(-(days - 1)), to: localDay(), limit: 365 })
        .map((r) => ({
          day: r.day,
          casts: Number(r.casts),
          fish: Number(r.fish),
          gold: Number(r.gold),
          experience: Number(r.experience),
          income: Number(r.income),
          baitCost: Number(r.bait_cost),
          netGold: Number(r.net_gold),
          gear: Number(r.gear),
          chests: Number(r.chests),
          relics: Number(r.relics),
        })),
    );
  });

  return router;
}

/** 相对今天的本地日偏移 */
function dayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDay(d);
}
