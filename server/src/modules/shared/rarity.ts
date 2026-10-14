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

/**
 * 供 multi-select（勾选框）字段用：九档全列出来，用户勾哪些就哪些生效。
 *
 * ★ 为什么统一改成勾选框：以前是「低于 X 档就卖」这种阈值下拉，把一个**集合**压成了一个点 ——
 *   想「只卖普通和精良、史诗也卖、但稀有留着」这种组合就表达不出来；
 *   而且阈值语义是「以下全包含」，调到某一档会连带影响它下面所有档，用户很难预期。
 */
export function rarityCheckboxOptions(opts: { include?: readonly Rarity[] } = {}): {
  value: string;
  label: string;
}[] {
  const list = opts.include ?? RARITIES;
  return list.map((r) => ({ value: r, label: `${RARITIES.indexOf(r) + 1}级·${RARITY_LABELS[r]}` }));
}

/** 低于某档的全部稀有度（可含自身）——用于把旧的阈值配置换算成集合 */
export function raritiesBelow(rarity: unknown, opts: { includeSelf?: boolean } = {}): Rarity[] {
  const rank = rarityRank(rarity);
  if (rank < 0) return [];
  return RARITIES.filter((_r, i) => (opts.includeSelf ? i <= rank : i < rank));
}

/** 某档及以上的全部稀有度 ——用于把「保护高稀有度」换算成集合 */
export function raritiesAtOrAbove(rarity: unknown): Rarity[] {
  const rank = rarityRank(rarity);
  if (rank < 0) return [];
  return RARITIES.filter((_r, i) => i >= rank);
}

/** 高价值档位（日报里单独一行展示的那几档） */
export const HIGH_RARITIES: Rarity[] = ["legendary", "mythic", "exotic", "arcane"];

/** 游戏只允许分解这三档装备（分解得到装备结晶） */
export const DISMANTLABLE_RARITIES: Rarity[] = ["legendary", "mythic", "exotic"];

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

/**
 * 供 select 字段用：「高级饵（200 金币）」。
 *
 * ★ 选项文字里**不再带幸运 / 稀有度加成**：加上去之后文案太长，会溢出下拉框
 *   （触发器是 nowrap 的固定宽度盒子）。那些信息放在字段说明里（见 BAIT_TIERS_NOTE）。
 */
export function baitOptions(opts: { includeEmpty?: boolean; emptyLabel?: string } = {}): {
  value: string;
  label: string;
}[] {
  const list = BAIT_TIERS.map((b) => ({
    value: b.id,
    label: `${b.name}（${b.unitPrice > 0 ? `${b.unitPrice} 金币` : "免费"}）`,
  }));
  if (opts.includeEmpty) {
    return [{ value: "", label: opts.emptyLabel ?? "不切换" }, ...list];
  }
  return list;
}

/** 鱼饵档位一句话说明（自动换饵各字段的 hint 用它，避免塞进选项文字里） */
export const BAIT_TIERS_NOTE =
  "档位越高幸运越高：基础饵 免费 · 低级饵 40 · 中级饵 100（幸运 250）· 高级饵 200（幸运 500，神话/奇异/奥秘 ×1.25）· 顶级饵 1000（幸运 1000，×1.5）。";
