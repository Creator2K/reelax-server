// 自动 Buff 的商品表与「该不该买」的判定（纯函数，可单测）
//
// ★ 商品表来自游戏前端 bundle（实测抓取：前端 0.25.2 / contentVersion 2026.20）。
//   bundle 里商店商品数组 `_k` 一共 8 项，全部是 personal_buff：
//     relic-xp-i(潮痕研习 I, +30%, 1800s, 75 遗物)
//     relic-xp-ii(潮痕研习 II, +75%, 1800s, 150 遗物)
//     relic-strength-i / relic-strength-ii(渊流臂力 I/II, +10%/+25%, 1800s)
//     relic-luck-i / relic-luck-ii(星鳞灵感 I/II, +10%/+25%, 1800s)
//     fragment-personal-xp(碎光顿悟, 个人经验 +25%, 7200s, 20 碎片)
//     fragment-global-xp(万流共鸣, **全服**经验 +50%, 7200s, 50 碎片)
//
// ★ 这个文件曾经埋了一个「整个模块等于没跑」的坑：
//   「潮痕研习 II」的 id 被写成 `relic-personal-xp` —— 游戏里**没有**这个商品。
//   它又排在商品表第一位，于是每次检查的第一条购买请求必然失败，
//   异常把 for 循环一起带走，后面的「碎光顿悟」等商品全都被跳过。
//   表现为「自动购买 Buff 完全没生效」，但日志里只有一条含糊的失败。
//   改 id 之前请先核对 bundle 里的 `_k` 数组（见 docs/PROTOCOL.md §4.3）。
import { parseTime } from "../../lib/util.ts";

export type Shop = "relic" | "fragment";
export type BuffCategory = "experience" | "strength" | "luck";

export type ShopProduct = {
  productId: string;
  name: string;
  /** 游戏里的效果描述 */
  effect: string;
  /** 哪个商店：遗物商店 / 奥秘碎片商店 */
  shop: Shop;
  /** 游戏里的 category 字段（activeBuffs 里叫 buffType） */
  category: BuffCategory;
  bonusBasisPoints: number;
  durationSec: number;
  price: number;
  /** 对应的配置开关键 */
  toggle: string;
};

/** 商品表（productId 与游戏内商店一致，勿凭感觉改） */
export const SHOP_PRODUCTS: ShopProduct[] = [
  {
    productId: "relic-xp-ii",
    name: "潮痕研习 II",
    effect: "个人经验 +75%",
    shop: "relic",
    category: "experience",
    bonusBasisPoints: 7500,
    durationSec: 1800,
    price: 150,
    toggle: "buyXpRelic",
  },
  {
    productId: "fragment-personal-xp",
    name: "碎光顿悟",
    effect: "个人经验 +25%",
    shop: "fragment",
    category: "experience",
    bonusBasisPoints: 2500,
    durationSec: 7200,
    price: 20,
    toggle: "buyXpFragment",
  },
  {
    productId: "fragment-global-xp",
    name: "万流共鸣",
    effect: "全服经验 +50%（按购买顺序生效）",
    shop: "fragment",
    category: "experience",
    bonusBasisPoints: 5000,
    durationSec: 7200,
    price: 50,
    toggle: "buyGlobalXp",
  },
  {
    productId: "relic-strength-ii",
    name: "渊流臂力 II",
    effect: "有效力量 +25%",
    shop: "relic",
    category: "strength",
    bonusBasisPoints: 2500,
    durationSec: 1800,
    price: 150,
    toggle: "buyStrength",
  },
  {
    productId: "relic-luck-ii",
    name: "星鳞灵感 II",
    effect: "有效运气 +25%",
    shop: "relic",
    category: "luck",
    bonusBasisPoints: 2500,
    durationSec: 1800,
    price: 150,
    toggle: "buyLuck",
  },
];

export const SHOP_LABEL: Record<Shop, string> = { relic: "遗物", fragment: "碎片" };

/** 商店来源（activeBuffs[].source）——个人增益都是这个 */
export const PERSONAL_SHOP_SOURCE = "personal_shop";

