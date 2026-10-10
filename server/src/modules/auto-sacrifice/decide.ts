// 奥秘献祭：该不该献、献多少（纯函数，可单测）
//
// 协议（对照游戏前端 bundle 实测）：
//   GET  /api/events/arcane-sacrifice → {
//          status: "ready" | …,
//          day: { date },
//          currentRound: { roundNumber, status: "open"|…, resourceType: "fish"|"gold"|"relic",
//                          target, progress },
//          currentPlayerRoundContribution: { contribution,   // 我在本轮已贡献的点数
//                                            remaining,      // 服务端算好的「我还能贡献多少点」
//                                            limitBasisPoints },  // 单人上限（目标的百分之几×100）
//          availableAssets: { fish: { common: 123, … }, gold, relics },
//          fishPoints: { common: 1, uncommon: 2, … }            // 每条鱼折算多少点
//        }
//   POST /api/events/arcane-sacrifice/contributions
//        fish  → { resourceType: "fish", rarity, quantity }
//        gold  → { resourceType: "gold", quantity }      （1 金币 = 1 点）
//        relic → { resourceType: "relic", quantity }
//
// ★ 这套换算是照抄游戏自己的献祭页（它也是这么算「最多能献多少」的）：
//     可献数量 = min(该资源持有量, floor(剩余额度 / 单位点数))
//   额外加了一道**自愿上限**：我在本轮的累计贡献不超过轮次目标的 selfSharePercent%
//   （100% = 只用游戏自己的单人上限，不自缚）。
//
// ★ 献祭出去就**不可撤回**（即使本轮全服没达标也不返还），所以这里全部走保守判定：
//   任何一项数据读不到、单价为 0、额度为 0 —— 一律不献，只记原因。

export type SacrificeOverview = {
  status?: unknown;
  day?: { date?: unknown } | null;
  currentRound?: {
    roundNumber?: unknown;
    status?: unknown;
    resourceType?: unknown;
    target?: unknown;
    progress?: unknown;
  } | null;
  currentPlayerRoundContribution?: {
    contribution?: unknown;
    remaining?: unknown;
    limitBasisPoints?: unknown;
  } | null;
  availableAssets?: { fish?: Record<string, unknown>; gold?: unknown; relics?: unknown } | null;
  fishPoints?: Record<string, unknown> | null;
};

export type SacrificeBody = { resourceType: string; rarity?: string; quantity: number };

export type SacrificeDecision =
  | { action: "contribute"; body: SacrificeBody; points: number; reason: string }
  | { action: "skip"; reason: string };

/** 允许献祭的资源类型 */
export const SACRIFICE_RESOURCES = ["fish", "gold", "relic"] as const;
export type SacrificeResource = (typeof SACRIFICE_RESOURCES)[number];

export const SACRIFICE_RESOURCE_LABELS: Record<SacrificeResource, string> = {
  fish: "鱼",
  gold: "金币",
  relic: "遗物",
};

