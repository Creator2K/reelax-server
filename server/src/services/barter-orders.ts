// 以物易物：交换单的接口层（解析 / 翻页 / 错误码翻译）
//
// 游戏规则（决定了消费方怎么写）：
//  · 一张单 = 单主的「需求若干鱼种」×「提供若干鱼种」；响应一次是**一对一**：
//    交出 requests 里的 1 条、获得 offers 里的 1 条；
//  · 同一张单可被多人继续响应，最多成交次数 = min(需求总量, 提供总量)；
//  · 不能响应自己发布的单（BARTER_SELF_TRADE）；
//  · 只支持最高三档稀有度，且同一单里的鱼同稀有度（游戏端拦，这里不重复判）。
//
// 方向（已对着游戏客户端确认，别抄反）：`fill` 的 body 是
// `{ requestFishId: 我交出, offerFishId: 我获得 }` ——
// 所以「用 X 换到 Y」这条边是 **X ∈ requests → Y ∈ offers**。
export type BarterFish = {
  fishId: string;
  name: string;
  biomeId: string | null;
  rarity: string;
};

export type BarterEntry = {
  fish: BarterFish;
  /** 挂单时写的数量 */
  initialQuantity: number;
  /** 还能成交几次 */
  remainingQuantity: number;
};

export type BarterOrder = {
  id: string;
  rarity: string;
  /** 单主昵称（识别「自己的单」用；拿不到就是 null） */
  ownerNickname: string | null;
  /** 单主玩家 id（比昵称可靠，能拿到就优先用它排除自己的单） */
  ownerPublicId: string | null;
  status: string;
  expiresAt: number | null;
  requests: BarterEntry[];
  offers: BarterEntry[];
};

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 列表响应形状兜底：数组 / `{orders}` / `{items}` 都认 */
export function barterOrderList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const p = payload as { orders?: unknown; items?: unknown } | null;
  if (Array.isArray(p?.orders)) return p.orders;
  if (Array.isArray(p?.items)) return p.items;
  return [];
}

/** 列表响应里的翻页游标（没有就返回 null） */
export function barterNextCursor(payload: unknown): string | null {
  const c = (payload as { nextCursor?: unknown } | null)?.nextCursor;
  return typeof c === "string" && c ? c : null;
}

function readFish(raw: any): BarterFish | null {
  const id = str(raw?.fishId ?? raw?.id);
  if (!id) return null;
  return {
    fishId: id,
    name: str(raw?.name) || id,
    biomeId: raw?.biomeId ? String(raw.biomeId) : null,
    rarity: str(raw?.rarity),
  };
}

/** 一侧（需求 / 提供）的条目：字段名随版本可能变化，这里逐种兜底 */
function readEntries(raw: unknown): BarterEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BarterEntry[] = [];
  for (const item of raw as any[]) {
    const fish = readFish(item?.fish ?? item);
    if (!fish) continue;
    const initial = num(item?.initialQuantity ?? item?.quantity);
    const remainingRaw = item?.remainingQuantity ?? item?.remaining;
    const remaining = remainingRaw === undefined ? initial : num(remainingRaw);
    out.push({ fish, initialQuantity: initial, remainingQuantity: remaining });
  }
  return out;
}

/** 一条交换单（形状不认识就返回 null，绝不抛错） */
export function readBarterOrder(raw: unknown): BarterOrder | null {
  const r = raw as any;
  const id = str(r?.id ?? r?.orderId);
  if (!id) return null;
  const requests = readEntries(r?.requests ?? r?.request);
  const offers = readEntries(r?.offers ?? r?.offer);
  if (!requests.length || !offers.length) return null;
  const owner = r?.ownerNickname ?? r?.owner?.nickname ?? r?.ownerName ?? r?.nickname;
  const ownerId = r?.ownerPublicId ?? r?.owner?.publicId ?? r?.ownerId ?? r?.owner?.id;
  return {
    id,
    rarity: str(r?.rarity ?? requests[0]?.fish.rarity),
    ownerNickname: owner ? String(owner) : null,
    ownerPublicId: ownerId ? String(ownerId) : null,
    // status 缺失时按「可响应」处理：宁可尝试一次（失败会被游戏拒绝），也不要漏掉能换的单
    status: str(r?.status) || "active",
    expiresAt: Number.isFinite(Number(r?.expiresAt)) ? Number(r.expiresAt) : null,
    requests,
    offers,
  };
}

