// 自动以物易物：对着假游戏 API 跑真实 onStart
//
// 这组测试盯的是「换错了 / 换亏了 / 卡死」这几类真问题：
//   · 多轮交换真的按 B2 → B3 → B6 → B5 走完，且每一步都是响应**别人**的现成单
//   · 被抢单（响应失败）后能重新规划换一条路；实在没有就半路停下、鱼留在背包里
//   · 起点鱼是专精目标鱼 / 被锁定 / 已经没了 → 一条都不换，任务标「缺鱼」
//   · 本轮配额不够走完整条路时干脆不开始（不把鱼换成半路的中间产物）
//   · 数量 5 条要换 5 次；队列串行（一次只推进队首）
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoBarter from "../src/modules/auto-barter/index.ts";
import type { BarterTaskRow } from "../src/db/repositories/barter-tasks.ts";

/* ---------- 假游戏世界 ---------- */

type FakeFish = { fishId: string; name: string; biomeId: string; rarity: string };

const f = (fishId: string, name: string, biomeId: string, rarity = "mythic"): FakeFish => ({
  fishId,
  name,
  biomeId,
  rarity,
});

const B2 = f("fish-b2", "雾语灯笼鱼", "b_002");
const B3 = f("fish-b3", "镜潮银鲷", "b_003");
const B6 = f("fish-b6", "霞栖彩鲤", "b_006");
const B5 = f("fish-b5", "星根盲鳗", "b_005");
const B7 = f("fish-b7", "云汐银刀", "b_007");

type FakeEntry = { fish: FakeFish; initialQuantity: number; remainingQuantity: number };

/** 一张交换单：单主想用 offers 换 requests（响应者交出 requests 里的鱼） */
type FakeOrder = {
  id: string;
  rarity: string;
  ownerNickname: string;
  ownerPublicId: string;
  status: string;
  requests: FakeEntry[];
  offers: FakeEntry[];
};

function mkOrder(
  id: string,
  give: [FakeFish, number],
  get: [FakeFish, number],
  extra: Partial<FakeOrder> = {},
): FakeOrder {
  return {
    id,
    rarity: give[0].rarity,
    ownerNickname: `单主${id}`,
    ownerPublicId: `owner-${id}`,
    status: "active",
    requests: [{ fish: give[0], initialQuantity: give[1], remainingQuantity: give[1] }],
    offers: [{ fish: get[0], initialQuantity: get[1], remainingQuantity: get[1] }],
    ...extra,
  };
}

type Opts = {
  config?: Record<string, unknown>;
  /** 背包：鱼种 → 数量（可带锁标记） */
  inventory?: { fishId: string; quantity: number; isLocked?: boolean; isMasteryLocked?: boolean }[];
  orders?: FakeOrder[];
  /** 这些单响应时抛「不可操作」（模拟被别人抢先换走） */
  failOrders?: string[];
  /** 这些单响应成功但背包不变（模拟结果无法确认） */
  silentOrders?: string[];
  /** 专精目标：fishId → 还缺几条 */
  mastery?: Record<string, number>;
  tasks?: Partial<BarterTaskRow>[];
  nickname?: string;
  publicId?: string;
};

