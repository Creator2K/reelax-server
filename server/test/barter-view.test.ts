// 以物易物面板数据组装（纯函数）
//
// 起点鱼候选这一块最要紧：**专精目标鱼与锁定鱼绝不能出现在「可以拿去换」的列表里**
// （用户明确要求），这里逐条钉住。
import { describe, expect, it } from "vitest";
import {
  buildBarterView,
  barterTaskStatusText,
  masteryTargetFishIds,
  pickFishCatalog,
  pickStartCandidates,
  readContentFish,
  readInventoryFish,
  taskTargetMatcher,
  taskTargetText,
  toHeadView,
  toTaskView,
  BARTER_RARITY_HINT,
  MAX_OPEN_TASKS,
  MAX_TASK_QUANTITY,
} from "../src/services/barter-view.ts";
import type { BarterTaskRow } from "../src/db/repositories/barter-tasks.ts";

const CONTENT = {
  fish: [
    { id: "f-myth-b2", name: "雾语灯笼鱼", rarity: "mythic", biomeId: "b_002" },
    { id: "f-exo-b2", name: "雾语幻影鳅", rarity: "exotic", biomeId: "b_002" },
    { id: "f-arc-b5", name: "星根渊鳗", rarity: "arcane", biomeId: "b_005" },
    { id: "f-myth-b5", name: "星根盲鳗", rarity: "mythic", biomeId: "b_005" },
    { id: "f-common-b2", name: "雾语小鲫", rarity: "common", biomeId: "b_002" },
    { id: "f-nobiome", name: "无地图的鱼", rarity: "mythic", biomeId: null },
  ],
};

describe("readInventoryFish / readContentFish", () => {
  it("背包条目：数量、手动锁、专精锁都读出来", () => {
    const list = readInventoryFish({
      fish: [
        { fishId: "a", quantity: 3 },
        { fishId: "b", quantity: 1, isLocked: true },
        { fishId: "c", quantity: 2, isMasteryLocked: true },
        { fishId: "d", quantity: 0 },
        { quantity: 9 },
      ],
    });
    expect(list.map((x) => [x.fishId, x.quantity, x.locked, x.masteryLocked])).toEqual([
      ["a", 3, false, false],
      ["b", 1, true, false],
      ["c", 2, false, true],
      ["d", 0, false, false],
    ]);
  });

  it("内容表：id / 名称 / 稀有度 / 地图", () => {
    const list = readContentFish(CONTENT);
    expect(list).toHaveLength(6);
    expect(list[0]).toEqual({ id: "f-myth-b2", name: "雾语灯笼鱼", rarity: "mythic", biomeId: "b_002" });
  });

  it("响应形状不认识时返回空数组，而不是抛错", () => {
    expect(readInventoryFish(null)).toEqual([]);
    expect(readContentFish({})).toEqual([]);
  });
});

describe("masteryTargetFishIds", () => {
  it("★ 只把「还缺」的专精目标鱼算进去", () => {
    const set = masteryTargetFishIds({
      biomes: [
        {
          biomeId: "b_002",
          rarities: [
            { fish: { id: "f-myth-b2" }, remainingQuantity: 12 },
            { fish: { id: "f-exo-b2" }, remainingQuantity: 0 }, // 已凑齐 → 不再限制
          ],
        },
      ],
    });
    expect([...set]).toEqual(["f-myth-b2"]);
  });

  it("字段形态不同（fishId / 没有 fish 对象）也不炸", () => {
    const set = masteryTargetFishIds({
      biomes: [{ rarities: [{ fishId: "x", remainingQuantity: 1 }, { remainingQuantity: 5 }, null] }],
    });
    expect([...set]).toEqual(["x"]);
    expect(masteryTargetFishIds(null).size).toBe(0);
  });

  it("remainingQuantity 缺失时按「还缺」处理（保守）", () => {
    const set = masteryTargetFishIds({ biomes: [{ rarities: [{ fish: { id: "y" } }] }] });
    expect([...set]).toEqual(["y"]);
  });
});

describe("pickStartCandidates", () => {
  const inventory = readInventoryFish({
    fish: [
      { fishId: "f-myth-b2", quantity: 4 },
      { fishId: "f-exo-b2", quantity: 2 },
      { fishId: "f-arc-b5", quantity: 1 },
      { fishId: "f-myth-b5", quantity: 7, isLocked: true },
      { fishId: "f-common-b2", quantity: 99 },
      { fishId: "f-myth-b2-locked", quantity: 3, isMasteryLocked: true },
      { fishId: "unknown-fish", quantity: 5 },
    ],
  });

  it("★ 排除专精目标鱼、锁定鱼、非最高三档、以及鱼表里没有的鱼", () => {
    const list = pickStartCandidates({
      inventory,
      content: CONTENT,
      masteryTargets: new Set(["f-arc-b5"]),
    });
    expect(list.map((c) => c.fishId)).toEqual(["f-myth-b2", "f-exo-b2"]);
  });

  it("带上地图名、稀有度中文名与现有数量", () => {
    const list = pickStartCandidates({ inventory, content: CONTENT });
    const myth = list.find((c) => c.fishId === "f-myth-b2")!;
    expect(myth).toMatchObject({
      name: "雾语灯笼鱼",
      biomeId: "b_002",
      biomeName: "雾语湿地",
      rarity: "mythic",
      rarityLabel: "神话",
      quantity: 4,
    });
  });

  it("拿不到鱼表时不会把鱼列出来（宁可空着，也不能让用户拿到看不出来源的选项）", () => {
    expect(pickStartCandidates({ inventory, content: null })).toEqual([]);
  });
});

