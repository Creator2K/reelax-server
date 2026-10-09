// 状态面板 + 经验总倍率
//
// ★ 总倍率的算法与游戏完全一致：**八个分区各自 (1 + bp/10000) 相乘**。
//   这是拿真实账号对账过的：
//     智力 20587 / 专精 3150 + 天赋 2500 / 神器 60 / 公会图腾 1500 + 区域 5000
//     / 天气雨幕 500 / 商店 15000 / 活动 6500 → ×34.415，游戏内显示 ×34.41
//   早期版本写成「全部相加再乘天气」，会显示成 ×5.38 —— 差了一个数量级。
//
// 分区归属（与游戏「经验倍率详情」一致）：
//   商店 = player_shop / personal_shop
//   活动 = admin_event / reincarnation_catch_up
import { bpToMultiplier, weatherMultiplier, weatherName } from "./xp-multiplier.ts";
import { baitName as baitNameOf } from "../shared/rarity.ts";

/** 八个分区（万分比） */
export type XpSections = {
  /** 地图专精 + 天赋 */
  permanentBp: number;
  artifactBp: number;
  weatherBp: number;
  /** 智力（有效值，上限 100000） */
  wisdomBp: number;
  /** 公会图腾 + 区域增益 */
  guildBp: number;
  /** 船队 */
  partyBp: number;
  /** 商店类 Buff */
  shopBp: number;
  /** 活动 / 转生助力类 Buff */
  eventBp: number;
};

export const SHOP_SOURCES = ["player_shop", "personal_shop"];
export const EVENT_SOURCES = ["admin_event", "reincarnation_catch_up"];

/** ★ 八分区相乘 */
export function totalXpMultiplier(sections: XpSections): number {
  return Object.values(sections).reduce((acc, bp) => acc * bpToMultiplier(bp), 1);
}

export type BuffView = {
  tag: string;
  bp: number;
  endsAt: string | null;
  source: string | null;
};

export type GuildBoostView = {
  biomeId: string;
  name: string;
  bp: number;
  endsAt: string | null;
};

