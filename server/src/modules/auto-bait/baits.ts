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

/* ---------- 金币不足 → 自动降级 ---------- */

/**
 * 需要「换更便宜的饵」的错误码。
 *
 * ★ 用户报的现象：日志里一直刷「购买 中级饵 失败：金币不足。」
 *   游戏用 400 + `INSUFFICIENT_GOLD` 表示买不起；`BAIT_NOT_OWNED` 是这款饵还没解锁，
 *   两者都属于「这一档用不了」，降一档才有意义。
 */
export const BAIT_DOWNGRADE_CODES: readonly string[] = ["INSUFFICIENT_GOLD", "BAIT_NOT_OWNED"];

/**
 * 这个错误是否应当触发降级。
 *
 * 错误码优先；个别版本只给中文文案（用户截图里就是「金币不足。」），所以再兜一层文案匹配。
 */
export function needsCheaperBait(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  if (code && BAIT_DOWNGRADE_CODES.includes(code)) return true;
  const msg = typeof e?.message === "string" ? e.message : String(err ?? "");
  return /金币不足|尚未拥有该鱼饵/.test(msg);
}

/** 一款饵的价格：优先用接口给的单价，接口没给就查内置表 */
export function baitPrice(bait: BaitInfo | null | undefined): number {
  const p = Number(bait?.unitPrice);
  if (Number.isFinite(p) && p > 0) return p;
  return baitById(bait?.id)?.unitPrice ?? 0;
}

/**
 * 降级阶梯：比 `wantedId` 便宜的档位，从贵到便宜排列（不含它自己）。
 *
 * 只保留 `/api/baits` 里真实存在的那些（未解锁的款游戏不会下发）；
 * 排序按单价，所以游戏以后加新档位也不用改这里。
 */
export function downgradeChain(wantedId: unknown, list: BaitInfo[]): BaitInfo[] {
  const wanted = list.find((b) => b?.id === wantedId) ?? null;
  const wantedPrice = wanted ? baitPrice(wanted) : baitById(wantedId)?.unitPrice ?? 0;
  return list
    .filter((b) => b && b.id !== wantedId && baitPrice(b) < wantedPrice)
    .sort((a, b) => baitPrice(b) - baitPrice(a) || String(a.id).localeCompare(String(b.id)));
}