describe("pickFishCatalog", () => {
  it("只留最高三档、且有地图归属的鱼（按地图、再按名称排序）", () => {
    const list = pickFishCatalog(CONTENT);
    expect(list.map((f) => f.id)).toEqual(["f-myth-b2", "f-exo-b2", "f-myth-b5", "f-arc-b5"]);
  });
});

describe("任务展示", () => {
  const row: BarterTaskRow = {
    id: "t1",
    account_id: "a1",
    user_id: "u1",
    from_fish_id: "f-myth-b2",
    from_fish_name: "雾语灯笼鱼",
    from_biome_id: "b_002",
    rarity: "mythic",
    quantity: 5,
    done_quantity: 2,
    target_biome_id: "b_005",
    target_fish_id: "f-myth-b5",
    target_fish_name: "星根盲鳗",
    status: "waiting",
    last_note: "当前没有能在 3 次交换内换到目标的现成交换单",
    last_error: null,
    created_at: 1,
    updated_at: 2,
  };

  it("toTaskView 把 id 翻译成名字与中文状态", () => {
    const v = toTaskView(row);
    expect(v.fromBiomeName).toBe("雾语湿地");
    expect(v.targetBiomeName).toBe("星根洞窟");
    expect(v.rarityLabel).toBe("神话");
    expect(v.statusText).toBe("等待中");
    expect(v.doneQuantity).toBe(2);
  });

  it("目标说法：具体鱼种 / 该地图任意鱼", () => {
    expect(taskTargetText(row)).toBe("星根盲鳗");
    expect(taskTargetText({ ...row, target_fish_id: null, target_fish_name: "" })).toBe("星根洞窟的任意同稀有度鱼");
  });

  it("状态文案覆盖全部取值", () => {
    expect(barterTaskStatusText("running")).toBe("进行中");
    expect(barterTaskStatusText("done")).toBe("已完成");
    expect(barterTaskStatusText("blocked")).toContain("缺鱼");
    expect(barterTaskStatusText("cancelled")).toBe("已取消");
  });

  it("★ 目标判定：给了具体鱼种就按鱼种，只给地图就按地图", () => {
    const byFish = taskTargetMatcher(row);
    expect(byFish({ fishId: "f-myth-b5", name: "x", biomeId: "b_005", rarity: "mythic" })).toBe(true);
    expect(byFish({ fishId: "f-other", name: "x", biomeId: "b_005", rarity: "mythic" })).toBe(false);

    const byBiome = taskTargetMatcher({ ...row, target_fish_id: null });
    expect(byBiome({ fishId: "f-other", name: "x", biomeId: "b_005", rarity: "mythic" })).toBe(true);
    expect(byBiome({ fishId: "f-other", name: "x", biomeId: "b_006", rarity: "mythic" })).toBe(false);
  });
});

describe("buildBarterView / toHeadView", () => {
  it("把队列、起点候选、目标鱼表、功能开关状态一起发下去", () => {
    const view = buildBarterView({
      tasks: [],
      inventory: readInventoryFish({ fish: [{ fishId: "f-myth-b2", quantity: 4 }] }),
      content: CONTENT,
      masteryOverview: null,
      moduleEnabled: true,
      moduleRunning: false,
    });

    expect(view.module).toEqual({ enabled: true, running: false });
    expect(view.limits).toEqual({ maxOpenTasks: MAX_OPEN_TASKS, maxQuantity: MAX_TASK_QUANTITY, rarities: ["mythic", "exotic", "arcane"] });
    expect(view.rarityHint).toBe(BARTER_RARITY_HINT);
    expect(view.start.map((c) => c.fishId)).toEqual(["f-myth-b2"]);
    expect(view.fish.length).toBe(4);
    expect(view.head).toBeNull();
  });

  it("队首预览：走通时给出每一跳，走不通时给出原因", () => {
    const ok = toHeadView("t1", {
      ok: true,
      capacity: 3,
      hops: [
        {
          orderId: "o1",
          ownerNickname: "艾拉",
          give: { fishId: "a", name: "A鱼", biomeId: "b_002", rarity: "mythic", remaining: 3 },
          get: { fishId: "b", name: "B鱼", biomeId: "b_005", rarity: "mythic", remaining: 3 },
          capacity: 3,
        },
      ],
    });
    expect(ok.reachable).toBe(true);
    expect(ok.hops[0]).toMatchObject({ owner: "艾拉", giveName: "A鱼", getName: "B鱼", remaining: 3 });

    const bad = toHeadView("t1", { ok: false, reason: "没有可走的路径" });
    expect(bad.reachable).toBe(false);
    expect(bad.hops).toEqual([]);
    expect(bad.reason).toBe("没有可走的路径");
  });
});
