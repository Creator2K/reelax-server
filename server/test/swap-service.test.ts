// 交换助手：扫描 / 执行（全栈集成，游戏接口用假的顶替）
//
// 重点盯「扫描拿到什么」与「执行怎么停」：
//   · 扫描要翻页拉全（canFulfill=false），并把专精目标 + 背包 -> 图 -> 可行链算出来；
//   · 执行每一步都重新确认要交出的鱼还在背包里，被抢单 / 缺鱼要停在那一步并如实报出；
//   · 越权一律 404；扫描与执行都写审计。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";

let app: FullApp;

beforeAll(async () => {
  app = await buildFullApp({ limits: { register: { windowMs: 60_000, max: 100 } } });
});
afterAll(async () => {
  await app.close();
});

const F = {
  b2: { fishId: "f-b2", name: "雾语灯笼鱼", biomeId: "b_002", rarity: "mythic" },
  b3: { fishId: "f-b3", name: "镜潮银鲷", biomeId: "b_003", rarity: "mythic" },
  b6: { fishId: "f-b6", name: "霞栖彩鲤", biomeId: "b_006", rarity: "mythic" },
  b5: { fishId: "f-b5", name: "星根盲鳗", biomeId: "b_005", rarity: "mythic" },
};

/** 一张交换单：单主想用 offers 换 requests */
function order(id: string, give: typeof F.b2, get: typeof F.b2, qty = 1) {
  return {
    id,
    rarity: "mythic",
    ownerNickname: `单主${id}`,
    status: "active",
    requests: [{ fish: give, initialQuantity: qty, remainingQuantity: qty }],
    offers: [{ fish: get, initialQuantity: qty, remainingQuantity: qty }],
  };
}

type Opts = {
  inventory?: { fishId: string; quantity: number }[];
  mastery?: unknown;
  /** 分页返回：每项是一页的 orders（最后一页不给游标） */
  pages?: unknown[][];
  /** 这些单响应时抛错（模拟被抢走） */
  failOrders?: string[];
};

let seq = 0;
function seedAccountWithGame(opts: Opts = {}) {
  seq += 1;
  const user = app.seedApprovedUser(`swap${seq}@example.com`);
  const accountId = app.seedAccount(user.id, `交换${seq}`);
  const rt = app.registry.require(accountId);

  const inventory = new Map((opts.inventory ?? [{ fishId: F.b2.fishId, quantity: 2 }]).map((i) => [i.fishId, i.quantity]));
  const fills: { orderId: string; requestFishId: string; offerFishId: string }[] = [];
  const orderPages = opts.pages ?? [[order("o1", F.b2, F.b5)]];
  const orderCalls: (string | undefined)[] = [];

  const client = rt.client as unknown as Record<string, unknown>;
  client.barterOrders = async (q: { cursor?: string } = {}) => {
    orderCalls.push(q.cursor);
    const idx = q.cursor ? Number(String(q.cursor).replace("c", "")) : 0;
    const page = orderPages[idx] ?? [];
    const next = idx + 1 < orderPages.length ? `c${idx + 1}` : undefined;
    return { orders: page, ...(next ? { nextCursor: next } : {}) };
  };
  client.mastery = async () => {
    if (opts.mastery === "throw") throw new Error("网络不可达");
    return (
      opts.mastery ?? {
        biomes: [
          {
            biomeId: "b_005",
            biomeName: "星根洞窟",
            isUnlocked: true,
            rarities: [
              { fish: { id: F.b5.fishId, name: F.b5.name }, rarity: "mythic", remainingQuantity: 3, availableQuantity: 0 },
            ],
          },
        ]
      }
    );
  };
  client.inventoryFish = async () => ({
    fish: [...inventory.entries()].map(([fishId, quantity]) => ({ fishId, quantity })),
  });
  client.barterFill = async (orderId: string, body: { requestFishId: string; offerFishId: string }) => {
    if ((opts.failOrders ?? []).includes(orderId)) throw new Error("BARTER_ORDER_UNAVAILABLE");
    const have = inventory.get(body.requestFishId) ?? 0;
    if (have < 1) throw new Error("INVENTORY_QUANTITY_INSUFFICIENT");
    inventory.set(body.requestFishId, have - 1);
    inventory.set(body.offerFishId, (inventory.get(body.offerFishId) ?? 0) + 1);
    fills.push({ orderId, ...body });
    return { trade: { requestedFish: { fishId: body.requestFishId }, offeredFish: { fishId: body.offerFishId } } };
  };

  return { accountId, jar: user.jar, rt, inventory, fills, orderCalls };
}

