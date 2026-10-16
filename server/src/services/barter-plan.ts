// 以物易物：交换单解析 + 多轮交换路径规划（纯函数，便于单测）
//
// 游戏里的规则（决定这里为什么这么写）：
//  · 以物易物**只支持最高三档稀有度**（神话 / 奇异 / 奥秘），且**同一张单里的鱼必须同稀有度**
//    —— 所以一条链从起点鱼出发，全程留在同一个稀有度里；
//  · 响应一张单是**一对一**：从单主的「需求」里挑一种交出 1 条，从「提供」里挑一种获得 1 条；
//    同一张单可以被多个人继续响应，直到需求满足 / 提供鱼换完；
//  · **不能响应自己发布的单**（BARTER_SELF_TRADE）。
//
// 于是「B2 的鱼 → B5 的鱼」这种多轮交换就是一个有向图上的最短路：
//   点 = 鱼种，边 = 「交出 X 能换到 Y」（来自某张单的 需求X × 提供Y 组合），
//   边的容量 = 两侧剩余量的较小值（这一对组合还能成交几次）。
// 规划目标：**跳数最少**；跳数相同时优先「容量最大」的那条（不容易被别人抢掉）。
import { rarityRank } from "../modules/shared/rarity.ts";

/** 以物易物只支持最高三档稀有度（游戏端 BARTER_RARITY_NOT_ALLOWED） */
export const BARTER_RARITIES = ["mythic", "exotic", "arcane"] as const;

export function isBarterRarity(rarity: unknown): boolean {
  return rarityRank(rarity) >= rarityRank("mythic");
}

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

/** 一跳：响应某张单，交出 give、获得 get */
export type BarterHop = {
  orderId: string;
  ownerNickname: string | null;
  give: BarterFish & { remaining: number };
  get: BarterFish & { remaining: number };
  /** 这一对组合最多还能成交几次（两侧剩余量的较小值） */
  capacity: number;
};

export type BarterPlan =
  | { ok: true; hops: BarterHop[]; capacity: number }
  | { ok: false; reason: string };

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
 * 翻页拉全「当前能响应」的交换单。
 *
 * 模块（要尽量看全，最多 4 页）与面板（给个路径预览，2 页足够）共用这一支。
 */
export async function fetchBarterOrders(
  fetcher: BarterOrdersFetcher,
  opts: { limit?: number; pages?: number } = {},
): Promise<BarterOrder[]> {
  const limit = Math.min(Math.max(Math.floor(num(opts.limit) || 50), 1), 100);
  const pages = Math.min(Math.max(Math.floor(num(opts.pages) || 1), 1), 10);
  const all: BarterOrder[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const resp = await fetcher.barterOrders({ limit, cursor: cursor ?? undefined });
    all.push(...normalizeBarterOrders(resp));
    cursor = barterNextCursor(resp);
    if (!cursor) break;
  }
  return all;
}

type Candidate = { capacity: number; path: BarterHop[] };
type Visited = { hops: number; capacity: number; path: BarterHop[] };

/**
 * 规划一条从 `fromFishId` 到目标鱼的最短交换链。
 *
 * @param orders      交换单（建议已按稀有度收窄，这里仍会逐条校验稀有度）
 * @param fromFishId  起点鱼
 * @param rarity      起点鱼的稀有度；给了就只走同稀有度的边（游戏限制），null = 不校验
 * @param maxHops     最多几跳
 * @param isTarget    目标判定（通常是「某张地图 + 可选具体鱼种」）
 * @param selfNickname 自己的昵称：匹配上的单子直接跳过（不能响应自己的单）
 */