export type StatusPanel = {
  biomeId: string | null;
  biomeName: string | null;
  valueMultiplier: number | null;

  masteryBp: number;
  talentBp: number;
  artifactBp: number;
  guildBp: number;
  guildBiomeBoostBp: number;
  buffs: BuffView[];
  buffXpBp: number;
  shopBp: number;
  eventBp: number;
  wisdomBp: number;
  partyBp: number;
  sections: XpSections;
  xpTotal: number;

  weatherId: string | null;
  weatherName: string | null;
  weatherXpPct: number;

  guildBoosts: GuildBoostView[];

  level: number | null;
  experience: number | null;
  experienceToNextLevel: number | null;
  gold: number | null;
  relics: number | null;
  fragments: number | null;
  reincarnationRound: number | null;

  reincarnation: {
    requiredLevel: number | null;
    levelBefore: number | null;
    levelShortfall: number | null;
    goldCost: number | null;
    goldShortfall: number | null;
    awardedPoints: number | null;
    arcaneFish: number | null;
    eligible: boolean;
  } | null;

  baitId: string | null;
  baitName: string | null;
  baitUnitPrice: number | null;

  /** 保底进度（稀有鱼 / 宝箱 / 神器），拿不到的项不出现 */
  pity: PityProgressView[];

  fleet: {
    boatName: string | null;
    boatBiomeId: string | null;
    boatBiomeName: string | null;
    canChangeBoatBiome: boolean;
    sameAsCurrent: boolean;
  } | null;

  /** 面板生成时间 */
  at?: number;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export type StatusPanelInputs = {
  /** GET /api/fishing/state 的响应 */
  state: any;
  /** id → biome 的映射 */
  biomesById: Map<string, any>;
  /** GET /api/me 的响应 */
  me: any;
  /** GET /api/player/reincarnation 的响应 */
  reincarnation: any;
  /** 当前鱼饵（GET /api/baits 里 isSelected 的那条） */
  bait: any;
  /** GET /api/statistics 的响应（稀有鱼硬保底） */
  statistics?: any;
  /** GET /api/inventory/chests 的响应（奥术宝箱硬保底） */
  chests?: any;
  /** GET /api/lighthouse-lottery 的响应（神器保底） */
  lighthouse?: any;
};

/**
 * 保底进度：把「离必出还差多少」统一成同一种形状，面板与推送都能复用。
 * `remaining` 已经算好（不是让前端各自相减），避免两处口径不一致。
 */
export type PityProgressView = {
  key: string;
  label: string;
  /** 已累计多少（杆 / 个） */
  dry: number;
  /** 硬保底阈值 */
  total: number;
  /** 还差多少 */
  remaining: number;
  /** 0~100 */
  percent: number;
  /** 是否已到保底（下一杆/下一个必出） */
  ready: boolean;
};

/** 从 /api/statistics 的 pity 里取一个稀有度 */
function pityOf(statistics: any, key: "exotic" | "arcane", label: string): PityProgressView | null {
  const block = statistics?.pity?.[key];
  if (!block) return null;
  const total = num(block.hardPityCasts);
  if (total <= 0) return null;
  const dry = Math.max(0, num(block.currentDryCasts));
  const remaining = Math.max(0, total - dry);
  return {
    key,
    label,
    dry,
    total,
    remaining,
    percent: Math.min(100, Math.round((dry / total) * 100)),
    ready: remaining === 0,
  };
}

/** 从 /api/inventory/chests 取宝箱保底（可能有多个宝箱，取第一个有保底的） */
function chestPityOf(chests: any): PityProgressView | null {
  const list: any[] = chests?.chests ?? chests?.items ?? [];
  for (const c of list) {
    const p = c?.pity;
    if (!p) continue;
    const total = num(p.hardPityOpens);
    if (total <= 0) continue;
    const dry = Math.max(0, num(p.currentDryOpens));
    const remaining = Math.max(0, total - dry);
    return {
      key: `chest:${c.chestId ?? c.id ?? "?"}`,
      label: String(c.name ?? c.chestName ?? "奥术宝箱"),
      dry,
      total,
      remaining,
      percent: Math.min(100, Math.round((dry / total) * 100)),
      ready: remaining === 0,
    };
  }
  return null;
}

/**
 * 从 /api/lighthouse-lottery 取神器保底。
 * 这个接口的字段是 artifactPityDryDraws + artifactPityRemaining（两者相加才是阈值）。
 */
function lighthousePityOf(lh: any): PityProgressView | null {
  const player = lh?.player ?? lh ?? {};
  const dry = num(player.artifactPityDryDraws);
  const remainRaw = player.artifactPityRemaining;
  const remaining = remainRaw === null || remainRaw === undefined ? null : num(remainRaw);
  const total = remaining === null ? (dry > 0 ? dry + 30 : 0) : dry + remaining;
  if (total <= 0) return null;
  return {
    key: "lighthouse",
    label: "灯塔神器",
    dry,
    total,
    remaining: remaining ?? Math.max(0, total - dry),
    percent: Math.min(100, Math.round((dry / total) * 100)),
    ready: (remaining ?? Math.max(0, total - dry)) === 0,
  };
}

export function buildStatusPanel(inputs: StatusPanelInputs): StatusPanel {
  const { state, biomesById, me, reincarnation, bait, statistics, chests, lighthouse } = inputs;

  const run = state?.run ?? {};
  const fx = run.effects ?? {};
  const guild = fx.guild ?? {};
  const biome = biomesById.get(run.biomeId) ?? null;

  /* ---------- Buff：拆成「商店」与「活动」两类 ---------- */
  const buffs: BuffView[] = (state?.activeBuffs ?? [])
    .filter((b: any) => b && b.buffType === "experience" && b.status !== "expired")
    .map((b: any) => ({
      tag: String(b.displayTag ?? b.name ?? "增益"),
      bp: num(b.bonusBasisPoints),
      endsAt: b.endsAt ?? null,
      source: b.source ?? null,
    }));
  const buffXpBp = buffs.reduce((a, b) => a + b.bp, 0);

  const shopBp = buffs.filter((b) => !EVENT_SOURCES.includes(b.source ?? "")).reduce((a, b) => a + b.bp, 0);
  const eventBp = buffs.filter((b) => EVENT_SOURCES.includes(b.source ?? "")).reduce((a, b) => a + b.bp, 0);

  /* ---------- 各分区 ---------- */
  const masteryBp = num(fx.mapXpBonusBasisPoints);
  const talentBp = num(fx.globalXpBonusBasisPoints);
  const artifactBp = num(fx.artifactExperienceBonusBasisPoints);
  const guildTotemBp = num(guild.experienceBonusBasisPoints);
  const guildBiomeBoostBp = num(guild.biomeBoostExperienceBasisPoints);
  // 智力直接当万分比用（游戏公式：min(有效智力, 100000)）
  const wisdomBp = Math.min(num(me?.player?.stats?.total?.intelligence), 100_000);
  // 船队分区：最近一杆的服务端结算里带出来
  const partyBp = num(state?.lastResult?.partyBonusBasisPoints);

  // 天气 id：模拟器（对真实响应验证过）用的是 `weatherId || id`，
  // 这里保持一致，避免游戏在某处只下发 id 时天气面板变成空白。
  const weatherRaw = biome?.weather ?? null;
  const weatherId = weatherRaw?.weatherId ?? weatherRaw?.id ?? null;
  const weatherMult = weatherMultiplier(weatherId);
  const weatherBp = Math.round((weatherMult - 1) * 10_000);

  const sections: XpSections = {
    permanentBp: masteryBp + talentBp,
    artifactBp,
    weatherBp,
    wisdomBp,
    guildBp: guildTotemBp + guildBiomeBoostBp,
    partyBp,
    shopBp,
    eventBp,
  };

  const xpTotal = totalXpMultiplier(sections);

  /* ---------- 转生 ---------- */
  const pv = reincarnation?.preview;
  const reincarnationView: StatusPanel["reincarnation"] = pv
    ? {
        requiredLevel: numOrNull(pv.requiredLevel),
        levelBefore: numOrNull(pv.levelBefore),
        levelShortfall: numOrNull(pv.levelShortfall),
        goldCost: numOrNull(pv.goldCost),
        goldShortfall: numOrNull(pv.goldShortfall),
        awardedPoints: numOrNull(pv.awardedPoints),
        arcaneFish: numOrNull(reincarnation?.arcaneFish),
        eligible: Boolean(pv.eligible),
      }
    : null;

  /* ---------- 船队 ---------- */
  const party = state?.party;
  const fleet: StatusPanel["fleet"] = party?.isInParty
    ? {
        boatName: party.boatName ?? null,
        boatBiomeId: party.boatBiomeId ?? null,
        boatBiomeName: biomesById.get(party.boatBiomeId)?.name ?? null,
        canChangeBoatBiome: Boolean(party.canChangeBoatBiome),
        sameAsCurrent: party.boatBiomeId === run.biomeId,
      }
    : null;

  return {
    biomeId: run.biomeId ?? null,
    biomeName: biome?.name ?? null,
    valueMultiplier: numOrNull(biome?.valueMultiplier),

    masteryBp,
    talentBp,
    artifactBp,
    guildBp: guildTotemBp,
    guildBiomeBoostBp,
    buffs,
    buffXpBp,
    shopBp,
    eventBp,
    wisdomBp,
    partyBp,
    sections,
    xpTotal,

    weatherId,
    weatherName: weatherName(weatherId),
    weatherXpPct: weatherBp / 100,

    // 「哪张图有公会经验增益」—— 玩家最常问的问题之一
    guildBoosts: (state?.guildBiomeBoosts ?? []).map((g: any) => ({
      biomeId: g.biomeId,
      name: biomesById.get(g.biomeId)?.name ?? g.biomeId,
      bp: num(g.experienceBonusBasisPoints),
      endsAt: g.endsAt ?? null,
    })),

    level: numOrNull(me?.player?.level),
    experience: numOrNull(me?.player?.experience),
    experienceToNextLevel: numOrNull(me?.player?.experienceToNextLevel),
    gold: numOrNull(me?.player?.gold),
    relics: numOrNull(me?.player?.relics),
    fragments: numOrNull(me?.player?.fragments),
    reincarnationRound: numOrNull(me?.player?.reincarnation?.round),

    reincarnation: reincarnationView,

    baitId: bait?.id ?? me?.player?.selectedBaitId ?? null,
    // 用游戏内档位中文名（接口给的 name 可能是英文，也可能缺失）
    baitName: baitNameOf(bait?.id ?? me?.player?.selectedBaitId) ?? bait?.name ?? null,
    baitUnitPrice: bait?.unitPrice ?? null,

    // 保底进度：稀有鱼（奇异/奥秘）+ 宝箱 + 神器，拿不到的项自动省略
    pity: [
      pityOf(statistics, "arcane", "奥秘鱼"),
      pityOf(statistics, "exotic", "奇异鱼"),
      chestPityOf(chests),
      lighthousePityOf(lighthouse),
    ].filter((p): p is PityProgressView => p !== null),

    fleet,

    at: Date.now(),
  };
}

/** 供测试与文档引用：每个分区的中文名 */
export const SECTION_LABELS: Record<keyof XpSections, string> = {
  permanentBp: "地图专精 + 天赋",
  artifactBp: "神器",
  weatherBp: "天气",
  wisdomBp: "智力",
  guildBp: "公会图腾 + 区域",
  partyBp: "船队",
  shopBp: "商店增益",
  eventBp: "活动增益",
};