type State = {
  status: string;
  error: string | null;
  stale: boolean;
  progress: { phase: string; pages: number; orders: number };
  result: {
    stats: { orders: number; edges: number; targets: number; paths: number; pages: number; truncated: boolean };
    targets: { fishId: string; remaining: number; pathCount: number; biomeCode: string | null }[];
    paths: {
      key: string;
      targetFishId: string;
      length: number;
      hops: {
        orderId: string;
        owner: string | null;
        capacity: number;
        give: { fishId: string; name: string; biomeCode: string | null };
        get: { fishId: string; name: string; biomeCode: string | null; rarityLabel: string };
      }[];
    }[];
  } | null;
};

async function scanAndWait(accountId: string, jar: ReturnType<FullApp["seedApprovedUser"]>["jar"]): Promise<State> {
  const started = await app.post<State>(`/api/accounts/${accountId}/swap/scan`, undefined, jar);
  expect(started.status).toBe(200);
  const deadline = Date.now() + 4000;
  let last: State = started.body;
  while (Date.now() < deadline) {
    const r = await app.get<State>(`/api/accounts/${accountId}/swap`, jar);
    last = r.body;
    if (last.status !== "scanning") return last;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`扫描没有在预期时间内结束：${JSON.stringify(last)}`);
}

describe("交换助手", () => {
  it("★ 扫描：翻页拉全交换单，算出专精目标与可行链", async () => {
    const { accountId, jar, orderCalls } = seedAccountWithGame({
      // 两页：第一页给出 B2→B3，第二页给出 B3→B5（链要跨页才能串起来）
      pages: [[order("o1", F.b2, F.b3, 2)], [order("o2", F.b3, F.b5, 1)]],
      inventory: [{ fishId: F.b2.fishId, quantity: 2 }],
    });

    const state = await scanAndWait(accountId, jar);
    expect(state.status).toBe("ready");
    expect(orderCalls).toEqual([undefined, "c1"]); // 真的翻了页
    expect(state.result!.stats).toMatchObject({ orders: 2, edges: 2, targets: 1, paths: 1, pages: 2, truncated: false });

    const target = state.result!.targets[0]!;
    expect(target).toMatchObject({ fishId: F.b5.fishId, remaining: 3, pathCount: 1, biomeCode: "B5" });

    const path = state.result!.paths[0]!;
    expect(path.length).toBe(2);
    expect(path.hops.map((h) => [h.give.fishId, h.get.fishId])).toEqual([
      [F.b2.fishId, F.b3.fishId],
      [F.b3.fishId, F.b5.fishId],
    ]);
    // 面板要显示的东西：地图编号、鱼名、单主、容量
    expect(path.hops[0]).toMatchObject({
      orderId: "o1",
      owner: "单主o1",
      capacity: 2,
      give: { name: "雾语灯笼鱼", biomeCode: "B2" },
      get: { name: "镜潮银鲷", biomeCode: "B3", rarityLabel: "神话" },
    });
  });

  it("★ 执行一条链：逐步真的换出去，写完返回每一步结果", async () => {
    const { accountId, jar, fills, inventory } = seedAccountWithGame({
      pages: [[order("o1", F.b2, F.b3, 2)], [order("o2", F.b3, F.b5, 1)]],
      inventory: [{ fishId: F.b2.fishId, quantity: 1 }],
    });
    const state = await scanAndWait(accountId, jar);
    const hops = state.result!.paths[0]!.hops.map((h) => ({
      orderId: h.orderId,
      requestFishId: h.give.fishId,
      offerFishId: h.get.fishId,
    }));

    const r = await app.post<{ ok: boolean; done: number; steps: { ok: boolean }[] }>(
      `/api/accounts/${accountId}/swap/execute`,
      { hops },
      jar,
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.done).toBe(2);
    expect(r.body.steps.map((s) => s.ok)).toEqual([true, true]);
    expect(fills.map((f) => f.orderId)).toEqual(["o1", "o2"]);
    expect(inventory.get(F.b5.fishId)).toBe(1);
    expect(inventory.get(F.b2.fishId)).toBe(0);

    // 执行过之后数据算旧了：面板要提示重新扫描
    const after = await app.get<State>(`/api/accounts/${accountId}/swap`, jar);
    expect(after.body.stale).toBe(true);
  });

  it("★ 缺鱼：第一步就停，并把原因说清楚", async () => {
    const { accountId, jar, fills } = seedAccountWithGame({
      inventory: [{ fishId: F.b3.fishId, quantity: 5 }], // 手上没有 B2
    });
    const hops = [{ orderId: "o1", requestFishId: F.b2.fishId, offerFishId: F.b5.fishId }];

    const r = await app.post<{ ok: boolean; done: number; error?: string }>(
      `/api/accounts/${accountId}/swap/execute`,
      { hops },
      jar,
    );
    expect(r.body.ok).toBe(false);
    expect(r.body.done).toBe(0);
    expect(r.body.error).toContain("不在背包里");
    expect(fills).toHaveLength(0);
  });

  it("★ 中途被抢单：前面几跳算数，停在这一跳并如实报出", async () => {
    const { accountId, jar, fills, inventory } = seedAccountWithGame({
      pages: [[order("o1", F.b2, F.b3, 2)], [order("o2", F.b3, F.b5, 1)]],
      inventory: [{ fishId: F.b2.fishId, quantity: 1 }],
      failOrders: ["o2"],
    });
    const hops = [
      { orderId: "o1", requestFishId: F.b2.fishId, offerFishId: F.b3.fishId },
      { orderId: "o2", requestFishId: F.b3.fishId, offerFishId: F.b5.fishId },
    ];

    const r = await app.post<{ ok: boolean; done: number; error?: string; steps: { ok: boolean }[] }>(
      `/api/accounts/${accountId}/swap/execute`,
      { hops },
      jar,
    );
    expect(r.body.ok).toBe(false);
    expect(r.body.done).toBe(1);
    expect(r.body.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(r.body.error).toContain("被别人换走");
    // 第一跳换到的 B3 留着（半路停下不等于没换）
    expect(inventory.get(F.b3.fishId)).toBe(1);
    expect(fills.map((f) => f.orderId)).toEqual(["o1"]);
  });

  it("没有专精目标 / 没有可走的链时也能正常返回（不算错误）", async () => {
    const { accountId, jar } = seedAccountWithGame({
      mastery: { biomes: [{ biomeId: "b_005", isUnlocked: true, rarities: [] }] },
    });
    const state = await scanAndWait(accountId, jar);
    expect(state.status).toBe("ready");
    expect(state.result!.stats).toMatchObject({ targets: 0, paths: 0 });
    expect(state.result!.paths).toEqual([]);
  });

  it("★ 扫描前是 idle；扫描失败时状态为 error 并带上原因", async () => {
    const { accountId, jar } = seedAccountWithGame({ mastery: "throw" });

    const idle = await app.get<State>(`/api/accounts/${accountId}/swap`, jar);
    expect(idle.body.status).toBe("idle");
    expect(idle.body.result).toBeNull();

    const state = await scanAndWait(accountId, jar);
    expect(state.status).toBe("error");
    expect(state.error).toContain("读不到专精进度或背包");
  });

  it("★ 越权：别人的账号一律 404", async () => {
    const mine = seedAccountWithGame();
    seq += 1;
    const other = app.seedApprovedUser(`swap-other${seq}@example.com`);

    expect((await app.get(`/api/accounts/${mine.accountId}/swap`, other.jar)).status).toBe(404);
    expect((await app.post(`/api/accounts/${mine.accountId}/swap/scan`, undefined, other.jar)).status).toBe(404);
    expect(
      (
        await app.post(
          `/api/accounts/${mine.accountId}/swap/execute`,
          { hops: [{ orderId: "o1", requestFishId: F.b2.fishId, offerFishId: F.b5.fishId }] },
          other.jar,
        )
      ).status,
    ).toBe(404);
  });

  it("★ 审计：扫描与执行各留一条", async () => {
    const { accountId, jar, rt } = seedAccountWithGame({ inventory: [{ fishId: F.b2.fishId, quantity: 1 }] });
    await scanAndWait(accountId, jar);
    await app.post(
      `/api/accounts/${accountId}/swap/execute`,
      { hops: [{ orderId: "o1", requestFishId: F.b2.fishId, offerFishId: F.b5.fishId }] },
      jar,
    );

    const scanRows = app.repos.audit.list({ action: "account.swap.scan", userId: rt.userId });
    const execRows = app.repos.audit.list({ action: "account.swap.execute", userId: rt.userId });
    expect(scanRows).toHaveLength(1);
    expect(execRows).toHaveLength(1);

    const { describeAudit } = await import("../src/lib/audit-text.ts");
    const text = describeAudit(execRows[0]!, { accountLabel: () => "交换1", userName: () => "tester" });
    expect(text).toContain("执行一条交换链");
    expect(text).toContain("1 跳");
  });

  it("执行参数校验：空 hops / 超过上限被拒", async () => {
    const { accountId, jar } = seedAccountWithGame();
    expect((await app.post(`/api/accounts/${accountId}/swap/execute`, { hops: [] }, jar)).status).toBe(400);
    const tooMany = Array.from({ length: 9 }, (_v, i) => ({
      orderId: `o${i}`,
      requestFishId: F.b2.fishId,
      offerFishId: F.b5.fishId,
    }));
    expect((await app.post(`/api/accounts/${accountId}/swap/execute`, { hops: tooMany }, jar)).status).toBe(400);
  });
});
