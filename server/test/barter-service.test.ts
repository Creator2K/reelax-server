// 以物易物交换任务：路由 + 服务层校验（全栈集成，游戏接口用假的顶替）
//
// 这里盯的是「能不能建出一条注定换不到的任务」：
//   · 起点鱼不在背包 / 稀有度不够 / 数量超过库存 / 是专精目标鱼 → 直接拒绝
//   · 目标地图上没有同稀有度的鱼 / 目标鱼不在那张图 / 目标和起点是同一种 → 拒绝
//   · 队列上限、取消幂等、越权 404、审计留痕
// 面板与队列本身是数据库 + 服务组装，所以走真实路由最划算。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import type { AccountRuntime } from "../src/game/account-runtime.ts";

let app: FullApp;

beforeAll(async () => {
  app = await buildFullApp({ limits: { register: { windowMs: 60_000, max: 100 } } });
});
afterAll(async () => {
  await app.close();
});

const CONTENT = {
  fish: [
    { id: "f-myth-b2", name: "雾语灯笼鱼", rarity: "mythic", biomeId: "b_002" },
    { id: "f-myth-b3", name: "镜潮银鲷", rarity: "mythic", biomeId: "b_003" },
    { id: "f-myth-b5", name: "星根盲鳗", rarity: "mythic", biomeId: "b_005" },
    { id: "f-exo-b2", name: "雾语幻影鳅", rarity: "exotic", biomeId: "b_002" },
    { id: "f-common-b2", name: "雾语小鲫", rarity: "common", biomeId: "b_002" },
  ],
};

/** 一批账号：每个用例一个，避免互相影响（内容表缓存挂在运行时上） */
let seq = 0;
function seedAccountWithGame(opts: {
  inventory?: { fishId: string; quantity: number; isLocked?: boolean; isMasteryLocked?: boolean }[];
  mastery?: Record<string, number>;
  orders?: unknown[];
  contentFails?: boolean;
} = {}): { accountId: string; rt: AccountRuntime; jar: ReturnType<FullApp["seedApprovedUser"]>["jar"] } {
  seq += 1;
  const user = app.seedApprovedUser(`barter${seq}@example.com`);
  const accountId = app.seedAccount(user.id, `以物易物${seq}`);
  const rt = app.registry.require(accountId);

  const inventory = opts.inventory ?? [
    { fishId: "f-myth-b2", quantity: 3 },
    { fishId: "f-exo-b2", quantity: 1 },
    { fishId: "f-common-b2", quantity: 9 },
  ];
  const client = rt.client as unknown as Record<string, unknown>;
  client.inventoryFish = async () => ({
    fish: inventory.map((i) => ({
      fishId: i.fishId,
      quantity: i.quantity,
      isLocked: i.isLocked,
      isMasteryLocked: i.isMasteryLocked,
    })),
  });
  client.contentBootstrap = async () => {
    if (opts.contentFails) throw new Error("网络不可达");
    return CONTENT;
  };
  client.mastery = async () => ({
    biomes: [
      {
        biomeId: "b_002",
        rarities: Object.entries(opts.mastery ?? {}).map(([fishId, remaining]) => ({
          fish: { id: fishId },
          remainingQuantity: remaining,
        })),
      },
    ],
  });
  client.barterOrders = async () => ({ orders: opts.orders ?? [] });

  return { accountId, rt, jar: user.jar };
}

