// 以物易物面板数据组装（纯函数）
//
// 这一版任务的两侧都是「地图 + 稀有度」的列表，所以这里盯三件事：
//  1. 起点候选要把同图同档的鱼合并计数，并排除专精目标鱼 / 锁定鱼 / 三档以下的鱼；
//  2. 目标候选 = 游戏里这张图这一档确实有鱼；
//  3. 展示时带上 `B2` 这类编号（玩家交流用的就是它）。
import { describe, expect, it } from "vitest";
import {
  buildBarterView,
  barterTaskStatusText,
  filterStartFish,
  masteryTargetFishIds,
  pickStartCandidates,
  pickStartMapOptions,
  pickTargetMapOptions,
  readContentFish,
  readInventoryFish,
  specView,
  specsSummary,
  taskFromText,
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
    { id: "f-myth-b2b", name: "雾语夜光鲈", rarity: "mythic", biomeId: "b_002" },
    { id: "f-exo-b2", name: "雾语幻影鳅", rarity: "exotic", biomeId: "b_002" },
    { id: "f-arc-b5", name: "星根渊鳗", rarity: "arcane", biomeId: "b_005" },
    { id: "f-myth-b5", name: "星根盲鳗", rarity: "mythic", biomeId: "b_005" },
    { id: "f-myth-b3", name: "镜潮银鲷", rarity: "mythic", biomeId: "b_003" },
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
    expect(list).toHaveLength(8);
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

describe("起点候选", () => {
  const inventory = readInventoryFish({
    fish: [
      { fishId: "f-myth-b2", quantity: 4 },
      { fishId: "f-myth-b2b", quantity: 2 },
      { fishId: "f-exo-b2", quantity: 3 },
      { fishId: "f-arc-b5", quantity: 1 },
      { fishId: "f-myth-b5", quantity: 7, isLocked: true },
      { fishId: "f-common-b2", quantity: 99 },
      { fishId: "unknown-fish", quantity: 5 },
    ],
  });

  it("★ 鱼种粒度：排除锁定鱼、三档以下、鱼表里没有的鱼", () => {
    const list = pickStartCandidates({ inventory, content: CONTENT });
    expect(list.map((c) => c.fishId)).toEqual(["f-myth-b2", "f-myth-b2b", "f-exo-b2", "f-arc-b5"]);
    expect(list[0]).toMatchObject({ name: "雾语灯笼鱼", biomeId: "b_002", rarity: "mythic", quantity: 4 });
  });

  it("★ 地图粒度：同图同档合并数量（B2 的神话 = 4 + 2 = 6 条）", () => {
    const list = pickStartMapOptions({ inventory, content: CONTENT });
    expect(list.map((m) => `${m.biomeCode}:${m.rarity}=${m.quantity}`)).toEqual([
      "B2:mythic=6",
      "B2:exotic=3",
      "B5:arcane=1",
    ]);
    const b2Mythic = list.find((m) => m.biomeCode === "B2" && m.rarity === "mythic");
    expect(b2Mythic).toMatchObject({ biomeName: "雾语湿地", rarityLabel: "神话", quantity: 6 });
  });

  it("★ 专精目标鱼不算（它要留给献祭）", () => {
    const list = pickStartMapOptions({
      inventory,
      content: CONTENT,
      masteryTargets: new Set(["f-myth-b2", "f-myth-b2b"]),
    });
    // B2 的神话鱼全是专精目标 → 这一项整个消失
    expect(list.some((m) => m.biomeCode === "B2" && m.rarity === "mythic")).toBe(false);
  });

  it("拿不到鱼表时不会把鱼列出来（宁可空着）", () => {
    expect(pickStartMapOptions({ inventory, content: null })).toEqual([]);
  });

  it("filterStartFish：只留下命中起点规格的鱼", () => {
    const candidates = pickStartCandidates({ inventory, content: CONTENT });
    const hit = filterStartFish([{ biomeId: "b_002", rarity: "mythic", fishId: null }], candidates);
    expect(hit.map((c) => c.fishId)).toEqual(["f-myth-b2", "f-myth-b2b"]);
  });
});

describe("目标候选", () => {
  it("只留最高三档、且有地图归属的地图 × 档位组合", () => {
    const list = pickTargetMapOptions(CONTENT);
    expect(list.map((m) => `${m.biomeCode}:${m.rarity}`)).toEqual([
      "B2:mythic",
      "B2:exotic",
      "B3:mythic",
      "B5:mythic",
      "B5:arcane",
    ]);
  });
});

describe("规格展示", () => {
  it("specView 带上「地图名 B几」与稀有度中文名", () => {
    const v = specView({ biomeId: "b_002", rarity: "mythic", fishId: null }, CONTENT);
    expect(v).toMatchObject({ biomeCode: "B2", biomeName: "雾语湿地", rarityLabel: "神话" });
    expect(v.text).toBe("雾语湿地 B2 的任意神话鱼");
  });

  it("老任务的指名鱼种也能渲染", () => {
    const v = specView({ biomeId: "b_005", rarity: "mythic", fishId: "f-myth-b5" }, CONTENT);
    expect(v.fishName).toBe("星根盲鳗");
    expect(v.text).toBe("星根洞窟 B5 的星根盲鳗");
  });

  it("specsSummary：多地图用 B 几连起来", () => {
    const specs = [
      specView({ biomeId: "b_002", rarity: "mythic", fishId: null }),
      specView({ biomeId: "b_003", rarity: "mythic", fishId: null }),
      specView({ biomeId: "b_005", rarity: "mythic", fishId: null }),
    ];
    expect(specsSummary(specs)).toBe("B2 / B3 / B5的任意神话鱼");
  });

  it("不同稀有度混在一条任务里时，不再硬说某一档", () => {
    const specs = [
      specView({ biomeId: "b_002", rarity: "mythic", fishId: null }),
      specView({ biomeId: "b_002", rarity: "arcane", fishId: null }),
    ];
    expect(specsSummary(specs)).toBe("B2 / B2的任意同稀有度鱼");
  });
});

describe("任务展示", () => {
  const row: BarterTaskRow = {
    id: "t1",
    account_id: "a1",
    user_id: "u1",
    from_specs: [
      { biomeId: "b_002", rarity: "mythic", fishId: null },
      { biomeId: "b_003", rarity: "mythic", fishId: null },
    ],
    target_specs: [{ biomeId: "b_005", rarity: "mythic", fishId: null }],
    from_fish_id: "f-myth-b2",
    from_fish_name: "雾语灯笼鱼",
    from_biome_id: "b_002",
    rarity: "mythic",
    quantity: 5,
    done_quantity: 2,
    target_biome_id: "b_005",
    target_fish_id: null,
    target_fish_name: "",
    status: "waiting",
    last_note: "当前没有能在 3 次交换内换到目标的现成交换单",
    last_error: null,
    created_at: 1,
    updated_at: 2,
  };

  it("toTaskView 给出两侧的规格与紧凑说法", () => {
    const v = toTaskView(row);
    expect(v.fromText).toBe("B2 / B3的任意神话鱼");
    expect(v.targetText).toBe("B5的任意神话鱼");
    expect(v.statusText).toBe("等待中");
    expect(v.doneQuantity).toBe(2);
    expect(v.fromSpecs[0]).toMatchObject({ biomeName: "雾语湿地", biomeCode: "B2", rarityLabel: "神话" });
  });

  it("日志用的一句话说法", () => {
    expect(taskFromText(row)).toBe("B2 / B3的任意神话鱼");
    expect(taskTargetText(row)).toBe("B5的任意神话鱼");
  });

  it("状态文案覆盖全部取值", () => {
    expect(barterTaskStatusText("running")).toBe("进行中");
    expect(barterTaskStatusText("done")).toBe("已完成");
    expect(barterTaskStatusText("blocked")).toContain("缺鱼");
    expect(barterTaskStatusText("cancelled")).toBe("已取消");
  });

  it("★ 目标判定：命中任意一个目标规格就算达成", () => {
    const hit = taskTargetMatcher({
      target_specs: [
        { biomeId: "b_005", rarity: "mythic", fishId: null },
        { biomeId: "b_003", rarity: "mythic", fishId: null },
      ],
    });
    expect(hit({ fishId: "any", name: "x", biomeId: "b_003", rarity: "mythic" })).toBe(true);
    expect(hit({ fishId: "any", name: "x", biomeId: "b_005", rarity: "mythic" })).toBe(true);
    // 地图对了但档位不对 → 不算达成
    expect(hit({ fishId: "any", name: "x", biomeId: "b_003", rarity: "exotic" })).toBe(false);
    // 地图不对 → 不算达成
    expect(hit({ fishId: "any", name: "x", biomeId: "b_009", rarity: "mythic" })).toBe(false);
    // 拿不准的鱼（缺地图）一律不算
    expect(hit({ fishId: "any", name: "x", biomeId: null, rarity: "mythic" })).toBe(false);
  });
});

describe("buildBarterView / toHeadView", () => {
  it("把队列、起点候选、目标候选、功能开关状态一起发下去", () => {
    const view = buildBarterView({
      tasks: [],
      inventory: readInventoryFish({ fish: [{ fishId: "f-myth-b2", quantity: 4 }] }),
      content: CONTENT,
      masteryOverview: null,
      moduleEnabled: true,
      moduleRunning: false,
      maxSpecs: 5,
    });

    expect(view.module).toEqual({ enabled: true, running: false });
    expect(view.limits).toEqual({
      maxOpenTasks: MAX_OPEN_TASKS,
      maxQuantity: MAX_TASK_QUANTITY,
      maxSpecs: 5,
      rarities: [
        { value: "mythic", label: "神话" },
        { value: "exotic", label: "奇异" },
        { value: "arcane", label: "奥秘" },
      ],
    });
    expect(view.rarityHint).toBe(BARTER_RARITY_HINT);
    expect(view.startOptions.map((m) => m.biomeCode)).toEqual(["B2"]);
    expect(view.targetOptions.length).toBe(5);
    expect(view.head).toBeNull();
  });

  it("队首预览：走通时给出起点鱼与每一跳，走不通时给出原因", () => {
    const ok = toHeadView(
      "t1",
      {
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
      },
      { fishId: "a", name: "A鱼", biomeId: "b_002" },
    );
    expect(ok.reachable).toBe(true);
    expect(ok).toMatchObject({ startFishName: "A鱼", startBiomeCode: "B2" });
    expect(ok.hops[0]).toMatchObject({ owner: "艾拉", giveName: "A鱼", getName: "B鱼", getBiomeCode: "B5", remaining: 3 });

    const bad = toHeadView("t1", { ok: false, reason: "没有可走的路径" });
    expect(bad.reachable).toBe(false);
    expect(bad.hops).toEqual([]);
    expect(bad.reason).toBe("没有可走的路径");
    expect(bad.startFishId).toBeNull();
  });
});
