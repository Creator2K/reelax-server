// 以物易物路径规划（纯函数）
//
// 这块判错的后果很具体：换错鱼、把「自己挂的单」当别人的单去响应（游戏直接拒），
// 或者绕远路多换好几手 —— 所以逐条钉住：
//   · 多轮交换（B2 → B3 → B6 → B5）
//   · 跳数最少优先；同跳数时容量大（不容易被抢）的优先
//   · 只走与起点鱼同稀有度的边；只支持最高三档
//   · 排除自己的单、已被换完的单、非 active 的单
//   · 走不通时说清原因
import { describe, expect, it } from "vitest";
import {
  barterErrorMessage,
  barterNextCursor,
  fetchBarterOrders,
  normalizeBarterOrders,
  planBarterChain,
  readBarterOrder,
  type BarterEntry,
  type BarterFish,
  type BarterOrder,
} from "../src/services/barter-plan.ts";

/* ---------- 造数据的小工具 ---------- */

const f = (fishId: string, name: string, biomeId: string, rarity = "mythic"): BarterFish => ({
  fishId,
  name,
  biomeId,
  rarity,
});

const entry = (fish: BarterFish, quantity: number, remaining = quantity): BarterEntry => ({
  fish,
  initialQuantity: quantity,
  remainingQuantity: remaining,
});

/** 一张交换单：单主想用 offers 换 requests（响应者交出 requests 里的鱼） */
function makeOrder(
  id: string,
  requests: BarterEntry[],
  offers: BarterEntry[],
  extra: Partial<BarterOrder> = {},
): BarterOrder {
  return {
    id,
    rarity: requests[0]?.fish.rarity ?? "mythic",
    ownerNickname: `单主${id}`,
    ownerPublicId: `owner-${id}`,
    status: "active",
    expiresAt: null,
    requests,
    offers,
    ...extra,
  };
}

const B2 = f("fish-b2", "雾语灯笼鱼", "b_002");
const B3 = f("fish-b3", "镜潮银鲷", "b_003");
const B6 = f("fish-b6", "霞栖彩鲤", "b_006");
const B5 = f("fish-b5", "星根盲鳗", "b_005");

const plan = (orders: BarterOrder[], opts: Partial<Parameters<typeof planBarterChain>[0]> = {}) =>
  planBarterChain({
    orders,
    fromFishId: B2.fishId,
    rarity: "mythic",
    maxHops: 3,
    isTarget: (fish) => fish.fishId === B5.fishId,
    ...opts,
  });

