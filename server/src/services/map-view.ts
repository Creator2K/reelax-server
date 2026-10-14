// 「地图与天气」面板的数据组装 + 换图前的校验（纯函数，便于单测）
//
// 为什么抽出来：这两个函数决定了「界面上显示什么」与「点了换图会不会被拒」，
// 而它们都只依赖 /api/biomes 的原始响应 —— 纯函数就能钉住天气映射、
// 已解锁/未解锁、比赛标记、以及带队权限的判断，不必起一个假游戏服务。
import { weatherMultiplier, weatherName } from "../modules/keep-online/xp-multiplier.ts";
import { biomeUnlockInfo } from "../modules/shared/biomes.ts";

export type MapWeatherView = { id: string; name: string; xpMultiplier: number };

export type MapItemView = {
  id: string;
  name: string;
  isUnlocked: boolean;
  isCurrent: boolean;
  /** 鱼价值倍率（越高越赚） */
  valueMultiplier: number;
  weather: MapWeatherView | null;
  /** 这张图上有比赛在跑（游戏下发的 activeCompetitions 非空） */
  competitionActive: boolean;
  /** 我报名的比赛就在这张图时的说明（进行中 / 即将开赛），否则 null */
  myCompetition: string | null;
  /** 解锁所需的等级与金币（未解锁时会显示出来） */
  requiredLevel: number;
  unlockCost: number;
};

export type AccountMapsView = {
  currentBiomeId: string | null;
  current: MapItemView | null;
  /** 船队状态（决定界面要不要给「带队一起走」开关） */
  party: {
    inParty: boolean;
    canChangeBoatBiome: boolean;
    boatName: string | null;
    boatBiomeId: string | null;
  } | null;
  maps: MapItemView[];
};

/** 当前地图的天气 id（与自动切图/卖鱼保持一致：weatherId 优先，其次 id） */
export function biomeWeatherId(biome: any): string | null {
  return biome?.weather?.weatherId ?? biome?.weather?.id ?? null;
}

export function buildMapsView(input: {
  biomes: any[];
  /** biomeId → 「我报名的比赛」说明 */
  myCompetitionBiomes: Map<string, string>;
  party: AccountMapsView["party"];
}): AccountMapsView {
  const maps: MapItemView[] = [];
  let currentBiomeId: string | null = null;

  for (const b of input.biomes ?? []) {
    if (!b?.id) continue;
    const id = String(b.id);
    const weatherId = biomeWeatherId(b);
    const info = biomeUnlockInfo(b);
    const isCurrent = b.isCurrent === true;
    if (isCurrent) currentBiomeId = id;

    maps.push({
      id,
      name: String(b.name ?? id),
      isUnlocked: b.isUnlocked !== false,
      isCurrent,
      valueMultiplier: Number(b.valueMultiplier) || 1,
      weather: weatherId
        ? { id: weatherId, name: weatherName(weatherId) ?? weatherId, xpMultiplier: weatherMultiplier(weatherId) }
        : null,
      competitionActive: Array.isArray(b.activeCompetitions) && b.activeCompetitions.length > 0,
      myCompetition: input.myCompetitionBiomes.get(id) ?? null,
      requiredLevel: info.requiredLevel,
      unlockCost: info.unlockCost,
    });
  }

  return {
    currentBiomeId,
    current: maps.find((m) => m.isCurrent) ?? null,
    party: input.party ?? null,
    maps,
  };
}

export type TravelCheck = { ok: true } | { ok: false; code: string; message: string };

/* ---------- 比赛标记 ---------- */

/** 「即将开赛」的显示窗口：更远的场次不显示（否则五天后开赛的比赛也会挂在图上） */
export const COMPETITION_SOON_MS = 2 * 60 * 60 * 1000;
/** 已过开赛时间但状态还没转成 active 的宽限：超过就当历史场次丢掉 */
export const STARTED_GRACE_MS = 30 * 60 * 1000;

