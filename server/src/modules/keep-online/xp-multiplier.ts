// 天气经验倍率表
//
// ★ 这张表是从游戏前端 bundle 里抄下来的固定常量，**不能靠 weather.effect 文本反推**：
//   金风（gilded_current）与枯潮（wither_tide）的文本里根本没提经验，但倍率是 0.75 / 0.5。
//   之前就是因为按文本解析，导致「经验优先」模式选错地图。
export const WEATHER_XP_MULTIPLIER: Record<string, number> = {
  clear: 1,
  rain: 1.05,
  gale: 1.1,
  mist: 1.2,
  heatwave: 1.3,
  tempest: 1.5,
  wither_tide: 0.5,
  gilded_current: 0.75,
  arcane_surge: 1.75,
};

export const WEATHER_NAMES: Record<string, string> = {
  clear: "晴朗",
  rain: "雨幕",
  // 以下名称取自游戏 bundle 的 weather 定义（不要凭印象写「疾风/薄雾」）
  gale: "强风",
  mist: "浓雾",
  heatwave: "热浪",
  // 游戏里这个天气叫「雷暴」（不是「风暴」）
  tempest: "雷暴",
  wither_tide: "枯潮",
  gilded_current: "金风",
  arcane_surge: "奥秘涌流",
};

/** 特殊天气（自动切图会优先考虑的那几种） */
export const SPECIAL_WEATHERS = ["wither_tide", "gilded_current", "tempest", "heatwave"] as const;

export function weatherMultiplier(weatherId: unknown): number {
  const id = String(weatherId ?? "");
  return WEATHER_XP_MULTIPLIER[id] ?? 1;
}

export function weatherName(weatherId: unknown): string | null {
  const id = String(weatherId ?? "");
  return WEATHER_NAMES[id] ?? (id || null);
}

/** 万分比 → 倍率 */
export const bpToMultiplier = (bp: unknown): number => 1 + (Number(bp) || 0) / 10000;