describe("planBarterChain", () => {
  it("★ 直达一单：1 跳就够", () => {
    const order = makeOrder("o1", [entry(B2, 1)], [entry(B5, 1)]);
    const r = plan([order]);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hops).toHaveLength(1);
    expect(r.hops[0]).toMatchObject({ orderId: "o1" });
    expect(r.hops[0]!.give.fishId).toBe(B2.fishId);
    expect(r.hops[0]!.get.fishId).toBe(B5.fishId);
  });

  it("★ 多轮交换：B2 → B3 → B6 → B5（用户举的例子）", () => {
    const orders = [
      makeOrder("o1", [entry(B2, 2)], [entry(B3, 2)]),
      makeOrder("o2", [entry(B3, 3)], [entry(B6, 3)]),
      makeOrder("o3", [entry(B6, 1)], [entry(B5, 1)]),
    ];
    const r = plan(orders);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hops.map((h) => [h.give.fishId, h.get.fishId])).toEqual([
      [B2.fishId, B3.fishId],
      [B3.fishId, B6.fishId],
      [B6.fishId, B5.fishId],
    ]);
    expect(r.capacity).toBe(1); // 最紧的一跳：o3 只剩 1 次
  });

  it("★ 跳数最少优先：1 跳的路赢过 2 跳的路", () => {
    const orders = [
      makeOrder("short", [entry(B2, 1)], [entry(B5, 1)]),
      makeOrder("a", [entry(B2, 1)], [entry(B3, 1)]),
      makeOrder("b", [entry(B3, 1)], [entry(B5, 1)]),
    ];
    const r = plan(orders);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hops.map((h) => h.orderId)).toEqual(["short"]);
  });

  it("★ 同跳数时优先容量大的那条（不容易被别人抢走）", () => {
    const orders = [
      // 经 B3 走：最后那一跳只剩 1 次
      makeOrder("thin-a", [entry(B2, 5)], [entry(B3, 5)]),
      makeOrder("thin-b", [entry(B3, 1)], [entry(B5, 1)]),
      // 经 B6 走：那一跳还剩 9 次
      makeOrder("fat-a", [entry(B2, 5)], [entry(B6, 5)]),
      makeOrder("fat-b", [entry(B6, 9)], [entry(B5, 9)]),
    ];
    const r = plan(orders);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hops.map((h) => h.orderId)).toEqual(["fat-a", "fat-b"]);
    expect(r.capacity).toBe(5);
  });

  it("★ 跳过自己发布的单（昵称与玩家 id 各判一次）", () => {
    const mine = makeOrder("mine", [entry(B2, 1)], [entry(B5, 1)], {
      ownerNickname: "我自己",
      ownerPublicId: "me-1",
    });
    const other = makeOrder("other", [entry(B2, 1)], [entry(B5, 1)]);

    // 只给昵称
    const byName = plan([mine, other], { selfNickname: "我自己" });
    expect(byName.ok).toBe(true);
    if (byName.ok) expect(byName.hops[0]!.orderId).toBe("other");

    // 只给 id
    const byId = plan([mine, other], { selfPublicId: "me-1" });
    expect(byId.ok).toBe(true);
    if (byId.ok) expect(byId.hops[0]!.orderId).toBe("other");
  });

  it("★ 只走同稀有度的边：奇异鱼的单不能拿神话鱼去换", () => {
    const exotic = makeOrder("x", [entry(B2, 1)], [entry({ ...B5, rarity: "exotic" }, 1)], { rarity: "exotic" });
    const r = plan([exotic]);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("没有能在");
  });

  it("★ 起点鱼不是最高三档 → 直接说清楚（游戏不允许这类交换单）", () => {
    const r = plan([], { rarity: "epic" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("最高三档");
  });

  it("★ 已被换完 / 非 active 的单不能用", () => {
    const empty = makeOrder("empty", [entry(B2, 2, 0)], [entry(B5, 2)]);
    const done = makeOrder("done", [entry(B2, 2)], [entry(B5, 2)], { status: "filled" });
    expect(plan([empty, done]).ok).toBe(false);

    // 只是单边剩余为 0 也不行
    const halfEmpty = makeOrder("half", [entry(B2, 2)], [entry(B5, 2, 0)]);
    expect(plan([halfEmpty]).ok).toBe(false);
  });

  it("★ 超出 maxHops 就说走不通", () => {
    const orders = [
      makeOrder("o1", [entry(B2, 1)], [entry(B3, 1)]),
      makeOrder("o2", [entry(B3, 1)], [entry(B6, 1)]),
      makeOrder("o3", [entry(B6, 1)], [entry(B5, 1)]),
    ];
    const r = plan(orders, { maxHops: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("2 次交换");
  });

  it("起点鱼本身就是目标 → 明确说不必交换", () => {
    const r = plan([makeOrder("o1", [entry(B2, 1)], [entry(B5, 1)])], {
      fromFishId: B5.fishId,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("已经符合目标");
  });

  it("同一张单里「交出」和「获得」是同一种鱼时跳过这一对组合", () => {
    const weird = makeOrder("weird", [entry(B2, 1)], [entry(B2, 1)]);
    expect(plan([weird]).ok).toBe(false);
  });

  it("★ 不会绕回头（路径上的鱼不重复）", () => {
    const orders = [
      makeOrder("ab", [entry(B2, 1)], [entry(B3, 1)]),
      makeOrder("ba", [entry(B3, 1)], [entry(B2, 1)]),
      makeOrder("bc", [entry(B3, 1)], [entry(B6, 1)]),
      makeOrder("cb", [entry(B6, 1)], [entry(B5, 1)]),
    ];
    const r = plan(orders);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const path = [B2.fishId, ...r.hops.map((h) => h.get.fishId)];
    expect(new Set(path).size).toBe(path.length);
    expect(path).toEqual([B2.fishId, B3.fishId, B6.fishId, B5.fishId]);
  });

  it("一张单里的多个鱼种可以各挑一种（需求 2 种 × 提供 2 种）", () => {
    const order = makeOrder("multi", [entry(B2, 1), entry(B3, 1)], [entry(B6, 1), entry(B5, 1)]);
    const r = plan([order]);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hops[0]!.get.fishId).toBe(B5.fishId);
  });
});

describe("交换单解析", () => {
  it("数组 / {orders} / {items} 三种形状都认", () => {
    const raw = { id: "o1", requests: [{ fish: { fishId: "a", name: "A" }, remainingQuantity: 1 }], offers: [{ fish: { fishId: "b", name: "B" }, remainingQuantity: 1 }] };
    expect(normalizeBarterOrders([raw])).toHaveLength(1);
    expect(normalizeBarterOrders({ orders: [raw] })).toHaveLength(1);
    expect(normalizeBarterOrders({ items: [raw] })).toHaveLength(1);
    expect(normalizeBarterOrders(null)).toEqual([]);
  });

  it("缺字段的单被丢掉，而不是抛错", () => {
    expect(readBarterOrder(null)).toBeNull();
    expect(readBarterOrder({})).toBeNull();
    // 只有需求没有提供 → 不可响应
    expect(readBarterOrder({ id: "x", requests: [{ fish: { fishId: "a" } }], offers: [] })).toBeNull();
  });

  it("remainingQuantity 缺失时按「还有 initialQuantity 次」处理", () => {
    const order = readBarterOrder({
      id: "o1",
      requests: [{ fish: { fishId: "a", name: "A" }, quantity: 3 }],
      offers: [{ fish: { fishId: "b", name: "B" }, quantity: 3 }],
    });
    expect(order?.requests[0]!.remainingQuantity).toBe(3);
  });

  it("单主信息：昵称与玩家 id 都能从几种形状里读出来", () => {
    const order = readBarterOrder({
      id: "o1",
      owner: { nickname: "艾拉", publicId: "p-1" },
      requests: [{ fish: { fishId: "a" }, remainingQuantity: 1 }],
      offers: [{ fish: { fishId: "b" }, remainingQuantity: 1 }],
    });
    expect(order?.ownerNickname).toBe("艾拉");
    expect(order?.ownerPublicId).toBe("p-1");
  });

  it("翻页游标", () => {
    expect(barterNextCursor({ nextCursor: "abc" })).toBe("abc");
    expect(barterNextCursor({})).toBeNull();
    expect(barterNextCursor({ nextCursor: "" })).toBeNull();
  });
});

describe("fetchBarterOrders", () => {
  it("按游标翻页，直到没有下一页", async () => {
    const pages: Record<string, { orders: unknown[]; nextCursor?: string }> = {
      "": { orders: [{ id: "a", requests: [{ fish: { fishId: "x" }, remainingQuantity: 1 }], offers: [{ fish: { fishId: "y" }, remainingQuantity: 1 }] }], nextCursor: "c1" },
      c1: { orders: [{ id: "b", requests: [{ fish: { fishId: "x" }, remainingQuantity: 1 }], offers: [{ fish: { fishId: "y" }, remainingQuantity: 1 }] }] },
    };
    const seen: (string | undefined)[] = [];
    const orders = await fetchBarterOrders(
      {
        barterOrders: async (query) => {
          seen.push(query?.cursor);
          return pages[query?.cursor ?? ""] ?? { orders: [] };
        },
      },
      { pages: 4 },
    );

    expect(seen).toEqual([undefined, "c1"]);
    expect(orders.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("页数上限生效，且不会死循环", async () => {
    let calls = 0;
    const orders = await fetchBarterOrders(
      {
        barterOrders: async () => {
          calls += 1;
          return {
            orders: [{ id: `o${calls}`, requests: [{ fish: { fishId: "x" }, remainingQuantity: 1 }], offers: [{ fish: { fishId: "y" }, remainingQuantity: 1 }] }],
            nextCursor: "always",
          };
        },
      },
      { pages: 3 },
    );
    expect(calls).toBe(3);
    expect(orders).toHaveLength(3);
  });
});

describe("barterErrorMessage", () => {
  it("已知错误码翻译成人话，未知的原样带出来", () => {
    expect(barterErrorMessage(new Error("BARTER_ORDER_UNAVAILABLE"))).toContain("被别人换走");
    expect(barterErrorMessage(new Error("BARTER_SELF_TRADE"))).toContain("自己发布");
    expect(barterErrorMessage(new Error("BARTER_RARITY_NOT_ALLOWED"))).toContain("神话");
    expect(barterErrorMessage(new Error("INVENTORY_QUANTITY_INSUFFICIENT"))).toContain("库存");
    expect(barterErrorMessage(new Error("SOMETHING_ELSE: 细节"))).toContain("SOMETHING_ELSE");
    expect(barterErrorMessage(null)).toContain("没有返回原因");
  });
});
