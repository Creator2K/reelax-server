// 交换助手：路径搜索（纯函数）
//
// 这套逻辑是从浏览器脚本《专精交换助手 v1.2.0》移植的，所以用例也对齐脚本的语义：
//   · 边方向 = 「用 需求鱼 换到 提供鱼」（反向搜索靠 backward 索引）；
//   · 目标是专精进度里「还差 > 0」的鱼（已解锁、非等待中、手上还没够）；
//   · 只保留用背包模拟能走通的链，并按「跳数 → 目标稀有度」排序。
import { describe, expect, it } from "vitest";
import type { BarterFish, BarterOrder } from "../src/services/barter-orders.ts";
import {
  buildSwapGraph,
  findPathsToTarget,
  isSwapPathFeasible,
  readSwapInventory,
  readSwapTargets,
  searchSwapPaths,
  sortSwapPaths,
  SWAP_MAX_LENGTH,
  type SwapPath,
  type SwapTarget,
} from "../src/services/swap-plan.ts";

const f = (fishId: string, name: string, biomeId: string, rarity = "mythic"): BarterFish => ({
  fishId,
  name,
  biomeId,
  rarity,
});

const B2 = f("f-b2", "雾语灯笼鱼", "b_002");
const B3 = f("f-b3", "镜潮银鲷", "b_003");
const B6 = f("f-b6", "霞栖彩鲤", "b_006");
const B5 = f("f-b5", "星根盲鳗", "b_005");

/** 一张单：单主想用 offers 换 requests（响应者交出 requests 里的鱼） */
function order(
  id: string,
  requests: [BarterFish, number][],
  offers: [BarterFish, number][],
  extra: Partial<BarterOrder> = {},
): BarterOrder {
  return {
    id,
    rarity: "mythic",
    ownerNickname: `单主${id}`,
    ownerPublicId: `owner-${id}`,
    status: "active",
    expiresAt: null,
    requests: requests.map(([fish, qty]) => ({ fish, initialQuantity: qty, remainingQuantity: qty })),
    offers: offers.map(([fish, qty]) => ({ fish, initialQuantity: qty, remainingQuantity: qty })),
    ...extra,
  };
}

const target = (fish: BarterFish, extra: Partial<SwapTarget> = {}): SwapTarget => ({
  fishId: fish.fishId,
  name: fish.name,
  rarity: fish.rarity,
  biomeId: fish.biomeId,
  remaining: 5,
  available: 0,
  ...extra,
});

describe("背包与专精进度解析", () => {
  it("背包：数量累加，锁定与 0 条的跳过", () => {
    const inv = readSwapInventory({
      fish: [
        { fishId: "a", quantity: 2 },
        { fishId: "a", quantity: 3 },
        { fishId: "b", quantity: 1, isLocked: true },
        { fishId: "c", quantity: 4, isMasteryLocked: true },
        { fishId: "d", quantity: 0 },
        { quantity: 9 },
      ],
    });
    expect([...inv.entries()]).toEqual([["a", 5]]);
  });

  it("★ 专精目标：跳过未解锁地图 / 等待中 / 不差的 / 没有鱼 id 的", () => {
    const list = readSwapTargets({
      biomes: [
        {
          biomeId: "b_002",
          isUnlocked: true,
          rarities: [
            { fish: { id: "t1", name: "目标一" }, rarity: "mythic", remainingQuantity: 3, availableQuantity: 0 },
            { fish: { id: "t2" }, rarity: "mythic", remainingQuantity: 0 },
            { fish: { id: "t3" }, rarity: "mythic", remainingQuantity: 2, isWaiting: true },
            { rarity: "mythic", remainingQuantity: 4 },
          ],
        },
        { biomeId: "b_003", isUnlocked: false, rarities: [{ fish: { id: "t4" }, remainingQuantity: 3 }] },
      ],
    });
    expect(list.map((t) => t.fishId)).toEqual(["t1"]);
    expect(list[0]).toMatchObject({ name: "目标一", biomeId: "b_002", remaining: 3 });
  });

  it("★ 手上已经够数的目标跳过（直接去献祭就行，不用换）", () => {
    const mastery = {
      biomes: [
        {
          biomeId: "b_002",
          isUnlocked: true,
          rarities: [
            { fish: { id: "t1" }, remainingQuantity: 3, availableQuantity: 5 },
            { fish: { id: "t2" }, remainingQuantity: 3, availableQuantity: 1 },
          ],
        },
      ],
    };
    expect(readSwapTargets(mastery).map((t) => t.fishId)).toEqual(["t1", "t2"]);
    expect(readSwapTargets(mastery, new Map([["t1", 5]])).map((t) => t.fishId)).toEqual(["t2"]);
  });
});