const TERMINAL_TOURNAMENT_STATUSES = new Set([
  "ended",
  "finished",
  "settled",
  "settling",
  "canceled",
  "cancelled",
  "closed",
]);

/** 「42 分钟后开赛」这种说法（只看 2 小时以内，所以最多两位数的分钟 / 1 小时多） */
export function countdownText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min <= 0) return "马上开赛";
  if (min < 60) return `${min} 分钟后开赛`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分钟后开赛` : `${h} 小时后开赛`;
}

/**
 * 「我报名的比赛在哪张图」：个人赛 / 公会赛各一份 overview → biomeId → 说明。
 *
 * 规则（与自动切图的比赛目标口径一致，避免两个模块说法不同）：
 *  · 只认**未结束**且**我报名了**的场次；
 *  · 进行中的直接标记；
 *  · 即将开赛的必须有可解析的 `startAt`，且落在 [now - 宽限, now + 2 小时] 内 ——
 *    没有下界判断的话，upcoming 里残留的历史场次会永远挂在那儿；
 *  · 多场比赛撞同一张图时，进行中的优先。
 */
export function buildCompetitionMarks(input: {
  personal: any;
  guild: any;
  now: number;
  soonMs?: number;
}): Map<string, string> {
  const soon = input.soonMs ?? COMPETITION_SOON_MS;
  const out = new Map<string, string>();
  const active = new Set<string>();

  const consider = (t: any, registeredKey: string, kind: string) => {
    if (!t?.[registeredKey]) return;
    const status = String(t?.status ?? "").toLowerCase();
    if (TERMINAL_TOURNAMENT_STATUSES.has(status)) return;

    const biomeId = String(t?.assignedBiomeId ?? t?.biomeId ?? "");
    if (!biomeId) return;

    const label = `${kind} #${t.sequence ?? "?"}`;
    if (status === "active") {
      out.set(biomeId, `${label} 进行中`);
      active.add(biomeId);
      return;
    }
    if (status && status !== "scheduled") return; // 不认识的中间状态不当标记

    const at = Date.parse(String(t?.startAt ?? ""));
    if (!Number.isFinite(at)) return;
    const delta = at - input.now;
    if (delta > soon || delta < -STARTED_GRACE_MS) return;

    // 进行中的标记优先，别被同图的「即将开赛」覆盖
    if (active.has(biomeId)) return;
    out.set(biomeId, `${label} · ${countdownText(delta)}`);
  };

  for (const t of [input.personal?.current, ...(input.personal?.upcoming ?? [])]) consider(t, "isRegistered", "个人赛");
  for (const t of [input.guild?.current, ...(input.guild?.upcoming ?? [])]) consider(t, "entryStatus", "公会赛");
  return out;
}

/** 换图前的校验（纯函数）：把「不可能成功」的情况在发请求之前说清楚 */
export function checkTravel(input: {
  biome: MapItemView | null;
  party: AccountMapsView["party"];
  mode: "solo" | "party";
}): TravelCheck {
  const { biome, party, mode } = input;
  if (!biome) return { ok: false, code: "MAP_NOT_FOUND", message: "地图不存在（可能是游戏改版）" };
  if (!biome.isUnlocked) {
    return {
      ok: false,
      code: "BIOME_LOCKED",
      message:
        `「${biome.name}」还没解锁（需 Lv ${biome.requiredLevel}` +
        (biome.unlockCost > 0 ? ` / ${biome.unlockCost.toLocaleString("zh-CN")} 金币` : "") +
        "）；可以先在「自动解锁地图」里把它买下来",
    };
  }
  if (biome.isCurrent) return { ok: false, code: "ALREADY_THERE", message: `已经身处「${biome.name}」` };

  if (mode === "party") {
    if (!party?.inParty) return { ok: false, code: "NOT_IN_PARTY", message: "当前没有加入船队，无法带队换图" };
    if (!party.canChangeBoatBiome) {
      return { ok: false, code: "NOT_CAPTAIN", message: "你不是船长 / 舵手，不能把整条船开走" };
    }
  }
  return { ok: true };
}
