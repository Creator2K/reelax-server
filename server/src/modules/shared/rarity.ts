// 稀有度阶梯与标签（游戏九级，低 → 高）
//
// 与游戏内一致，勿随意调整顺序：稀有度排序用于「低于 X 直接卖、高于 Y 挂市场」这类判断。

export const RARITIES = [
  "common",
  "uncommon",
  "fine",
  "rare",
  "epic",
  "legendary",
  "mythic",
  "exotic",
  "arcane",
] as const;

export type Rarity = (typeof RARITIES)[number];

export const RARITY_LABELS: Record<Rarity, string> = {
  common: "普通",
  uncommon: "罕见",
  fine: "精良",
  rare: "稀有",
  epic: "史诗",
  legendary: "传说",
  mythic: "神话",
  exotic: "奇异",
  arcane: "奥秘",
};

/** -1 表示未知稀有度 */
export function rarityRank(rarity: unknown): number {
  return RARITIES.indexOf(rarity as Rarity);
}

export function rarityLabel(rarity: unknown): string {
  return RARITY_LABELS[rarity as Rarity] ?? String(rarity ?? "未知");
}

/** 供 select 字段用：「3级·精良」 */
export function rarityOptions(): { value: string; label: string }[] {
  return RARITIES.map((r, i) => ({ value: r, label: `${i + 1}级·${RARITY_LABELS[r]}` }));
}

/** 高价值档位（日报里单独一行展示的那几档） */
export const HIGH_RARITIES: Rarity[] = ["legendary", "mythic", "exotic", "arcane"];

/** 四项属性的中文名 */
export const STAT_LABELS = {
  strength: "力量",
  intelligence: "智力",
  luck: "运气",
  endurance: "耐力",
} as const;

export type StatKey = keyof typeof STAT_LABELS;
export const STAT_KEYS: StatKey[] = ["strength", "intelligence", "luck", "endurance"];

/** 解析 "a,b,c" / "a，b，c" 为小写数组 */
export function parseList(s: unknown): string[] {
  return String(s ?? "")
    .split(/[,，、\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/* ---------------- 鱼饵档位 ---------------- */

/**
 * 鱼饵档位表（取自游戏 bundle 的 bait 定义，勿手改）：
 *   id = `bait_<tier>`
 *
 * | tier    | 名称   | 单价 | 幸运 | 可钓稀有度 |
 * |---------|--------|------|------|-----------|
 * | basic   | 基础饵 | 0    | 0    | 1~2 级    |
 * | low     | 低级饵 | 40   | 0    | 1~5 级    |
 * | medium  | 中级饵 | 100  | 250  | 1~9 级    |
 * | high    | 高级饵 | 200  | 500  | 1~9 级（神话/奇异/奥秘 ×1.25）|
 * | supreme | 顶级饵 | 1000 | 1000 | 2~9 级（神话/奇异/奥秘 ×1.5）|
 *
 * ★ 用中文名而不是 `bait_high` 这种 id，是因为用户看不懂 id。
 *   配置里存的是 id（与游戏接口一致），UI 上显示的是中文名。
 */
export const BAIT_TIERS = [
  { id: "bait_basic", tier: "basic", name: "基础饵", unitPrice: 0, luck: 0, rarityRange: "1~2 级", rarityBoost: null },
  { id: "bait_low", tier: "low", name: "低级饵", unitPrice: 40, luck: 0, rarityRange: "1~5 级", rarityBoost: null },
  { id: "bait_medium", tier: "medium", name: "中级饵", unitPrice: 100, luck: 250, rarityRange: "1~9 级", rarityBoost: null },
  {
    id: "bait_high",
    tier: "high",
    name: "高级饵",
    unitPrice: 200,
    luck: 500,
    rarityRange: "1~9 级",
    rarityBoost: "神话/奇异/奥秘 ×1.25",
  },
  {
    id: "bait_supreme",
    tier: "supreme",
    name: "顶级饵",
    unitPrice: 1000,
    luck: 1000,
    rarityRange: "2~9 级",
    rarityBoost: "神话/奇异/奥秘 ×1.5",
  },
] as const;

export type BaitTierId = (typeof BAIT_TIERS)[number]["id"];

export function baitById(id: unknown): (typeof BAIT_TIERS)[number] | null {
  return BAIT_TIERS.find((b) => b.id === id) ?? null;
}

export function baitName(id: unknown): string | null {
  return baitById(id)?.name ?? null;
}

/** 供 select 字段用：「高级饵（200 金币 · 幸运 500 · 神话/奇异/奥秘 ×1.25）」 */
export function baitOptions(opts: { includeEmpty?: boolean; emptyLabel?: string } = {}): {
  value: string;
  label: string;
}[] {
  const list = BAIT_TIERS.map((b) => {
    const detail = [
      b.unitPrice > 0 ? `${b.unitPrice} 金币` : "免费",
      b.luck > 0 ? `幸运 ${b.luck}` : null,
      b.rarityBoost,
    ]
      .filter(Boolean)
      .join(" · ");
    return { value: b.id, label: `${b.name}（${detail}）` };
  });
  if (opts.includeEmpty) {
    return [{ value: "", label: opts.emptyLabel ?? "不切换" }, ...list];
  }
  return list;
}
