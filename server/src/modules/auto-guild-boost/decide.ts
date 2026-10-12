// 公会区域经验增益：该不该买 / 买几份（纯函数，可单测）
//
// 协议（对照游戏前端 bundle 实测）：
//   GET  /api/guilds/me         → { guild: { treasuryGold }, config: { boostUnitCost },
//                                   membership: { permissions: { canActivateBoosts } } }
//   GET  /api/guilds/me/boosts  → { boosts: [{ biomeId, isActive, isQueued, endsAt }],
//                                   unitCost, unitDurationMinutes, maxUnits, serverTime }
//   POST /api/guilds/me/boosts/{biomeId}  body { units }     ← 消耗**公会金库**
//
// ★ 花的是公会的钱（不是自己的），而且只有干部能开 —— 所以判定同样保守：
//   没权限、金库不够（含你设的下限）、单价读不到、已经有生效中的增益 —— 一律不买。
//   买的份数 = 你设的份数，且不超过服务端给的 maxUnits。
import { parseTime } from "../../lib/util.ts";

export type GuildBoostRow = {
  biomeId?: unknown;
  isActive?: unknown;
  isQueued?: unknown;
  endsAt?: unknown;
};

export type GuildBoostDecision =
  | { action: "activate"; biomeId: string; units: number; cost: number; reason: string }
  | { action: "skip"; reason: string };

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 从 /api/guilds/me 里摘出买增益要用的三件事 */
export function readGuildFunds(data: unknown): {
  treasuryGold: number;
  unitCost: number;
  canActivate: boolean;
} {
  const d = (data ?? {}) as any;
  return {
    treasuryGold: num(d?.guild?.treasuryGold),
    unitCost: num(d?.config?.boostUnitCost),
    canActivate: d?.membership?.permissions?.canActivateBoosts === true,
  };
}

/** 找某张地图当前的增益状态 */
export function boostOf(rows: GuildBoostRow[] | null | undefined, biomeId: string): GuildBoostRow | null {
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => String(r?.biomeId ?? "") === biomeId) ?? null;
}

/**
 * 决策。
 *
 * @param input.targetBiome    "current" = 跟随当前地图；否则是具体 biomeId
 * @param input.renewAheadMs   已有增益剩余时间少于这么多才续买（0 = 等它结束再买）
 * @param input.serverTimeMs   响应里的 `serverTime`。**剩余时间按它算**，不要用本机时钟 ——
 *                             官方客户端也是这么做的（`Date.parse(endsAt) - Date.parse(serverTime)`）。
 *                             本机时钟偏快十几分钟时，用本机时钟会把"还剩 25 分钟"算成"还剩 5 分钟"，
 *                             于是提前续买（用户实测反馈：明明有时间却又买了）。
 */
export function decideGuildBoost(input: {
  boosts: GuildBoostRow[] | null | undefined;
  unitCost: number;
  maxUnits: number;
  canActivate: boolean;
  treasuryGold: number;
  minimumTreasuryGold: number;
  currentBiomeId: string | null;
  targetBiome: string;
  unitsWanted: number;
  renewAheadMs: number;
  now: number;
  /** 服务端时间（拿不到就用 now） */
  serverTimeMs?: number | null;
}): GuildBoostDecision {
  const { boosts, maxUnits, canActivate, treasuryGold, minimumTreasuryGold, currentBiomeId, targetBiome, renewAheadMs } =
    input;

  const biomeId = targetBiome === "current" ? (currentBiomeId ?? "") : String(targetBiome ?? "").trim();
  if (!biomeId) return { action: "skip", reason: "拿不到要开增益的地图（当前地图未知？）" };

  if (!canActivate) {
    return { action: "skip", reason: "没有开启公会区域增益的权限（只有公会干部可以）" };
  }

  const unitCost = num(input.unitCost);
  if (unitCost <= 0) return { action: "skip", reason: "读不到增益单价，先不买（避免误花公会金库）" };

  const want = Math.max(1, Math.floor(num(input.unitsWanted) || 1));
  const cap = Math.floor(num(maxUnits));
  const units = cap > 0 ? Math.min(want, cap) : want;
  const cost = units * unitCost;

  if (treasuryGold < cost) {
    return {
      action: "skip",
      reason: `公会金库不足：本次需要 ${cost}（${units} 份 × ${unitCost}），现有 ${treasuryGold}`,
    };
  }
  const reserve = Math.max(0, num(minimumTreasuryGold));
  if (treasuryGold - cost < reserve) {
    return {
      action: "skip",
      reason: `买完会低于你设的金库下限（${reserve}）：现有 ${treasuryGold}，本次要花 ${cost}`,
    };
  }

  const cur = boostOf(boosts, biomeId);
  const ends = parseTime(cur?.endsAt);
  // ★ 基准时间优先用服务端时间：本机时钟偏差会直接把"还剩多久"算错
  const serverNow = num(input.serverTimeMs);
  const baseNow = serverNow > 0 ? serverNow : input.now;
  const remain = ends === null ? null : Math.max(0, ends - baseNow);

  // 已经有一笔排在队里 → 不叠加（不管还剩多久、也不管续买阈值）
  if (cur?.isQueued === true && (remain === null || remain > 0)) {
    return { action: "skip", reason: "该地图已有一笔增益排队生效中" };
  }

  if (remain !== null) {
    // 结束时间最可靠：还有时间就不买（到点前 renewAheadMs 内才续）
    if (remain > renewAheadMs) {
      const min = Math.max(1, Math.round(remain / 60_000));
      return { action: "skip", reason: `该地图的增益还在（还剩约 ${min} 分钟），不重复买` };
    }
  } else if (cur?.isActive === true) {
    // ★ 生效中但读不到结束时间 → **保守不买**。
    //   旧版把"读不到结束时间"当成"已经过期"（remain=0）→ 每次检查都买一次，把公会金库花光。
    return {
      action: "skip",
      reason: "增益生效中，但读不到结束时间 —— 先不买（避免重复花公会金库）",
    };
  }

  return {
    action: "activate",
    biomeId,
    units,
    cost,
    reason: `买 ${units} 份（${cost} 金币）${cur ? "延长" : "开启"}该地图的区域经验增益`,
  };
}