function makeCtx(opts: Opts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const timers: { ms: number; fn: () => unknown }[] = [];
  const fills: { orderId: string; requestFishId: string; offerFishId: string }[] = [];

  const inventory = new Map<string, { quantity: number; isLocked?: boolean; isMasteryLocked?: boolean }>();
  for (const item of opts.inventory ?? []) {
    inventory.set(item.fishId, { quantity: item.quantity, isLocked: item.isLocked, isMasteryLocked: item.isMasteryLocked });
  }
  const orders = (opts.orders ?? []).map((o) => structuredClone(o));

  const qty = (fishId: string) => inventory.get(fishId)?.quantity ?? 0;
  const bump = (fishId: string, delta: number) => {
    if (delta < 0 && qty(fishId) <= 0) return false;
    inventory.set(fishId, { ...(inventory.get(fishId) ?? {}), quantity: Math.max(0, qty(fishId) + delta) });
    return true;
  };

  // 任务队列（内存版 barter_tasks）；不传就默认一条「B2 上的神话鱼 → B5 上的神话鱼 ×1」
  const tasks: BarterTaskRow[] = (opts.tasks ?? [{}]).map((t, i) => {
    const rarity = t.rarity ?? "mythic";
    const fromBiome = t.from_biome_id ?? B2.biomeId;
    return {
      id: t.id ?? `t${i + 1}`,
      account_id: "acc1",
      user_id: "u1",
      from_specs: t.from_specs ?? [{ biomeId: fromBiome, rarity, fishId: null }],
      target_specs: t.target_specs ?? [{ biomeId: t.target_biome_id ?? B5.biomeId, rarity, fishId: null }],
      from_fish_id: t.from_fish_id ?? B2.fishId,
      from_fish_name: t.from_fish_name ?? B2.name,
      from_biome_id: fromBiome,
      rarity,
      quantity: t.quantity ?? 1,
      done_quantity: t.done_quantity ?? 0,
      target_biome_id: t.target_biome_id ?? B5.biomeId,
      target_fish_id: t.target_fish_id ?? null,
      target_fish_name: t.target_fish_name ?? "",
      status: t.status ?? "waiting",
      last_note: t.last_note ?? null,
      last_error: t.last_error ?? null,
      created_at: t.created_at ?? 1000 + i,
      updated_at: t.updated_at ?? 1000 + i,
    };
  });
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const history: BarterTaskRow[] = [];

  const api = {
    player: { nickname: opts.nickname ?? "我自己" },
    publicIdentity: { publicId: opts.publicId ?? "me-1" },
    async contentBootstrap() {
      return { fish: [B2, B3, B5, B6, B7].map((x) => ({ id: x.fishId, name: x.name, rarity: x.rarity, biomeId: x.biomeId })) };
    },
    async inventoryFish() {
      return {
        fish: [...inventory.entries()].map(([fishId, v]) => ({
          fishId,
          quantity: v.quantity,
          isLocked: v.isLocked,
          isMasteryLocked: v.isMasteryLocked,
        })),
      };
    },
    async mastery() {
      return {
        biomes: [
          {
            biomeId: "b_002",
            rarities: Object.entries(opts.mastery ?? {}).map(([fishId, remaining]) => ({
              fish: { id: fishId },
              remainingQuantity: remaining,
            })),
          },
        ],
      };
    },
    async barterOrders() {
      return { orders: structuredClone(orders) };
    },
    async barterFill(orderId: string, input: { requestFishId: string; offerFishId: string }) {
      if ((opts.failOrders ?? []).includes(orderId)) throw new Error("BARTER_ORDER_UNAVAILABLE");
      const order = orders.find((o) => o.id === orderId);
      const req = order?.requests.find((r) => r.fish.fishId === input.requestFishId);
      const off = order?.offers.find((o) => o.fish.fishId === input.offerFishId);
      if (!order || !req || !off || req.remainingQuantity <= 0 || off.remainingQuantity <= 0) {
        throw new Error("BARTER_ORDER_UNAVAILABLE");
      }
      fills.push({ orderId, ...input });
      if ((opts.silentOrders ?? []).includes(orderId)) return {};

      req.remainingQuantity -= 1;
      off.remainingQuantity -= 1;
      bump(req.fish.fishId, -1);
      bump(off.fish.fishId, +1);
      return { trade: { requestedFish: req.fish, offeredFish: off.fish } };
    },
  };

  const account = {
    me: { player: { nickname: opts.nickname ?? "我自己" } },
    barterNextTask: () => {
      // 与仓储一致：running → waiting → blocked，组内按创建时间（缺鱼的不堵后面的任务）
      const rank = (s: string) => (s === "running" ? 0 : s === "waiting" ? 1 : 2);
      const open = tasks
        .filter((t) => t.status === "waiting" || t.status === "running" || t.status === "blocked")
        .sort((a, b) => rank(a.status) - rank(b.status) || a.created_at - b.created_at);
      return open[0] ?? null;
    },
    barterUpdateTask: (id: string, patch: Record<string, unknown>) => {
      const row = taskById.get(id);
      if (!row) return false;
      // 与仓储的字段映射保持一致（patch 是 camelCase，行是 snake_case）
      if (patch.status !== undefined) row.status = patch.status as BarterTaskRow["status"];
      if (patch.doneQuantity !== undefined) row.done_quantity = Number(patch.doneQuantity);
      if (patch.lastNote !== undefined) row.last_note = (patch.lastNote as string | null) ?? null;
      if (patch.lastError !== undefined) row.last_error = (patch.lastError as string | null) ?? null;
      row.updated_at = Date.now();
      history.push({ ...row });
      return true;
    },
  };

  const ctx = {
    moduleId: "auto-barter",
    config: {
      checkEveryMin: 3,
      maxHops: 3,
      maxFillsPerRound: 6,
      ...(opts.config ?? {}),
    },
    state: {},
    log: {
      debug: (_t: string, m: string) => log.debug.push(m),
      info: (_t: string, m: string) => log.info.push(m),
      warn: (_t: string, m: string) => log.warn.push(m),
      error: (_t: string, m: string) => log.warn.push(m),
    },
    api,
    account,
    on: () => () => {},
    every: (ms: number, fn: () => unknown) => {
      timers.push({ ms, fn });
      return {} as NodeJS.Timeout;
    },
    schedule: (ms: number, fn: () => unknown) => {
      timers.push({ ms, fn });
      return {} as NodeJS.Timeout;
    },
    persistState: () => {},
  } as unknown as ModuleContext;

  return {
    ctx,
    log,
    fills,
    tasks,
    inventory,
    qty,
    start: async () => {
      await autoBarter.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 45_000).at(-1);
        await t?.fn();
      };
    },
    timers,
  };
}