describe("交换任务路由", () => {
  it("★ 建一条任务 → 面板能读到它（含起点候选与目标鱼表）", async () => {
    const { accountId, jar } = seedAccountWithGame();

    const created = await app.post<{
      id: string;
      fromFishName: string;
      targetFishName: string | null;
      status: string;
      quantity: number;
      rarityLabel: string;
    }>(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 2, targetBiomeId: "b_005", targetFishId: "f-myth-b5" },
      jar,
    );

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      fromFishName: "雾语灯笼鱼",
      targetFishName: "星根盲鳗",
      targetBiomeName: "星根洞窟",
      status: "waiting",
      statusText: "等待中",
      quantity: 2,
      doneQuantity: 0,
      rarityLabel: "神话",
    });

    const panel = await app.get<{
      tasks: { id: string }[];
      start: { fishId: string; quantity: number; rarityLabel: string }[];
      fish: { id: string; biomeId: string }[];
      module: { enabled: boolean; running: boolean };
      limits: { maxOpenTasks: number; maxQuantity: number };
      rarityHint: string;
      head: { reachable: boolean; hops: unknown[]; reason: string | null } | null;
    }>(`/api/accounts/${accountId}/barter`, jar);

    expect(panel.status).toBe(200);
    expect(panel.body.tasks.map((t) => t.id)).toEqual([created.body.id]);
    // 起点候选：只留最高三档（神话 / 奇异），普通鱼不进列表
    expect(panel.body.start.map((s) => s.fishId)).toEqual(["f-myth-b2", "f-exo-b2"]);
    expect(panel.body.start[0]).toMatchObject({ name: "雾语灯笼鱼", rarityLabel: "神话", quantity: 3 });
    expect(panel.body.fish).toHaveLength(4);
    expect(panel.body.module).toEqual({ enabled: false, running: false });
    expect(panel.body.limits).toMatchObject({ maxOpenTasks: 5, maxQuantity: 99 });
    expect(panel.body.rarityHint).toContain("三档稀有度");
    // 没有能走的单 → 预览说走不通
    expect(panel.body.head).toMatchObject({ reachable: false });
  });

  it("★ 有现成单时面板给出路径预览", async () => {
    const { accountId, jar } = seedAccountWithGame({
      orders: [
        {
          id: "o1",
          rarity: "mythic",
          ownerNickname: "艾拉",
          status: "active",
          requests: [{ fish: { fishId: "f-myth-b2", name: "雾语灯笼鱼", biomeId: "b_002", rarity: "mythic" }, remainingQuantity: 2, initialQuantity: 2 }],
          offers: [{ fish: { fishId: "f-myth-b5", name: "星根盲鳗", biomeId: "b_005", rarity: "mythic" }, remainingQuantity: 2, initialQuantity: 2 }],
        },
      ],
    });
    await app.post(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_005", targetFishId: "f-myth-b5" },
      jar,
    );

    const panel = await app.get<{ head: { reachable: boolean; hops: { owner: string; getName: string; remaining: number }[] } }>(
      `/api/accounts/${accountId}/barter`,
      jar,
    );
    expect(panel.body.head.reachable).toBe(true);
    expect(panel.body.head.hops[0]).toMatchObject({ owner: "艾拉", getName: "星根盲鳗", remaining: 2 });
  });

  it("目标不填具体鱼种 = 该地图任意同稀有度鱼", async () => {
    const { accountId, jar } = seedAccountWithGame();
    const created = await app.post<{ targetFishId: string | null; targetFishName: string | null }>(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_005" },
      jar,
    );
    expect(created.status).toBe(201);
    expect(created.body.targetFishId).toBeNull();
    expect(created.body.targetFishName).toBeNull();
  });

  it("★ 校验：起点鱼不在背包 / 稀有度不够 / 数量超标 / 是专精目标鱼", async () => {
    const a = seedAccountWithGame();
    const notOwned = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromFishId: "f-myth-b5", quantity: 1, targetBiomeId: "b_005" },
      a.jar,
    );
    expect(notOwned.status).toBe(400);
    expect(notOwned.body.error.code).toBe("BARTER_START_FISH_UNUSABLE");

    const commonFish = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromFishId: "f-common-b2", quantity: 1, targetBiomeId: "b_005" },
      a.jar,
    );
    expect(commonFish.status).toBe(400);
    expect(commonFish.body.error.code).toBe("BARTER_START_FISH_UNUSABLE");

    const tooMany = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 4, targetBiomeId: "b_005" },
      a.jar,
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe("BARTER_NOT_ENOUGH_FISH");
    expect(tooMany.body.error.message).toContain("只有 3 条");

    // 专精目标鱼：还缺若干条 → 不能拿去换
    const b = seedAccountWithGame({ mastery: { "f-myth-b2": 8 } });
    const masteryFish = await app.post(
      `/api/accounts/${b.accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_005" },
      b.jar,
    );
    expect(masteryFish.status).toBe(400);
    expect(masteryFish.body.error.code).toBe("BARTER_START_FISH_UNUSABLE");

    // 被锁定的鱼同理
    const c = seedAccountWithGame({ inventory: [{ fishId: "f-myth-b2", quantity: 2, isMasteryLocked: true }] });
    const locked = await app.post(
      `/api/accounts/${c.accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_005" },
      c.jar,
    );
    expect(locked.status).toBe(400);
    expect(locked.body.error.code).toBe("BARTER_START_FISH_UNUSABLE");
  });

  it("★ 校验：目标地图 / 目标鱼种", async () => {
    const a = seedAccountWithGame();
    const unknownBiome = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_999" },
      a.jar,
    );
    expect(unknownBiome.status).toBe(400);
    expect(unknownBiome.body.error.code).toBe("BARTER_TARGET_BIOME_UNKNOWN");

    // b_006 在鱼表里没有神话鱼
    const emptyBiome = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_006" },
      a.jar,
    );
    expect(emptyBiome.status).toBe(400);
    expect(emptyBiome.body.error.code).toBe("BARTER_TARGET_BIOME_EMPTY");

    // 目标鱼神话，但不在所选地图上
    const wrongFish = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_003", targetFishId: "f-myth-b5" },
      a.jar,
    );
    expect(wrongFish.status).toBe(400);
    expect(wrongFish.body.error.code).toBe("BARTER_TARGET_FISH_INVALID");

    // 目标和起点是同一种鱼
    const sameFish = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_002", targetFishId: "f-myth-b2" },
      a.jar,
    );
    expect(sameFish.status).toBe(400);
    expect(sameFish.body.error.code).toBe("BARTER_TARGET_SAME_AS_START");
  });

  it("★ 队列上限：未完成的任务最多 5 条", async () => {
    const { accountId, jar } = seedAccountWithGame();
    for (let i = 0; i < 5; i++) {
      const r = await app.post(
        `/api/accounts/${accountId}/barter/tasks`,
        { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_005" },
        jar,
      );
      expect(r.status).toBe(201);
    }
    const overflow = await app.post(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_005" },
      jar,
    );
    expect(overflow.status).toBe(400);
    expect(overflow.body.error.code).toBe("BARTER_QUEUE_FULL");
  });

  it("★ 取消任务：幂等、未知 id 404，并且面板里留下已取消的记录", async () => {
    const { accountId, jar } = seedAccountWithGame();
    const created = await app.post<{ id: string }>(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_005" },
      jar,
    );

    const first = await app.del<{ ok: boolean; status: string; from: string; to: string }>(
      `/api/accounts/${accountId}/barter/tasks/${created.body.id}`,
      jar,
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, status: "cancelled", from: "雾语灯笼鱼", to: "星根洞窟" });

    const again = await app.del<{ ok: boolean; status: string }>(
      `/api/accounts/${accountId}/barter/tasks/${created.body.id}`,
      jar,
    );
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("cancelled");

    const missing = await app.del(`/api/accounts/${accountId}/barter/tasks/nope`, jar);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("BARTER_TASK_NOT_FOUND");

    const panel = await app.get<{ tasks: { status: string }[] }>(`/api/accounts/${accountId}/barter`, jar);
    expect(panel.body.tasks[0]!.status).toBe("cancelled");
  });

  it("★ 越权：别人的账号一律 404（不泄漏资源是否存在）", async () => {
    const mine = seedAccountWithGame();
    seq += 1;
    const other = app.seedApprovedUser(`barter-other${seq}@example.com`);

    const read = await app.get(`/api/accounts/${mine.accountId}/barter`, other.jar);
    expect(read.status).toBe(404);

    const write = await app.post(
      `/api/accounts/${mine.accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 1, targetBiomeId: "b_005" },
      other.jar,
    );
    expect(write.status).toBe(404);
  });

  it("★ 审计：新增与取消各留一条，描述是人话", async () => {
    const { accountId, jar, rt } = seedAccountWithGame();
    const created = await app.post<{ id: string }>(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromFishId: "f-myth-b2", quantity: 2, targetBiomeId: "b_005" },
      jar,
    );
    await app.del(`/api/accounts/${accountId}/barter/tasks/${created.body.id}`, jar);

    const rows = app.repos.audit.list({ action: "account.barter.task", userId: rt.userId });
    expect(rows).toHaveLength(2);
    const { describeAudit } = await import("../src/lib/audit-text.ts");
    const resolvers = { accountLabel: () => "以物易物1", userName: () => "tester" };
    // 最近一条是取消，另一条是新增 —— 两条都要说清「从什么换成什么」
    const texts = rows.map((r) => describeAudit(r, resolvers));
    expect(texts.some((t) => t.includes("新增以物易物任务") && t.includes("雾语灯笼鱼"))).toBe(true);
    expect(texts.some((t) => t.includes("取消") && t.includes("雾语灯笼鱼") && t.includes("星根洞窟"))).toBe(true);
  });

  it("★ 功能开关状态会跟着面板一起下发（没开就说没开）", async () => {
    const { accountId, jar } = seedAccountWithGame();
    const off = await app.get<{ module: { enabled: boolean; running: boolean } }>(
      `/api/accounts/${accountId}/barter`,
      jar,
    );
    expect(off.body.module).toEqual({ enabled: false, running: false });

    const on = await app.patch(`/api/accounts/${accountId}/modules/auto-barter`, { enabled: true }, jar);
    expect(on.status).toBe(200);

    const live = await app.get<{ module: { enabled: boolean; running: boolean } }>(
      `/api/accounts/${accountId}/barter`,
      jar,
    );
    // 账号没启动 → 只记下了开关，不会实例化模块（面板据此提示"队列暂时不会被执行"）
    expect(live.body.module).toEqual({ enabled: true, running: false });
  });

  it("读不到背包 / 鱼表时给出明确错误，而不是空面板", async () => {
    const { accountId, jar } = seedAccountWithGame({ contentFails: true });
    const r = await app.get(`/api/accounts/${accountId}/barter`, jar);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("GAME_UNREACHABLE");
  });

  it("账号不存在 → 404", async () => {
    seq += 1;
    const user = app.seedApprovedUser(`barter-miss${seq}@example.com`);
    const r = await app.get(`/api/accounts/does-not-exist/barter`, user.jar);
    expect(r.status).toBe(404);
  });
});