/** 可献祭的鱼稀有度（游戏 front bundle 里就是这 5 档） */
export const SACRIFICE_FISH_RARITIES = ["common", "uncommon", "fine", "rare", "epic"] as const;
export const FISH_RARITY_LABELS: Record<string, string> = {
  common: "普通",
  uncommon: "罕见",
  fine: "精良",
  rare: "稀有",
  epic: "史诗",
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 该资源持有量（鱼按选定稀有度算） */
export function availableOf(overview: SacrificeOverview | null, resource: string, rarity: string): number {
  const assets = overview?.availableAssets ?? null;
  if (resource === "fish") return num(assets?.fish?.[rarity]);
  if (resource === "gold") return num(assets?.gold);
  if (resource === "relic") return num(assets?.relics);
  return 0;
}

/** 单位点数：1 条鱼 = fishPoints[稀有度] 点；金币 / 遗物 1:1 */
export function pointsPerUnit(overview: SacrificeOverview | null, resource: string, rarity: string): number {
  if (resource !== "fish") return resource === "gold" || resource === "relic" ? 1 : 0;
  const p = num(overview?.fishPoints?.[rarity]);
  return p > 0 ? p : 0;
}

/**
 * 决策。
 *
 * @param input.resources        允许自动献祭的资源类型（本轮要的那种不在里面就不献）
 * @param input.fishRarity       献鱼时用哪一档
 * @param input.selfSharePercent 本人在本轮的累计贡献上限（占轮次目标的百分比，100 = 不额外限制）
 */
export function decideSacrifice(input: {
  overview: SacrificeOverview | null;
  resources: string[];
  fishRarity: string;
  selfSharePercent: number;
}): SacrificeDecision {
  const { overview, resources, fishRarity, selfSharePercent } = input;

  const round = overview?.currentRound ?? null;
  if (!round) return { action: "skip", reason: "现在没有献祭轮次" };

  const status = String(round.status ?? "");
  if (status !== "open") return { action: "skip", reason: `本轮状态是「${status || "未知"}」，不在开放期` };

  const resource = String(round.resourceType ?? "");
  if (!resource) return { action: "skip", reason: "本轮没有给出资源类型" };
  if (!resources.includes(resource)) {
    const label = SACRIFICE_RESOURCE_LABELS[resource as SacrificeResource] ?? resource;
    return { action: "skip", reason: `本轮要的是「${label}」，不在你允许自动献祭的资源里` };
  }

  const player = overview?.currentPlayerRoundContribution ?? null;
  const remaining = Math.max(0, num(player?.remaining));
  if (remaining <= 0) {
    return { action: "skip", reason: "本轮我的贡献额度已用完（单人上限），不再献祭" };
  }

  const perUnit = pointsPerUnit(overview, resource, fishRarity);
  if (perUnit <= 0) {
    return {
      action: "skip",
      reason:
        resource === "fish"
          ? `拿不到「${FISH_RARITY_LABELS[fishRarity] ?? fishRarity}鱼」的点数换算，先不献`
          : `拿不到「${resource}」的点数换算，先不献`,
    };
  }

  const available = availableOf(overview, resource, fishRarity);
  if (available <= 0) {
    return {
      action: "skip",
      reason:
        resource === "fish"
          ? `背包里没有可献祭的「${FISH_RARITY_LABELS[fishRarity] ?? fishRarity}鱼」`
          : `没有可献祭的${SACRIFICE_RESOURCE_LABELS[resource as SacrificeResource] ?? resource}`,
    };
  }

  // 游戏自己的口径：额度（点）换算成数量
  const byQuota = Math.floor(remaining / perUnit);

  // 自愿上限：本人累计贡献不超过目标的 X%
  const target = num(round.target);
  const contributed = num(player?.contribution);
  const share = Math.min(100, Math.max(1, Number(selfSharePercent) || 100));
  let byShare = Number.POSITIVE_INFINITY;
  if (target > 0 && share < 100) {
    byShare = Math.floor(Math.max(0, (target * share) / 100 - contributed) / perUnit);
  }

  const quantity = Math.min(available, byQuota, byShare);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {
      action: "skip",
      reason:
        byShare <= 0
          ? `已达你设的贡献上限（本轮目标的 ${share}%），不再献祭`
          : `本轮剩余额度不够献一份（剩余 ${remaining} 点，每份 ${perUnit} 点）`,
    };
  }

  const points = quantity * perUnit;
  const body: SacrificeBody =
    resource === "fish" ? { resourceType: resource, rarity: fishRarity, quantity } : { resourceType: resource, quantity };
  return {
    action: "contribute",
    body,
    points,
    reason:
      `第 ${num(round.roundNumber) || "?"} 轮需要「${SACRIFICE_RESOURCE_LABELS[resource as SacrificeResource] ?? resource}」` +
      `，献 ${quantity} 份 ≈ ${points} 点（我还剩 ${remaining} 点额度）`,
  };
}

/** 献祭响应里能确认「真的献进去了」的字段（用于日志） */
export function readContributionResult(resp: unknown): { inputQuantity: number; contribution: number } | null {
  const c = (resp as { contribution?: { inputQuantity?: unknown; contribution?: unknown } } | null)?.contribution;
  if (!c) return null;
  return { inputQuantity: num(c.inputQuantity), contribution: num(c.contribution) };
}
