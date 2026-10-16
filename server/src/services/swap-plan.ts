// 交换助手：专精目标的「多轮交换」路径搜索（纯函数，便于单测）
//
// 这套逻辑移植自浏览器脚本《专精交换助手 v1.2.0》，语义保持不变：
//  1. 扫**全部**在售交换单（不是只扫"我能响应的"），建成有向图：
//     边 X→Y = 「用 X 换到 Y」（单主的 需求X × 提供Y），容量 = 两侧剩余量的较小值；
//  2. 目标 = 专精进度里「还差 > 0」的目标鱼（已解锁、且不在等待中）；
//  3. 从每个目标**反向 DFS** 回搜，只要能落在我背包里的鱼上就是一条可行链
//     （最多 maxLength 跳，每个目标最多 maxPathsPerTarget 条，总计 maxTotalPaths 条）；
//  4. 每条链再用背包模拟走一遍（isPathFeasible），走不通的丢掉；
//  5. 排序：跳数少 → 目标稀有度低 → 鱼种 id（结果稳定可测）。
//
// ★ 与脚本的一处刻意不同：脚本主方向找不到时会"再试一次反方向"（作者当时不确定方向），
//   这里**不做**这件事 —— 方向已对着游戏客户端确认（fill 的 requestFishId = 我交出），
//   反向只会造出根本执行不了的链，把面板塞满垃圾。
import { rarityRank } from "../modules/shared/rarity.ts";
import type { BarterFish, BarterOrder } from "./barter-orders.ts";

/** 一条链最多几跳（脚本 6） */
export const SWAP_MAX_LENGTH = 6;
/** 每个目标最多保留几条链（脚本 40） */
export const SWAP_MAX_PATHS_PER_TARGET = 40;
/** 一次扫描最多返回几条链（脚本 200） */
export const SWAP_MAX_TOTAL_PATHS = 200;

export type SwapTarget = {
  fishId: string;
  name: string;
  rarity: string;
  biomeId: string | null;
  /** 专精还差几条 */
  remaining: number;
  /** 背包里现在有几条 */
  available: number;
};

/** 链上的一跳：响应 orderId 这张单，交出 give、获得 get */
export type SwapHop = {
  orderId: string;
  ownerNickname: string | null;
  requestFishId: string;
  offerFishId: string;
  give: BarterFish;
  get: BarterFish;
  /** 这一对组合最多还能成交几次 */
  capacity: number;
};

export type SwapPath = {
  /** 目标鱼（这条链走完能拿到它） */
  target: SwapTarget;
  length: number;
  hops: SwapHop[];
};