describe("buildSwapGraph", () => {
  it("★ 边 = 「用 需求鱼 换到 提供鱼」，容量取两侧剩余量较小值", () => {
    const graph = buildSwapGraph([order("o1", [[B2, 3]], [[B3, 5]])]);
    expect(graph.edges).toBe(1);
    const hop = graph.forward.get(B2.fishId)?.[0];
    expect(hop).toMatchObject({ orderId: "o1", requestFishId: B2.fishId, offerFishId: B3.fishId, capacity: 3 });
    expect(graph.backward.get(B3.fishId)?.[0]?.orderId).toBe("o1");
  });

  it("多需求 × 多提供会展开成多条边；同一种鱼的自换被跳过", () => {
    const graph = buildSwapGraph([order("o1", [[B2, 1], [B3, 1]], [[B6, 1], [B2, 1]])]);
    // B2→B6、B3→B6、B3→B2 三条（B2→B2 自己换自己被跳过）
    expect(graph.edges).toBe(3);
    expect(graph.forward.get(B2.fishId)?.map((h) => h.offerFishId)).toEqual([B6.fishId]);
  });

  it("非 active 的单、剩余量为 0 的条目都不进图", () => {
    const finished = order("done", [[B2, 1]], [[B3, 1]], { status: "filled" });
    const empty = order("empty", [[B2, 0]], [[B3, 1]]);
    const emptyOffer = order("empty2", [[B2, 1]], [[B3, 0]]);
    const graph = buildSwapGraph([finished, empty, emptyOffer]);
    expect(graph.edges).toBe(0);
  });
});

