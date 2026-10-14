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