/* ---------- 测试 ---------- */

describe("自动以物易物", () => {
  it("★ 直达一单：1 跳换到目标，任务标记完成", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 1 }],
      orders: [mkOrder("o1", [B2, 1], [B5, 1])],
    });
    const run = await w.start();
    await run();

    expect(w.fills).toEqual([{ orderId: "o1", requestFishId: B2.fishId, offerFishId: B5.fishId }]);
    expect(w.qty(B2.fishId)).toBe(0);
    expect(w.qty(B5.fishId)).toBe(1);
    expect(w.tasks[0]!.status).toBe("done");
    expect(w.tasks[0]!.done_quantity).toBe(1);
    expect(w.log.info.some((m) => m.includes("✅ 任务完成"))).toBe(true);
  });

  it("★ 多轮交换：B2 → B3 → B6 → B5（用户举的例子）", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 1 }],
      orders: [
        mkOrder("o1", [B2, 2], [B3, 2]),
        mkOrder("o2", [B3, 3], [B6, 3]),
        mkOrder("o3", [B6, 1], [B5, 1]),
      ],
    });
    const run = await w.start();
    await run();

    expect(w.fills.map((x) => x.orderId)).toEqual(["o1", "o2", "o3"]);
    expect(w.qty(B5.fishId)).toBe(1);
    expect(w.tasks[0]!.status).toBe("done");
    expect(w.log.info.some((m) => m.includes("规划到一条 3 跳的路") && m.includes("→"))).toBe(true);
    // 每一跳都写清了「交出什么、获得什么、单主、还能成交几次」
    expect(w.log.info.filter((m) => m.includes("🔄 第 ")).length).toBe(3);
    expect(w.log.info.some((m) => m.includes("单主o2"))).toBe(true);
  });

  it("★ 数量 5 条：一轮里连续走多条链，直到走满足够次数", async () => {
    const w = makeCtx({
      config: { maxFillsPerRound: 30 },
      inventory: [{ fishId: B2.fishId, quantity: 5 }],
      orders: [mkOrder("o1", [B2, 5], [B5, 5])],
      tasks: [{ quantity: 5 }],
    });
    const run = await w.start();
    await run();

    expect(w.fills).toHaveLength(5);
    expect(w.tasks[0]!.status).toBe("done");
    expect(w.tasks[0]!.done_quantity).toBe(5);
    expect(w.qty(B5.fishId)).toBe(5);
  });

  it("没有可走的路径：任务回到等待，并写清原因（不刷屏）", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 2 }],
      // 只有「奇异」的单，与神话的起点鱼跨档，换不了
      orders: [mkOrder("x", [{ ...B3, rarity: "exotic" }, 1], [{ ...B5, rarity: "exotic" }, 1])],
    });
    const run = await w.start();
    await run();

    expect(w.fills).toHaveLength(0);
    expect(w.tasks[0]!.status).toBe("waiting");
    expect(w.tasks[0]!.last_note).toContain("没有能在");
    expect(w.log.info.some((m) => m.includes("没有能在"))).toBe(true);

    // 再跑一轮：原因没变 → 降级成 debug，不再往 info 里刷同一句
    const infoBefore = w.log.info.length;
    await run();
    expect(w.log.info.length).toBe(infoBefore);
  });

  it("★ 起点鱼是专精目标鱼 → 一条都不换，任务标「缺鱼」", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 3 }],
      orders: [mkOrder("o1", [B2, 3], [B5, 3])],
      mastery: { [B2.fishId]: 12 },
    });
    const run = await w.start();
    await run();

    expect(w.fills).toHaveLength(0);
    expect(w.tasks[0]!.status).toBe("blocked");
    expect(w.tasks[0]!.last_note).toContain("专精目标鱼");
  });

  it("★ 起点鱼被锁定 → 不换", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 3, isMasteryLocked: true }],
      orders: [mkOrder("o1", [B2, 3], [B5, 3])],
    });
    const run = await w.start();
    await run();

    expect(w.fills).toHaveLength(0);
    expect(w.tasks[0]!.status).toBe("blocked");
  });

  it("★ 起点鱼已经没了 → 标「缺鱼」并说清楚", async () => {
    const w = makeCtx({
      inventory: [],
      orders: [mkOrder("o1", [B2, 3], [B5, 3])],
    });
    const run = await w.start();
    await run();

    expect(w.fills).toHaveLength(0);
    expect(w.tasks[0]!.status).toBe("blocked");
    expect(w.log.info.some((m) => m.includes("现在没有可用的鱼"))).toBe(true);
  });

  it("★ 被抢单后重新规划：第一跳那张单废了，改走另一条路", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 1 }],
      orders: [
        // 路 A（规划器会先选它）：bad → a2
        mkOrder("bad", [B2, 1], [B3, 1]),
        mkOrder("a2", [B3, 1], [B5, 1]),
        // 路 B：alt → last
        mkOrder("alt", [B2, 1], [B6, 1]),
        mkOrder("last", [B6, 1], [B5, 1]),
      ],
      failOrders: ["bad"],
    });
    const run = await w.start();
    await run();

    // 路 A 的第一跳被拒 → 拉黑它 → 重新规划走路 B（被拒的那次不算成交）
    expect(w.fills.map((x) => x.orderId)).toEqual(["alt", "last"]);
    expect(w.tasks[0]!.status).toBe("done");
    expect(w.log.warn.some((m) => m.includes("被别人换走"))).toBe(true);
  });

  it("★ 被抢单且没有别的路：半路停下、换到的鱼留在背包里", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 2 }],
      orders: [mkOrder("o1", [B2, 2], [B3, 2]), mkOrder("bad", [B3, 2], [B5, 2])],
      failOrders: ["bad"],
    });
    const run = await w.start();
    await run();

    // 第一跳成功（拿到 B3），第二跳被拒 → 停下（被拒的那次不算成交）
    expect(w.fills.map((x) => x.orderId)).toEqual(["o1"]);
    expect(w.qty(B3.fishId)).toBe(1); // 中途换到的鱼还在
    expect(w.tasks[0]!.status).toBe("waiting");
    expect(w.log.info.some((m) => m.includes("半路停下") && m.includes("新的起点鱼"))).toBe(true);
  });

  it("★ 成交结果无法确认（背包没变化）→ 停下本轮并告警，不盲目继续", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 2 }],
      orders: [mkOrder("o1", [B2, 2], [B5, 2])],
      silentOrders: ["o1"],
    });
    const run = await w.start();
    await run();

    expect(w.qty(B2.fishId)).toBe(2);
    expect(w.qty(B5.fishId)).toBe(0);
    expect(w.tasks[0]!.status).toBe("waiting");
    expect(w.tasks[0]!.last_note).toContain("无法确认");
    expect(w.log.warn.some((m) => m.includes("结果无法确认"))).toBe(true);
  });

  it("★ 每轮成交次数只当限流：已经开始的链一定会走完（不把鱼换成半路的中间产物）", async () => {
    const w = makeCtx({
      config: { maxFillsPerRound: 2 },
      inventory: [{ fishId: B2.fishId, quantity: 3 }],
      orders: [
        mkOrder("o1", [B2, 3], [B3, 3]),
        mkOrder("o2", [B3, 3], [B6, 3]),
        mkOrder("o3", [B6, 3], [B5, 3]),
      ],
    });
    const run = await w.start();
    await run();

    // 配额是 2，但这条 3 跳的链开走了就一定走完 → 3 次成交，任务完成
    expect(w.fills.map((x) => x.orderId)).toEqual(["o1", "o2", "o3"]);
    expect(w.tasks[0]!.status).toBe("done");
    expect(w.qty(B5.fishId)).toBe(1);
  });

  it("★ 队列串行：一次只推进队首任务", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 1 }],
      orders: [mkOrder("o1", [B2, 1], [B5, 1])],
      tasks: [
        { id: "first", created_at: 1 },
        { id: "second", created_at: 2 },
      ],
    });
    const run = await w.start();
    await run();

    expect(w.tasks.find((t) => t.id === "first")!.status).toBe("done");
    expect(w.tasks.find((t) => t.id === "second")!.status).toBe("waiting");
    expect(w.tasks.find((t) => t.id === "second")!.done_quantity).toBe(0);
  });

  it("★ 缺鱼的任务不会把后面能做的任务堵死（它退到队尾，下一轮再试）", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B3.fishId, quantity: 1 }],
      orders: [mkOrder("o1", [B3, 1], [B5, 1])],
      tasks: [
        // 队首这条要的鱼已经没有了 → 先被标成「缺鱼」
        { id: "stuck", created_at: 1, from_fish_id: B2.fishId, from_fish_name: B2.name, from_biome_id: B2.biomeId },
        // 后面这条可以走
        { id: "ready", created_at: 2, from_fish_id: B3.fishId, from_fish_name: B3.name, from_biome_id: B3.biomeId },
      ],
    });
    const run = await w.start();

    await run(); // 第一轮：处理队首（缺鱼）
    expect(w.tasks.find((t) => t.id === "stuck")!.status).toBe("blocked");
    expect(w.tasks.find((t) => t.id === "ready")!.status).toBe("waiting");

    await run(); // 第二轮：缺鱼那条退到队尾，轮到后面那条
    expect(w.tasks.find((t) => t.id === "ready")!.status).toBe("done");
  });

  it("起点鱼不够换满目标数量时如实说明（等钓到鱼再继续）", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 1 }],
      orders: [mkOrder("o1", [B2, 1], [B5, 1])],
      tasks: [{ quantity: 3 }],
    });
    const run = await w.start();
    await run();

    expect(w.tasks[0]!.done_quantity).toBe(1);
    expect(w.tasks[0]!.status).toBe("waiting");
    expect(w.tasks[0]!.last_note).toContain("起点侧还剩 0 条可换");
    expect(w.tasks[0]!.last_note).toContain("离目标还差 2 条");
  });

  it("★ 不响应自己发布的单", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 1 }],
      nickname: "我自己",
      orders: [
        mkOrder("mine", [B2, 1], [B5, 1], { ownerNickname: "我自己", ownerPublicId: "me-1" }),
      ],
    });
    const run = await w.start();
    await run();

    expect(w.fills).toHaveLength(0);
    expect(w.tasks[0]!.status).toBe("waiting");
  });

  it("队列空时不做事，只留一句说明", async () => {
    const w = makeCtx({ tasks: [] });
    const run = await w.start();
    await run();

    expect(w.fills).toHaveLength(0);
    expect(w.log.debug.some((m) => m.includes("队列里没有待执行的任务"))).toBe(true);
  });

  it("★ 多起点：只在起点侧列表里的地图上的鱼才动用，别的鱼不碰", async () => {
    const w = makeCtx({
      inventory: [
        { fishId: B2.fishId, quantity: 2 },
        { fishId: B7.fishId, quantity: 2 }, // B7 不在起点侧列表里 → 不能拿它去换
      ],
      orders: [mkOrder("o7", [B7, 2], [B5, 2]), mkOrder("o2", [B2, 2], [B5, 2])],
      tasks: [
        {
          from_specs: [{ biomeId: B2.biomeId, rarity: "mythic", fishId: null }],
          target_specs: [{ biomeId: B5.biomeId, rarity: "mythic", fishId: null }],
        },
      ],
    });
    const run = await w.start();
    await run();

    expect(w.fills.map((x) => x.orderId)).toEqual(["o2"]);
    expect(w.qty(B7.fishId)).toBe(2);
    expect(w.tasks[0]!.status).toBe("done");
  });

  it("★ 多起点：B2 没有路时自动改走同样在列表里的 B3", async () => {
    const w = makeCtx({
      inventory: [
        { fishId: B2.fishId, quantity: 1 },
        { fishId: B3.fishId, quantity: 1 },
      ],
      // 只有「要 B3」的单 → B2 换不出去
      orders: [mkOrder("o3", [B3, 1], [B5, 1])],
      tasks: [
        {
          from_specs: [
            { biomeId: B2.biomeId, rarity: "mythic", fishId: null },
            { biomeId: B3.biomeId, rarity: "mythic", fishId: null },
          ],
          target_specs: [{ biomeId: B5.biomeId, rarity: "mythic", fishId: null }],
        },
      ],
    });
    const run = await w.start();
    await run();

    expect(w.fills.map((x) => x.requestFishId)).toEqual([B3.fishId]);
    expect(w.tasks[0]!.status).toBe("done");
    expect(w.log.info.some((m) => m.includes("起点侧有 2 种鱼可用"))).toBe(true);
  });

  it("★ 多起点优先「跳数少」：B2 要 2 跳、B3 只要 1 跳 → 先用 B3", async () => {
    const w = makeCtx({
      inventory: [
        { fishId: B2.fishId, quantity: 1 },
        { fishId: B3.fishId, quantity: 1 },
      ],
      orders: [
        // B2 → B6 → B5（2 跳）
        mkOrder("a1", [B2, 1], [B6, 1]),
        mkOrder("a2", [B6, 1], [B5, 1]),
        // B3 → B5（1 跳）
        mkOrder("direct", [B3, 1], [B5, 1]),
      ],
      tasks: [
        {
          from_specs: [
            { biomeId: B2.biomeId, rarity: "mythic", fishId: null },
            { biomeId: B3.biomeId, rarity: "mythic", fishId: null },
          ],
          target_specs: [{ biomeId: B5.biomeId, rarity: "mythic", fishId: null }],
        },
      ],
    });
    const run = await w.start();
    await run();

    expect(w.fills.map((x) => x.orderId)).toEqual(["direct"]);
    expect(w.tasks[0]!.status).toBe("done");
  });

  it("★ 多目标：换到列表里任意一张图上的鱼都算达成", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 1 }],
      orders: [mkOrder("o7", [B2, 1], [B7, 1])],
      tasks: [
        {
          target_specs: [
            { biomeId: B5.biomeId, rarity: "mythic", fishId: null },
            { biomeId: B7.biomeId, rarity: "mythic", fishId: null },
          ],
        },
      ],
    });
    const run = await w.start();
    await run();

    expect(w.fills.map((x) => x.orderId)).toEqual(["o7"]);
    expect(w.tasks[0]!.status).toBe("done");
    expect(w.tasks[0]!.done_quantity).toBe(1);
  });

  it("起点侧列表里的地图都没有鱼时标「缺鱼」", async () => {
    const w = makeCtx({
      inventory: [{ fishId: B2.fishId, quantity: 1 }],
      orders: [mkOrder("o1", [B2, 1], [B5, 1])],
      tasks: [
        { from_specs: [{ biomeId: B7.biomeId, rarity: "mythic", fishId: null }] },
      ],
    });
    const run = await w.start();
    await run();

    expect(w.fills).toHaveLength(0);
    expect(w.tasks[0]!.status).toBe("blocked");
    expect(w.tasks[0]!.last_note).toContain("B7");
  });

  it("定时器按配置注册：检查间隔 / 启动检查 / 上限写进启动日志", async () => {
    const w = makeCtx({ config: { checkEveryMin: 7, maxHops: 4, maxFillsPerRound: 9 } });
    await w.start();

    expect(w.timers.some((t) => t.ms === 7 * 60_000)).toBe(true);
    expect(w.timers.some((t) => t.ms === 45_000)).toBe(true);
    expect(w.log.info.some((m) => m.includes("每 7 分钟检查一次") && m.includes("最多 4 跳") && m.includes("最多成交 9 次"))).toBe(true);
  });

  it("接口整体失败时只告警，不把账号循环带走", async () => {
    const w = makeCtx({ inventory: [{ fishId: B2.fishId, quantity: 1 }] });
    (w.ctx.api as { inventoryFish: () => Promise<unknown> }).inventoryFish = async () => {
      throw new Error("网络不可达");
    };
    const run = await w.start();
    await run();

    expect(w.log.warn.some((m) => m.includes("网络不可达"))).toBe(true);
    expect(w.fills).toHaveLength(0);
  });
});