describe("findPathsToTarget / searchSwapPaths", () => {
  it("★ 直达一单：1 跳", () => {
    const graph = buildSwapGraph([order("o1", [[B2, 1]], [[B5, 1]])]);
    const paths = findPathsToTarget({
      targetFishId: B5.fishId,
      sources: new Set([B2.fishId]),
      graph,
      maxLength: SWAP_MAX_LENGTH,
      maxPaths: 10,
    });
    expect(paths).toHaveLength(1);
    expect(paths[0]!.map((h) => h.orderId)).toEqual(["o1"]);
  });

  it("★ 多轮交换：B2 → B3 → B6 → B5（正序返回）", () => {
    const graph = buildSwapGraph([
      order("o1", [[B2, 2]], [[B3, 2]]),
      order("o2", [[B3, 3]], [[B6, 3]]),
      order("o3", [[B6, 1]], [[B5, 1]]),
    ]);
    const paths = findPathsToTarget({
      targetFishId: B5.fishId,
      sources: new Set([B2.fishId]),
      graph,
      maxLength: SWAP_MAX_LENGTH,
      maxPaths: 10,
    });
    expect(paths).toHaveLength(1);
    expect(paths[0]!.map((h) => h.requestFishId)).toEqual([B2.fishId, B3.fishId, B6.fishId]);
  });

  it("落不回背包的链不算（起点必须是我有的鱼）", () => {
    const graph = buildSwapGraph([order("o1", [[B3, 1]], [[B5, 1]])]);
    const paths = findPathsToTarget({
      targetFishId: B5.fishId,
      sources: new Set([B2.fishId]),
      graph,
      maxLength: SWAP_MAX_LENGTH,
      maxPaths: 10,
    });
    expect(paths).toHaveLength(0);
  });

  it("★ 超过跳数上限的链不算", () => {
    const graph = buildSwapGraph([
      order("o1", [[B2, 1]], [[B3, 1]]),
      order("o2", [[B3, 1]], [[B6, 1]]),
      order("o3", [[B6, 1]], [[B5, 1]]),
    ]);
    const paths = findPathsToTarget({
      targetFishId: B5.fishId,
      sources: new Set([B2.fishId]),
      graph,
      maxLength: 2,
      maxPaths: 10,
    });
    expect(paths).toHaveLength(0);
  });

  it("★ 同一条链上的鱼不重复（不会绕圈）", () => {
    const graph = buildSwapGraph([
      order("ab", [[B2, 5]], [[B3, 5]]),
      order("ba", [[B3, 5]], [[B2, 5]]),
      order("b5", [[B3, 1]], [[B5, 1]]),
    ]);
    const paths = findPathsToTarget({
      targetFishId: B5.fishId,
      sources: new Set([B2.fishId]),
      graph,
      maxLength: SWAP_MAX_LENGTH,
      maxPaths: 20,
    });
    for (const hops of paths) {
      const seen = new Set<string>();
      for (const hop of hops) {
        expect(seen.has(hop.requestFishId)).toBe(false);
        seen.add(hop.requestFishId);
      }
    }
  });

  it("★ 用背包模拟：只有 1 条起点鱼时，第二条依赖它的链不可行", () => {
    const direct = order("o1", [[B2, 1]], [[B5, 1]]);
    const graph = buildSwapGraph([direct]);
    const hop = graph.forward.get(B2.fishId)![0]!;
    expect(isSwapPathFeasible([hop], new Map([[B2.fishId, 1]]))).toBe(true);
    expect(isSwapPathFeasible([hop], new Map())).toBe(false);
    // 连续两次用同一条鱼 → 第二次没得交
    expect(isSwapPathFeasible([hop, hop], new Map([[B2.fishId, 1]]))).toBe(false);
    expect(isSwapPathFeasible([hop, hop], new Map([[B2.fishId, 2]]))).toBe(true);
  });

  it("★ searchSwapPaths：过滤走不通的链，并跳过完全没有反向边的目标", () => {
    const graph = buildSwapGraph([
      order("o1", [[B2, 1]], [[B5, 1]]),
      order("o2", [[B2, 1]], [[B6, 1]]), // B6 不是目标
    ]);
    const paths = searchSwapPaths({
      graph,
      inventory: new Map([[B2.fishId, 1]]),
      targets: [target(B5), target(B3)], // B3 没有任何单能换到
    });
    expect(paths.map((p) => p.target.fishId)).toEqual([B5.fishId]);
    expect(paths[0]!.length).toBe(1);
  });

  it("★ 排序：跳数少优先，其次目标稀有度低，再其次鱼种 id", () => {
    const list: SwapPath[] = [
      { target: target(B5, { rarity: "arcane" }), length: 2, hops: [] },
      { target: target(B6, { rarity: "mythic" }), length: 1, hops: [] },
      { target: target(B3, { rarity: "mythic" }), length: 1, hops: [] },
      { target: target(B2, { rarity: "exotic" }), length: 1, hops: [] },
    ];
    expect(sortSwapPaths(list).map((p) => `${p.length}:${p.target.rarity}:${p.target.fishId}`)).toEqual([
      `1:mythic:${B3.fishId}`,
      `1:mythic:${B6.fishId}`,
      "1:exotic:f-b2",
      `2:arcane:${B5.fishId}`,
    ]);
  });

  it("总量上限生效", () => {
    const orders = [order("o1", [[B2, 9]], [[B5, 9]]), order("o2", [[B3, 9]], [[B5, 9]])];
    const graph = buildSwapGraph(orders);
    const paths = searchSwapPaths({
      graph,
      inventory: new Map([
        [B2.fishId, 5],
        [B3.fishId, 5],
      ]),
      targets: [target(B5)],
      maxPathsPerTarget: 10,
      maxTotalPaths: 1,
    });
    expect(paths).toHaveLength(1);
  });
});
