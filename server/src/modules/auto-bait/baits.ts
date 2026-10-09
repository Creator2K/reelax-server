// 鱼饵相关纯逻辑（可单测）
//
// ★ 这里存在的理由：`/api/baits` 的字段名是**接口契约**，写错不会报错，
//   只会让判断永远走错分支。第一版把余量字段写成 `ownedQuantity`（真实字段是
//   `quantity`），结果真机上「每次检查都买 200 个饵」，白花金币且日志刷屏。
//   把这类判断抽成纯函数，就能用测试钉住字段名。
import { BAIT_TIERS, baitById } from "../shared/rarity.ts";

/** /api/baits 返回的单条鱼饵（只列用到的字段） */
export type BaitInfo = {
  id: string;
  name?: string;
  tier?: string;
  unitPrice?: number;
  luck?: number;
  /** 库存数量 —— 字段名就是 quantity，不是 ownedQuantity */
  quantity?: number;
  /** 基础饵是无限的（不消耗、也不用买） */
  isUnlimited?: boolean;
  isSelected?: boolean;
};

/** 从 /api/baits 的响应里取列表（兼容几种包裹形式） */
export function extractBaits(resp: unknown): BaitInfo[] {
  const r = resp as { baits?: unknown; items?: unknown; list?: unknown } | null;
  const list = r?.baits ?? r?.items ?? r?.list;
  return Array.isArray(list) ? (list.filter(Boolean) as BaitInfo[]) : [];
}

/** 找当前选中的那个（兼容 isSelected / selected / isEquipped） */
export function findSelectedBait(list: BaitInfo[]): BaitInfo | null {
  return (
    list.find((b) => b?.isSelected === true || (b as { selected?: boolean })?.selected === true || (b as { isEquipped?: boolean })?.isEquipped === true) ??
    null
  );
}

export function baitDisplayName(bait: BaitInfo | null | undefined): string {
  if (!bait) return "未知";
  return baitById(bait.id)?.name ?? bait.name ?? bait.id;
}

export type RefillDecision =
  | { buy: false; reason: string; stock: number | null }
  | { buy: true; quantity: number; reason: string; stock: number };

/**
 * 决定要不要补货（纯函数）。
 *
 * 规则（与旧版行为一致）：
 *  - 配置为 0 → 不自动购买
 *  - 无限饵（基础饵 / 单价 0）→ 不买
 *  - 库存 > 0 → 不买（避免每次检查都重复购买）
 *  - 库存 <= 0 → 买 buyQuantity（夹到 1..5000）
 */
export function decideRefill(
  bait: BaitInfo,
  config: { buyQuantity?: unknown },
): RefillDecision {
  const configured = Math.max(0, Math.floor(Number(config.buyQuantity) || 0));
  const price = Number(bait.unitPrice) || 0;
  const isUnlimited = bait.isUnlimited === true || price === 0;
  // quantity 缺失时按 0 处理（宁可买一次，也不要因为读不到而永远不补货）
  const stockRaw = Number(bait.quantity);
  const stock = Number.isFinite(stockRaw) ? Math.max(0, Math.floor(stockRaw)) : 0;

  if (configured <= 0) {
    return { buy: false, reason: "未开启自动购买", stock: isUnlimited ? null : stock };
  }
  if (isUnlimited) {
    return { buy: false, reason: "无限鱼饵，无需购买", stock: null };
  }
  if (stock > 0) {
    return { buy: false, reason: `还有 ${stock} 个，无需补货`, stock };
  }
  const quantity = Math.max(1, Math.min(5000, configured));
  return { buy: true, quantity, reason: `库存为 0，购买 ${quantity} 个`, stock };
}

/** 把最终生效的鱼饵名说清楚（配置里的 id → 中文名） */
export function describeBaitChoice(baitId: string): string {
  const b = baitById(baitId);
  if (!b) return baitId || "（未配置）";
  return `${b.name}（${b.unitPrice > 0 ? `${b.unitPrice} 金币` : "免费"}${b.luck > 0 ? ` · 幸运 ${b.luck}` : ""}）`;
}

/** 校验配置里选的鱼饵 id 是否是我们已知的档位 */
export function isValidBaitId(id: unknown): boolean {
  return BAIT_TIERS.some((b) => b.id === id);
}