export type ActiveBuff = {
  source?: unknown;
  buffType?: unknown;
  shop?: unknown;
  bonusBasisPoints?: unknown;
  status?: unknown;
  endsAt?: unknown;
  displayTag?: unknown;
  name?: unknown;
};

export type PurchaseDecision =
  | { action: "buy"; remainingMs: number }
  | { action: "skip"; reason: string }
  | { action: "warn"; key: string; reason: string };

/** 剩余时间（毫秒）；读不到结束时间按 0（= 已经没了）算 */
export function remainingMsOf(buff: ActiveBuff, now: number): number {
  const ends = parseTime(buff.endsAt);
  if (ends === null) return 0;
  return Math.max(0, ends - now);
}

/** 某商店 + 某类别下「还没过期」的个人增益 */
export function activePersonalBuffs(buffs: ActiveBuff[], shop: Shop, category: BuffCategory): ActiveBuff[] {
  return buffs.filter(
    (b) =>
      b &&
      b.source === PERSONAL_SHOP_SOURCE &&
      b.shop === shop &&
      b.buffType === category &&
      b.status !== "expired",
  );
}

function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
}

function tagOf(b: ActiveBuff): string {
  return String(b.displayTag ?? b.name ?? "同类增益");
}

/**
 * 单个商品的购买判定。
 *
 * 判定顺序（便宜且在本地就能判完的排在前面）：
 *   1. 同类增益正生效（**不同商品**）→ 游戏里这种购买会被拒（商店按钮直接禁用），不去撞
 *   2. 就是自己且剩余时间 > keepMs → 不续
 *   3. 余额下限 / 每日预算 → 交给调用方 warnOnce
 *   4. 买
 */
export function decidePurchase(input: {
  product: ShopProduct;
  buffs: ActiveBuff[];
  /** 该商品所在商店的余额 */
  balance: number;
  /** 余额下限（低于 price + reserve 就不买） */
  reserve: number;
  spentToday: number;
  /** 0 = 不限 */
  dailyBudget: number;
  keepMs: number;
  now: number;
}): PurchaseDecision {
  const { product, buffs, balance, reserve, spentToday, dailyBudget, keepMs, now } = input;

  const same = activePersonalBuffs(buffs, product.shop, product.category);
  const mine = same.find((b) => Number(b.bonusBasisPoints) === product.bonusBasisPoints) ?? null;
  // 同店同类的**别的**商品（例如手动买了「潮痕研习 I」，本模块配的是 II）
  const other = same.find((b) => Number(b.bonusBasisPoints) !== product.bonusBasisPoints) ?? null;

  if (other) {
    const remain = remainingMsOf(other, now);
    return {
      action: "skip",
      reason:
        `同类增益生效中：${tagOf(other)}` +
        (remain > 0 ? `（还剩 ${minutes(remain)}）` : "") +
        `，此时买「${product.name}」会被游戏拒绝，等它结束后再续买`,
    };
  }

  if (mine) {
    const remain = remainingMsOf(mine, now);
    if (remain > keepMs) {
      return { action: "skip", reason: `「${product.name}」还剩 ${minutes(remain)}，暂不续买` };
    }
    // 剩余时间已经不多（或读不到结束时间）→ 续买
    return { action: "buy", remainingMs: remain };
  }

  if (dailyBudget > 0 && spentToday + product.price > dailyBudget) {
    return {
      action: "warn",
      key: `${product.productId}:budget`,
      reason:
        `「${product.name}」已超出今日预算` +
        `（已花 ${spentToday} / 上限 ${dailyBudget} ${SHOP_LABEL[product.shop]}），明天再续买`,
    };
  }

  if (balance < product.price + reserve) {
    return {
      action: "warn",
      key: `${product.productId}:balance`,
      reason:
        `「${product.name}」余额不足，跳过：需要 ${product.price} + 保留 ${reserve} = ${product.price + reserve}，` +
        `现有 ${balance} ${SHOP_LABEL[product.shop]}`,
    };
  }

  return { action: "buy", remainingMs: 0 };
}