export type SwapGraph = {
  /** fromFishId → 边 */
  forward: Map<string, SwapHop[]>;
  /** toFishId → 边（反向搜索用） */
  backward: Map<string, SwapHop[]>;
  edges: number;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ---------------- 背包 / 专精进度 ---------------- */

/**
 * `/api/inventory/fish` → 鱼种 → 可用数量。
 *
 * 锁定（手动锁 / 专精锁）与数量为 0 的都不算 —— 这些鱼交不出去。
 */
export function readSwapInventory(payload: unknown): Map<string, number> {
  const list = Array.isArray((payload as { fish?: unknown })?.fish) ? (payload as { fish: unknown[] }).fish : [];
  const out = new Map<string, number>();
  for (const raw of list as any[]) {
    const fishId = String(raw?.fishId ?? raw?.id ?? "");
    if (!fishId) continue;
    const quantity = Math.floor(num(raw?.quantity));
    if (quantity <= 0) continue;
    if (raw?.isLocked || raw?.isManuallyLocked || raw?.isMasteryLocked) continue;
    out.set(fishId, (out.get(fishId) ?? 0) + quantity);
  }
  return out;
}

/**
 * `/api/mastery` → 需要换到的专精目标鱼。
 *
 * 与脚本一致：跳过未解锁地图、`isWaiting`（还没轮到）与「不差」的目标。
 * ★ 额外一条：**手上已经够数的目标也跳过**（`availableQuantity >= remainingQuantity`），
 *   这种目标直接去献祭就行，没必要再换鱼。
 */
export function readSwapTargets(mastery: unknown, inventory?: Map<string, number>): SwapTarget[] {
  const out: SwapTarget[] = [];
  const biomes = Array.isArray((mastery as { biomes?: unknown })?.biomes)
    ? (mastery as { biomes: any[] }).biomes
    : [];
  for (const biome of biomes) {
    if (biome?.isUnlocked === false) continue;
    for (const item of (Array.isArray(biome?.rarities) ? biome.rarities : []) as any[]) {
      if (item?.isWaiting) continue;
      const fishId = String(item?.fish?.id ?? item?.fish?.fishId ?? item?.fishId ?? "");
      if (!fishId) continue;
      const remaining = Math.floor(num(item?.remainingQuantity));
      if (remaining <= 0) continue;
      const available = Math.floor(num(item?.availableQuantity));
      if (inventory && available >= remaining) continue; // 手上够了
      out.push({
        fishId,
        name: String(item?.fish?.name ?? fishId),
        rarity: String(item?.rarity ?? item?.fish?.rarity ?? ""),
        biomeId: biome?.biomeId ? String(biome.biomeId) : null,
        remaining,
        available,
      });
    }
  }
  return out;
}

/* ---------------- 建图与搜索 ---------------- */

/** 把交换单列表变成图：边 = 「用 需求鱼 换到 提供鱼」 */
export function buildSwapGraph(orders: BarterOrder[]): SwapGraph {
  const forward = new Map<string, SwapHop[]>();
  const backward = new Map<string, SwapHop[]>();
  let edges = 0;

  const push = (map: Map<string, SwapHop[]>, key: string, hop: SwapHop) => {
    const list = map.get(key);
    if (list) list.push(hop);
    else map.set(key, [hop]);
  };

  for (const order of orders) {
    if (order.status !== "active") continue;
    const reqs = order.requests.filter((r) => r.fish.fishId && r.remainingQuantity > 0);
    const offs = order.offers.filter((o) => o.fish.fishId && o.remainingQuantity > 0);
    for (const req of reqs) {
      for (const off of offs) {
        // 游戏不允许「交出和获得是同一种鱼」
        if (req.fish.fishId === off.fish.fishId) continue;
        const capacity = Math.min(req.remainingQuantity, off.remainingQuantity);
        if (capacity <= 0) continue;
        const hop: SwapHop = {
          orderId: order.id,
          ownerNickname: order.ownerNickname,
          requestFishId: req.fish.fishId,
          offerFishId: off.fish.fishId,
          give: req.fish,
          get: off.fish,
          capacity,
        };
        push(forward, req.fish.fishId, hop);
        push(backward, off.fish.fishId, hop);
        edges += 1;
      }
    }
  }

  return { forward, backward, edges };
}

/** 按顺序模拟走一遍：中途任何一种鱼不够就说明这条链走不通 */
export function isSwapPathFeasible(hops: SwapHop[], inventory: Map<string, number>): boolean {
  const temp = new Map(inventory);
  for (const hop of hops) {
    const have = temp.get(hop.requestFishId) ?? 0;
    if (have < 1) return false;
    temp.set(hop.requestFishId, have - 1);
    temp.set(hop.offerFishId, (temp.get(hop.offerFishId) ?? 0) + 1);
  }
  return true;
}

/** 从目标鱼反向 DFS，找所有能落回背包的链（返回的都是「起点 → 目标」顺序） */
export function findPathsToTarget(input: {
  targetFishId: string;
  /** 手上有的鱼（链的起点必须在这里面） */
  sources: Set<string>;
  graph: SwapGraph;
  maxLength: number;
  maxPaths: number;
}): SwapHop[][] {
  const paths: SwapHop[][] = [];
  const visited = new Set([input.targetFishId]);
  const stack: SwapHop[] = [];

  const dfs = (currentFishId: string): void => {
    if (paths.length >= input.maxPaths) return;
    if (stack.length > 0 && input.sources.has(currentFishId)) {
      // 落回背包了 → 这条链成立（继续往下探更长的链，多路径共存）
      paths.push([...stack].reverse());
    }
    if (stack.length >= input.maxLength) return;
    for (const edge of input.graph.backward.get(currentFishId) ?? []) {
      if (visited.has(edge.requestFishId)) continue;
      visited.add(edge.requestFishId);
      stack.push(edge);
      dfs(edge.requestFishId);
      stack.pop();
      visited.delete(edge.requestFishId);
      if (paths.length >= input.maxPaths) return;
    }
  };

  dfs(input.targetFishId);
  return paths;
}

/** 排序：跳数少优先 → 目标稀有度低优先 → 鱼种 id（稳定） */
export function sortSwapPaths(paths: SwapPath[]): SwapPath[] {
  return [...paths].sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    const ra = rarityRank(a.target.rarity);
    const rb = rarityRank(b.target.rarity);
    if (ra !== rb) return ra - rb;
    return a.target.fishId.localeCompare(b.target.fishId);
  });
}

/** 一次搜索：所有目标 × 所有可行链 */
export function searchSwapPaths(input: {
  graph: SwapGraph;
  inventory: Map<string, number>;
  targets: SwapTarget[];
  maxLength?: number;
  maxPathsPerTarget?: number;
  maxTotalPaths?: number;
}): SwapPath[] {
  const sources = new Set([...input.inventory.entries()].filter(([, qty]) => qty > 0).map(([id]) => id));
  const maxLength = input.maxLength ?? SWAP_MAX_LENGTH;
  const perTarget = input.maxPathsPerTarget ?? SWAP_MAX_PATHS_PER_TARGET;
  const total = input.maxTotalPaths ?? SWAP_MAX_TOTAL_PATHS;

  const out: SwapPath[] = [];
  for (const target of input.targets) {
    if (out.length >= total) break;
    if (!input.graph.backward.get(target.fishId)?.length) continue; // 没有任何单能换到它
    const candidates = findPathsToTarget({
      targetFishId: target.fishId,
      sources,
      graph: input.graph,
      maxLength,
      maxPaths: perTarget,
    });
    for (const hops of candidates) {
      if (!isSwapPathFeasible(hops, input.inventory)) continue;
      out.push({ target, length: hops.length, hops });
      if (out.length >= total) break;
    }
  }
  return sortSwapPaths(out);
}
