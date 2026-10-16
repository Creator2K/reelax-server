// 以物易物交换任务：路由 + 服务层校验（全栈集成，游戏接口用假的顶替）
//
// 任务的两侧都是「地图 + 稀有度」的列表，所以这里盯的是：
//   · 能不能建出一条注定换不到的任务（地图不存在、档位不对、目标图上没这一档的鱼、
//     目标与起点完全重合、起点侧一条鱼都拿不出来）→ 应当直接拒绝
//   · 多起点 / 多目标 / 不同档位混搭能正常存下来，并在面板与预览里正确呈现
//   · 队列上限、取消幂等、越权 404、审计留痕
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
    { id: "f-myth-b7", name: "云汐银刀", rarity: "mythic", biomeId: "b_007" },
    { id: "f-exo-b2", name: "雾语幻影鳅", rarity: "exotic", biomeId: "b_002" },
    { id: "f-arc-b2", name: "雾语幽光鳗", rarity: "arcane", biomeId: "b_002" },
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
    { fishId: "f-myth-b3", quantity: 2 },
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

const spec = (biomeId: string, rarity = "mythic") => ({ biomeId, rarity });

describe("交换任务路由", () => {
  it("★ 建一条多起点 × 多目标的任务 → 面板能读到它（含 B 编号与两侧候选）", async () => {
    const { accountId, jar } = seedAccountWithGame();

    const created = await app.post<{
      id: string;
      fromText: string;
      targetText: string;
      status: string;
      statusText: string;
      quantity: number;
      doneQuantity: number;
      fromSpecs: { biomeCode: string; biomeName: string; rarityLabel: string }[];
      targetSpecs: { biomeCode: string }[];
    }>(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002"), spec("b_003")], targetSpecs: [spec("b_005"), spec("b_007")], quantity: 2 },
      jar,
    );

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      fromText: "B2 / B3的任意神话鱼",
      targetText: "B5 / B7的任意神话鱼",
      status: "waiting",
      statusText: "等待中",
      quantity: 2,
      doneQuantity: 0,
    });
    expect(created.body.fromSpecs[0]).toMatchObject({ biomeCode: "B2", biomeName: "雾语湿地", rarityLabel: "神话" });
    expect(created.body.targetSpecs.map((s) => s.biomeCode)).toEqual(["B5", "B7"]);

    const panel = await app.get<{
      tasks: { id: string }[];
      startOptions: { biomeCode: string; rarity: string; quantity: number }[];
      targetOptions: { biomeCode: string; rarity: string }[];
      limits: { maxOpenTasks: number; maxQuantity: number; maxSpecs: number; rarities: { value: string; label: string }[] };
      module: { enabled: boolean; running: boolean };
      head: { reachable: boolean; reason: string | null } | null;
    }>(`/api/accounts/${accountId}/barter`, jar);

    expect(panel.status).toBe(200);
    expect(panel.body.tasks.map((t) => t.id)).toEqual([created.body.id]);
    // 起点候选：B2 的神话 3 条 + 奇异 1 条（普通鱼与不在鱼表里的都不算）
    expect(panel.body.startOptions.map((o) => `${o.biomeCode}:${o.rarity}=${o.quantity}`)).toEqual([
      "B2:mythic=3",
      "B2:exotic=1",
      "B3:mythic=2",
    ]);
    // 目标候选：游戏里这些图上有鱼（含 B2 的三档，但 B6 没有）
    expect(panel.body.targetOptions.some((o) => o.biomeCode === "B5" && o.rarity === "mythic")).toBe(true);
    expect(panel.body.limits).toMatchObject({ maxOpenTasks: 5, maxQuantity: 99, maxSpecs: 5 });
    expect(panel.body.limits.rarities[0]).toEqual({ value: "mythic", label: "神话" });
    expect(panel.body.module).toEqual({ enabled: false, running: false });
    expect(panel.body.head).toMatchObject({ reachable: false });
  });

  it("★ 一条任务里可以混不同稀有度（各自走各自的链）", async () => {
    const { accountId, jar } = seedAccountWithGame();
    const created = await app.post<{ fromText: string; status: number }>(
      `/api/accounts/${accountId}/barter/tasks`,
      {
        fromSpecs: [spec("b_002", "mythic"), spec("b_002", "exotic")],
        targetSpecs: [spec("b_005", "mythic"), spec("b_007", "mythic")],
        quantity: 1,
      },
      jar,
    );
    expect(created.status).toBe(201);
    expect(created.body.fromText).toBe("B2 / B2的任意同稀有度鱼");
  });

  it("★ 有现成单时面板给出路径预览（带起点鱼与 B 编号）", async () => {
    const { accountId, jar } = seedAccountWithGame({
      orders: [
        {
          id: "o1",
          rarity: "mythic",
          ownerNickname: "艾拉",
          status: "active",
          requests: [
            {
              fish: { fishId: "f-myth-b2", name: "雾语灯笼鱼", biomeId: "b_002", rarity: "mythic" },
              remainingQuantity: 2,
              initialQuantity: 2,
            },
          ],
          offers: [
            {
              fish: { fishId: "f-myth-b5", name: "星根盲鳗", biomeId: "b_005", rarity: "mythic" },
              remainingQuantity: 2,
              initialQuantity: 2,
            },
          ],
        },
      ],
    });
    await app.post(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002")], targetSpecs: [spec("b_005")], quantity: 1 },
      jar,
    );

    const panel = await app.get<{
      head: {
        taskId: string;
        startFishName: string | null;
        reachable: boolean;
        hops: { owner: string; getName: string; getBiomeCode: string | null; remaining: number }[];
      };
    }>(`/api/accounts/${accountId}/barter`, jar);
    expect(panel.body.head.reachable).toBe(true);
    expect(panel.body.head.startFishName).toBe("雾语灯笼鱼");
    expect(panel.body.head.hops[0]).toMatchObject({
      owner: "艾拉",
      getName: "星根盲鳗",
      getBiomeCode: "B5",
      remaining: 2,
    });
  });

  it("★ 校验：起点侧与目标侧的规格", async () => {
    const a = seedAccountWithGame();
    // 空列表与超过 5 项在路由的参数校验就被挡住了（服务层还有一道兜底）
    const noSpec = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromSpecs: [], targetSpecs: [spec("b_005")], quantity: 1 },
      a.jar,
    );
    expect(noSpec.status).toBe(400);
    expect(noSpec.body.error.code).toBe("VALIDATION_ERROR");

    const tooMany = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      {
        fromSpecs: ["b_001", "b_002", "b_003", "b_004", "b_005", "b_006"].map((b) => spec(b)),
        targetSpecs: [spec("b_005")],
        quantity: 1,
      },
      a.jar,
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

    const unknownBiome = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromSpecs: [spec("b_999")], targetSpecs: [spec("b_005")], quantity: 1 },
      a.jar,
    );
    expect(unknownBiome.status).toBe(400);
    expect(unknownBiome.body.error.code).toBe("BARTER_BIOME_UNKNOWN");

    const badRarity = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002", "epic")], targetSpecs: [spec("b_005")], quantity: 1 },
      a.jar,
    );
    expect(badRarity.status).toBe(400);
    expect(badRarity.body.error.code).toBe("BARTER_RARITY_NOT_ALLOWED");

    // b_006 在鱼表里没有任何鱼
    const emptyTarget = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002")], targetSpecs: [spec("b_006")], quantity: 1 },
      a.jar,
    );
    expect(emptyTarget.status).toBe(400);
    expect(emptyTarget.body.error.code).toBe("BARTER_SPEC_EMPTY");
    expect(emptyTarget.body.error.message).toContain("目标");

    // 目标与起点完全重合 = 原地不动
    const same = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002")], targetSpecs: [spec("b_002"), spec("b_005")], quantity: 1 },
      a.jar,
    );
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe("BARTER_TARGET_SAME_AS_START");
  });

  it("★ 校验：起点侧现在一条鱼都拿不出来 → 拒绝", async () => {
    // 起点写 B5（背包里只有 B2/B3 的鱼）
    const a = seedAccountWithGame();
    const r = await app.post(
      `/api/accounts/${a.accountId}/barter/tasks`,
      { fromSpecs: [spec("b_005")], targetSpecs: [spec("b_007")], quantity: 1 },
      a.jar,
    );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BARTER_START_FISH_UNUSABLE");

    // 鱼被锁定 / 成了专精目标鱼同样不算
    const b = seedAccountWithGame({ mastery: { "f-myth-b2": 8, "f-exo-b2": 2 } });
    const mastery = await app.post(
      `/api/accounts/${b.accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002")], targetSpecs: [spec("b_005")], quantity: 1 },
      b.jar,
    );
    expect(mastery.status).toBe(400);
    expect(mastery.body.error.code).toBe("BARTER_START_FISH_UNUSABLE");

    const c = seedAccountWithGame({ inventory: [{ fishId: "f-myth-b2", quantity: 2, isMasteryLocked: true }] });
    const locked = await app.post(
      `/api/accounts/${c.accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002")], targetSpecs: [spec("b_005")], quantity: 1 },
      c.jar,
    );
    expect(locked.status).toBe(400);
    expect(locked.body.error.code).toBe("BARTER_START_FISH_UNUSABLE");
  });

  it("数量超过起点侧现有的鱼也允许建（钓到鱼之后自己会继续换）", async () => {
    const { accountId, jar } = seedAccountWithGame(); // B2 只有 3 条
    const r = await app.post<{ quantity: number }>(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002"), spec("b_003")], targetSpecs: [spec("b_005")], quantity: 20 },
      jar,
    );
    expect(r.status).toBe(201);
    expect(r.body.quantity).toBe(20);
  });

  it("★ 重复的规格会被并掉（同一张图同一档只算一次）", async () => {
    const { accountId, jar } = seedAccountWithGame();
    const r = await app.post<{ fromSpecs: unknown[]; targetSpecs: unknown[] }>(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002"), spec("b_002")], targetSpecs: [spec("b_005"), spec("b_005")], quantity: 1 },
      jar,
    );
    expect(r.status).toBe(201);
    expect(r.body.fromSpecs).toHaveLength(1);
    expect(r.body.targetSpecs).toHaveLength(1);
  });

  it("★ 队列上限：未完成的任务最多 5 条", async () => {
    const { accountId, jar } = seedAccountWithGame();
    for (let i = 0; i < 5; i++) {
      const r = await app.post(
        `/api/accounts/${accountId}/barter/tasks`,
        { fromSpecs: [spec("b_002")], targetSpecs: [spec("b_005")], quantity: 1 },
        jar,
      );
      expect(r.status).toBe(201);
    }
    const overflow = await app.post(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002")], targetSpecs: [spec("b_005")], quantity: 1 },
      jar,
    );
    expect(overflow.status).toBe(400);
    expect(overflow.body.error.code).toBe("BARTER_QUEUE_FULL");
  });

  it("★ 取消任务：幂等、未知 id 404，并且面板里留下已取消的记录", async () => {
    const { accountId, jar } = seedAccountWithGame();
    const created = await app.post<{ id: string }>(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002")], targetSpecs: [spec("b_005")], quantity: 1 },
      jar,
    );

    const first = await app.del<{ ok: boolean; status: string; from: string; to: string }>(
      `/api/accounts/${accountId}/barter/tasks/${created.body.id}`,
      jar,
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, status: "cancelled", from: "B2的任意神话鱼", to: "B5的任意神话鱼" });

    const again = await app.del<{ status: string }>(`/api/accounts/${accountId}/barter/tasks/${created.body.id}`, jar);
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
      { fromSpecs: [spec("b_002")], targetSpecs: [spec("b_005")], quantity: 1 },
      other.jar,
    );
    expect(write.status).toBe(404);
  });

  it("★ 审计：新增与取消各留一条，描述里带 B 编号", async () => {
    const { accountId, jar, rt } = seedAccountWithGame();
    const created = await app.post<{ id: string }>(
      `/api/accounts/${accountId}/barter/tasks`,
      { fromSpecs: [spec("b_002"), spec("b_003")], targetSpecs: [spec("b_005")], quantity: 2 },
      jar,
    );
    await app.del(`/api/accounts/${accountId}/barter/tasks/${created.body.id}`, jar);

    const rows = app.repos.audit.list({ action: "account.barter.task", userId: rt.userId });
    expect(rows).toHaveLength(2);
    const { describeAudit } = await import("../src/lib/audit-text.ts");
    const resolvers = { accountLabel: () => "以物易物1", userName: () => "tester" };
    const texts = rows.map((r) => describeAudit(r, resolvers));
    expect(texts.some((t) => t.includes("新增以物易物任务") && t.includes("B2 / B3"))).toBe(true);
    expect(texts.some((t) => t.includes("取消") && t.includes("B5"))).toBe(true);
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