export function normalizeBarterOrders(payload: unknown): BarterOrder[] {
  const out: BarterOrder[] = [];
  for (const raw of barterOrderList(payload)) {
    const order = readBarterOrder(raw);
    if (order) out.push(order);
  }
  return out;
}

/** 拉交换单需要的客户端能力（结构类型，便于单测传假客户端） */
export type BarterOrdersFetcher = {
  barterOrders(query?: {
    cursor?: string;
    limit?: number;
    canFulfill?: boolean;
    offersMastery?: boolean;
    rarity?: string;
    targetFishId?: string;
  }): Promise<unknown>;
};

/**
 * 翻页拉全交换单。
 *
 * ★ 默认 `canFulfill: false`：要的是**整张市场的单**（包括我现在响应不了、但换到中间产物之后
 *   就能响应的那些），否则多轮交换根本串不起来 —— 这是「交换助手」能找出长链的前提。
 */
export async function fetchBarterOrders(
  fetcher: BarterOrdersFetcher,
  opts: { limit?: number; pages?: number; onProgress?: (info: { pages: number; orders: number }) => void } = {},
): Promise<{ orders: BarterOrder[]; pages: number; truncated: boolean }> {
  const limit = Math.min(Math.max(Math.floor(num(opts.limit) || 50), 1), 100);
  const pages = Math.min(Math.max(Math.floor(num(opts.pages) || 1), 1), 200);
  const all: BarterOrder[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let used = 0;

  for (let page = 0; page < pages; page++) {
    const resp = await fetcher.barterOrders({ limit, canFulfill: false, offersMastery: false, cursor: cursor ?? undefined });
    used = page + 1;
    for (const order of normalizeBarterOrders(resp)) {
      if (order.status !== "active" || seen.has(order.id)) continue;
      seen.add(order.id);
      all.push(order);
    }
    opts.onProgress?.({ pages: used, orders: all.length });
    cursor = barterNextCursor(resp);
    if (!cursor) return { orders: all, pages: used, truncated: false };
  }

  return { orders: all, pages: used, truncated: Boolean(cursor) };
}

/**
 * 以物易物错误码 → 人话（认不出的原样带出来，便于排查）。
 */
export function barterErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const known: [string, string][] = [
    ["BARTER_ORDER_NOT_FOUND", "这张交换单已经不在了（被取消或已完成）"],
    ["BARTER_ORDER_UNAVAILABLE", "这张交换单现在响应不了（可能刚被别人换走一部分）"],
    ["BARTER_ORDER_EXPIRED", "这张交换单已过期，剩余鱼获已返还"],
    ["BARTER_SELF_TRADE", "不能响应自己发布的交换单"],
    ["BARTER_RARITY_NOT_ALLOWED", "以物易物只支持神话 / 奇异 / 奥秘三档稀有度"],
    ["BARTER_RARITY_MISMATCH", "同一张交换单里的鱼必须是同一稀有度"],
    ["INVENTORY_QUANTITY_INSUFFICIENT", "可用库存不足（鱼可能被卖掉了或被锁定）"],
    ["FISH_LOCKED", "这条鱼被手动锁或专精保护锁着，先解除锁定才能交出"],
    ["MARKET_ORDER_LIMIT_REACHED", "已达市场活动订单数量上限"],
    ["IDEMPOTENCY_CONFLICT", "请求内容发生变化，请重试"],
  ];
  for (const [code, text] of known) {
    if (raw.includes(code)) return text;
  }
  return raw || "操作失败（没有返回原因）";
}