export function planBarterChain(input: {
  orders: BarterOrder[];
  fromFishId: string;
  rarity?: string | null;
  maxHops: number;
  isTarget: (fish: BarterFish) => boolean;
  /** 自己的昵称：匹配上的单子直接跳过（不能响应自己的单） */
  selfNickname?: string | null;
  /** 自己的玩家 id（更可靠；两个都给就都用来排除） */
  selfPublicId?: string | null;
}): BarterPlan {
  const from = str(input.fromFishId);
  if (!from) return { ok: false, reason: "没有指定起点鱼" };

  const maxHops = Math.min(Math.max(Math.floor(num(input.maxHops) || 1), 1), 8);
  const rarity = input.rarity ? String(input.rarity) : null;
  const self = input.selfNickname ? String(input.selfNickname) : null;
  const selfId = input.selfPublicId ? String(input.selfPublicId) : null;
  if (rarity && !isBarterRarity(rarity)) {
    return { ok: false, reason: "以物易物只支持最高三档稀有度（神话 / 奇异 / 奥秘）" };
  }

  /* ---------- 建图：交出 → 获得 ---------- */
  const outgoing = new Map<string, BarterHop[]>();
  const push = (hop: BarterHop) => {
    const list = outgoing.get(hop.give.fishId);
    if (list) list.push(hop);
    else outgoing.set(hop.give.fishId, [hop]);
  };

  for (const order of input.orders) {
    if (order.status && order.status !== "active") continue;
    if (self && order.ownerNickname && order.ownerNickname === self) continue;
    if (selfId && order.ownerPublicId && order.ownerPublicId === selfId) continue;
    const orderRarity = order.rarity || null;
    if (rarity && orderRarity && orderRarity !== rarity) continue;

    for (const req of order.requests) {
      if (req.remainingQuantity <= 0) continue;
      if (rarity && req.fish.rarity && req.fish.rarity !== rarity) continue;
      for (const off of order.offers) {
        if (off.remainingQuantity <= 0) continue;
        if (rarity && off.fish.rarity && off.fish.rarity !== rarity) continue;
        // 游戏不允许「交出和获得是同一种鱼」
        if (off.fish.fishId === req.fish.fishId) continue;
        push({
          orderId: order.id,
          ownerNickname: order.ownerNickname,
          give: { ...req.fish, remaining: req.remainingQuantity },
          get: { ...off.fish, remaining: off.remainingQuantity },
          capacity: Math.min(req.remainingQuantity, off.remainingQuantity),
        });
      }
    }
  }

  const fromFish: BarterFish = { fishId: from, name: from, biomeId: null, rarity: rarity ?? "" };
  if (input.isTarget(fromFish)) return { ok: false, reason: "起点鱼本身已经符合目标（不需要交换）" };

  /* ---------- 逐层 BFS：先比跳数，再比容量 ---------- */
  const visited = new Map<string, Visited>();
  visited.set(from, { hops: 0, capacity: Number.POSITIVE_INFINITY, path: [] });
  let frontier: string[] = [from];

  for (let hop = 1; hop <= maxHops; hop++) {
    // 本层候选：同一个点上只留「容量最大」的那条（同容量保留先遇到的，结果稳定可测）
    const level = new Map<string, Candidate>();
    for (const u of frontier) {
      const cur = visited.get(u);
      if (!cur) continue;
      for (const edge of outgoing.get(u) ?? []) {
        const to = edge.get.fishId;
        if (visited.has(to)) continue; // 更短的路径已经到过它
        const capacity = Math.min(cur.capacity, edge.capacity);
        const prev = level.get(to);
        if (!prev || capacity > prev.capacity) {
          level.set(to, { capacity, path: [...cur.path, edge] });
        }
      }
    }
    if (!level.size) break;

    // 本层里已经够到目标的：挑容量最大的一条返回（跳数已经是最少）
    let best: Candidate | null = null;
    for (const cand of level.values()) {
      const arrived = cand.path[cand.path.length - 1]!.get;
      if (!input.isTarget(arrived)) continue;
      if (!best || cand.capacity > best.capacity) best = cand;
    }
    if (best) {
      return { ok: true, hops: best.path, capacity: best.capacity };
    }

    for (const [to, cand] of level) {
      visited.set(to, { hops: hop, capacity: cand.capacity, path: cand.path });
    }
    frontier = [...level.keys()];
  }

  return {
    ok: false,
    reason: `当前没有能在 ${maxHops} 次交换内换到目标的现成交换单（只接现成的单，不自己挂单）`,
  };
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
