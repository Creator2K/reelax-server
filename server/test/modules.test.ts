// 模块纯函数单测
//
// 这些函数是各模块的「决策大脑」，抽出来是为了能脱离网络单独验证：
// 加点方案、装备分档、选图评分。算错任何一个都会静默做错事
// （加错点、卖错装备、把号从比赛图拽走），所以必须有测试。
import { describe, expect, it } from "vitest";
import { MODULES, assertRegistryValid } from "../src/modules/registry.ts";
import { resolveModuleConfig, validateConfigPatch } from "../src/modules/types.ts";
import {
  investedOf,
  planFromScratch,
  planStatAllocation,
  readStatPlan,
  sameAllocation,
} from "../src/modules/auto-stats/index.ts";
import { bucketOf } from "../src/modules/auto-sell-gear/index.ts";
import { sacrificedRarities } from "../src/modules/auto-mastery/index.ts";
import {
  DEFAULT_PRIORITIES,
  describeBiome,
  isGolden,
  parsePriorities,
  planTravel,
  valueWeight,
  xpWeight,
} from "../src/modules/auto-travel/index.ts";

/* ==================== 自动加点 ==================== */

/** 造一份「顺序 + 数值」的配置（顺序 = 数组顺序） */
const plan4 = (keys: string[], values: number[]) => keys.map((key, i) => ({ key, value: values[i] ?? 0 }));

describe("readStatPlan", () => {
  it("★ 保留用户排的顺序，四维一定是完整的（缺的补在末尾）", () => {
    const plan = readStatPlan([
      { key: "luck", value: 100 },
      { key: "intelligence", value: 2000 },
    ]);
    expect(plan.map((p) => p.key)).toEqual(["luck", "intelligence", "strength", "endurance"]);
    expect(plan[0]?.value).toBe(100);
  });

  it("认不出的 key 丢掉、重复的只留第一次、非法值归 0", () => {
    const plan = readStatPlan([
      { key: "luck", value: 5 },
      { key: "luck", value: 9 },
      { key: "nope", value: 1 },
      { key: "strength", value: -3 },
    ]);
    expect(plan.find((p) => p.key === "luck")?.value).toBe(5);
    expect(plan.find((p) => p.key === "strength")?.value).toBe(0);
    expect(plan.some((p) => p.key === "nope")).toBe(false);
    expect(plan).toHaveLength(4);
  });

  it("空 / 非法输入 → 四维全 0（不抛错）", () => {
    expect(readStatPlan(null).map((p) => p.value)).toEqual([0, 0, 0, 0]);
    expect(readStatPlan("nope").map((p) => p.key)).toEqual(["strength", "intelligence", "luck", "endurance"]);
  });
});

describe("investedOf", () => {
  it("按固定顺序读四维，缺失按 0", () => {
    expect(investedOf({ strength: 10, intelligence: 20 })).toEqual([10, 20, 0, 0]);
    expect(investedOf({ endurance: 5 })).toEqual([0, 0, 0, 5]);
    expect(investedOf(undefined)).toEqual([0, 0, 0, 0]);
  });

  it("负数与非法值归零", () => {
    expect(investedOf({ strength: -5, intelligence: "abc" })).toEqual([0, 0, 0, 0]);
  });
});

describe("planStatAllocation（priority：全部给顺序第一项）", () => {
  it("★ 第一项就是主属性（顺序即配置）", () => {
    const r = planStatAllocation({
      mode: "priority",
      unspent: 10,
      invested: [0, 0, 0, 0],
      plan: plan4(["luck", "intelligence", "strength", "endurance"], [0, 0, 0, 0]),
      autoReset: false,
      minPoints: 1,
    });
    expect("amounts" in r && r.amounts).toEqual([0, 0, 10, 0]);
  });

  it("低于门槛时跳过", () => {
    const r = planStatAllocation({
      mode: "priority",
      unspent: 0,
      invested: [0, 0, 0, 0],
      plan: plan4(["strength", "intelligence", "luck", "endurance"], [0, 0, 0, 0]),
      autoReset: false,
      minPoints: 1,
    });
    expect("skip" in r).toBe(true);
  });
});

describe("planStatAllocation（ratio：按配比，余数给顺序最后一项）", () => {
  it("按权重分摊，总和恰好等于可用点数", () => {
    const r = planStatAllocation({
      mode: "ratio",
      unspent: 100,
      invested: [0, 0, 0, 0],
      plan: plan4(["strength", "intelligence", "luck", "endurance"], [1, 1, 1, 1]),
      autoReset: false,
      minPoints: 1,
    });
    expect("amounts" in r).toBe(true);
    if ("amounts" in r) {
      expect(r.amounts.reduce((a, b) => a + b, 0)).toBe(100);
      expect(r.amounts).toEqual([25, 25, 25, 25]);
    }
  });

  it("★ 余数归**用户排的最后一项**（旧版写死给耐力）", () => {
    const r = planStatAllocation({
      mode: "ratio",
      unspent: 10,
      invested: [0, 0, 0, 0],
      // 顺序：力量 → 智力 → 耐力 → 运气（运气在最后）
      plan: plan4(["strength", "intelligence", "endurance", "luck"], [1, 1, 1, 1]),
      autoReset: false,
      minPoints: 1,
    });
    if ("amounts" in r) {
      expect(r.amounts).toEqual([2, 2, 4, 2]); // 运气（顺序最后一项）吃掉余数
      expect(r.amounts.reduce((a, b) => a + b, 0)).toBe(10);
    } else {
      throw new Error("应当给出方案");
    }
  });

  it("权重不同的按比例分摊", () => {
    const r = planStatAllocation({
      mode: "ratio",
      unspent: 1000,
      invested: [0, 0, 0, 0],
      plan: plan4(["strength", "intelligence", "luck", "endurance"], [1, 2, 0, 1]),
      autoReset: false,
      minPoints: 1,
    });
    if ("amounts" in r) {
      expect(r.amounts[0]).toBe(250);
      expect(r.amounts[1]).toBe(500);
      expect(r.amounts[2]).toBe(0);
      expect(r.amounts[3]).toBe(250);
    }
  });

  it("配比全 0 → 报错（提示去填权重）", () => {
    const r = planStatAllocation({
      mode: "ratio",
      unspent: 10,
      invested: [0, 0, 0, 0],
      plan: plan4(["strength", "intelligence", "luck", "endurance"], [0, 0, 0, 0]),
      autoReset: false,
      minPoints: 1,
    });
    expect("error" in r && r.error).toContain("配比全为 0");
  });
});

describe("planStatAllocation（target：按目标值补齐）", () => {
  const plan = plan4(["strength", "intelligence", "luck", "endurance"], [0, 2000, 0, 100]);

  it("点数够 → 一次补齐，多的留存", () => {
    const r = planStatAllocation({
      mode: "target",
      unspent: 5000,
      invested: [0, 0, 0, 0],
      plan,
      autoReset: false,
      minPoints: 1,
    });
    if (!("amounts" in r)) throw new Error("应当给出方案");
    expect(r.amounts).toEqual([0, 2000, 0, 100]);
    expect(r.notes.join()).toContain("溢出");
  });

  it("已经达标的部分不再补", () => {
    const r = planStatAllocation({
      mode: "target",
      unspent: 5000,
      invested: [0, 1500, 0, 100],
      plan,
      autoReset: false,
      minPoints: 1,
    });
    if (!("amounts" in r)) throw new Error("应当给出方案");
    expect(r.amounts).toEqual([0, 500, 0, 0]);
  });

  it("全部达标 → 跳过", () => {
    const r = planStatAllocation({
      mode: "target",
      unspent: 5000,
      invested: [0, 2000, 0, 100],
      plan,
      autoReset: false,
      minPoints: 1,
    });
    expect("skip" in r && r.skip).toContain("达到目标值");
  });

  it("★ 点数不够时按**用户排的顺序**依次填（旧版写死 力量→智力→运气→耐力）", () => {
    const r = planStatAllocation({
      mode: "target",
      unspent: 600,
      invested: [0, 0, 0, 0],
      // 顺序：运气 → 智力 → 力量 → 耐力；目标各 500（耐力 0）
      plan: plan4(["luck", "intelligence", "strength", "endurance"], [500, 500, 500, 0]),
      autoReset: false,
      minPoints: 1,
    });
    if (!("amounts" in r)) throw new Error("应当给出方案");
    // 600 点：运气先拿满 500，剩下 100 给智力 → 力量一点没拿到
    expect(r.amounts).toEqual([0, 100, 500, 0]);
  });

  it("点数不够且有剩余时给出说明", () => {
    const r = planStatAllocation({
      mode: "target",
      unspent: 300,
      invested: [0, 0, 0, 0],
      plan: plan4(["luck", "intelligence", "strength", "endurance"], [500, 500, 500, 0]),
      autoReset: false,
      minPoints: 1,
    });
    if (!("amounts" in r)) throw new Error("应当给出方案");
    expect(r.notes.join()).toContain("先投 300 点");
  });

  it("需要洗点搬运且开启时 → 交给调用方洗点（__NEED_RESET__）", () => {
    const r = planStatAllocation({
      mode: "target",
      unspent: 100,
      invested: [800, 0, 0, 0], // 力量超出目标 800，可搬
      plan: plan4(["strength", "intelligence", "luck", "endurance"], [0, 300, 0, 0]),
      autoReset: true,
      minPoints: 1,
    });
    expect("error" in r && r.error).toBe("__NEED_RESET__");
  });

  it("需要搬运但没开洗点 → 跳过并说明", () => {
    const r = planStatAllocation({
      mode: "target",
      unspent: 100,
      invested: [800, 0, 0, 0],
      plan: plan4(["strength", "intelligence", "luck", "endurance"], [0, 300, 0, 0]),
      autoReset: false,
      minPoints: 1,
    });
    expect("skip" in r && r.skip).toContain("自动洗点搬运");
  });
});

describe("planFromScratch / sameAllocation（判断切换方案要不要洗点）", () => {
  const plan = plan4(["luck", "intelligence", "endurance", "strength"], [3, 2, 0, 0]);

  it("按配比：把全部点数从零按权重分一次", () => {
    expect(planFromScratch({ mode: "ratio", plan, totalPoints: 1000 })).toEqual([0, 400, 600, 0]);
  });

  it("全部给第一项：全给运气", () => {
    expect(planFromScratch({ mode: "priority", plan, totalPoints: 1000 })).toEqual([0, 0, 1000, 0]);
  });

  it("到目标值：按顺序补，补不满就停（剩余留空）", () => {
    const target = plan4(["intelligence", "endurance", "strength", "luck"], [2000, 100, 0, 0]);
    expect(planFromScratch({ mode: "target", plan: target, totalPoints: 500 })).toEqual([0, 500, 0, 0]);
    expect(planFromScratch({ mode: "target", plan: target, totalPoints: 5000 })).toEqual([0, 2000, 0, 100]);
  });

  it("方案无效（比如配比全 0）→ null（调用方据此不洗点）", () => {
    expect(planFromScratch({ mode: "ratio", plan: plan4(["luck"], [0]), totalPoints: 100 })).toBeNull();
  });

  it("sameAllocation：逐项比较，长度不同也算不同", () => {
    expect(sameAllocation([1, 2, 3, 4], [1, 2, 3, 4])).toBe(true);
    expect(sameAllocation([1, 2, 3, 4], [1, 2, 3, 5])).toBe(false);
    expect(sameAllocation([1, 2], [1, 2, 0, 0])).toBe(false);
  });
});

/* ==================== 自动卖装备 ==================== */

describe("bucketOf（装备分档：两个勾选集合）", () => {
  const SELL = new Set(["common", "uncommon", "fine", "rare", "epic"]);
  const NONE = new Set<string>();
  const DISMANTLE = new Set(["legendary", "mythic", "exotic"]);

  it("勾了「直接卖」的品质才卖，没勾的保留", () => {
    for (const r of ["common", "uncommon", "fine", "rare", "epic"]) {
      expect(bucketOf(r, SELL, NONE), r).toBe("sell");
    }
    for (const r of ["legendary", "mythic", "exotic", "arcane"]) {
      expect(bucketOf(r, SELL, NONE), r).toBe("keep");
    }
  });

  it("★ 分解优先于出售，但只对「可分解」的档位生效", () => {
    expect(bucketOf("legendary", SELL, DISMANTLE)).toBe("dismantle");
    expect(bucketOf("exotic", SELL, DISMANTLE)).toBe("dismantle");
    // 奥秘游戏不允许分解 → 即使两边都勾了，也按出售处理
    expect(bucketOf("arcane", new Set(["arcane"]), new Set(["arcane"]))).toBe("sell");
  });

  it("两个集合都没勾 → 全部保留", () => {
    for (const r of ["common", "legendary", "arcane"]) {
      expect(bucketOf(r, NONE, NONE), r).toBe("keep");
    }
  });

  it("不认识的稀有度一律保留（不猜、不误卖）", () => {
    expect(bucketOf("unknown", SELL, DISMANTLE)).toBe("keep");
    expect(bucketOf(undefined, SELL, DISMANTLE)).toBe("keep");
    expect(bucketOf(null, SELL, DISMANTLE)).toBe("keep");
    expect(bucketOf("", SELL, DISMANTLE)).toBe("keep");
  });
});

/* ==================== 自动专精献祭：保护高稀有度 ==================== */

describe("sacrificedRarities（献祭哪些档位）", () => {
  it("★ 默认保护传说及以上", () => {
    expect(sacrificedRarities("protectLegendary", [])).toEqual(["common", "uncommon", "fine", "rare", "epic"]);
  });

  it("三种预设 + 自选", () => {
    expect(sacrificedRarities("all", [])).toHaveLength(9);
    expect(sacrificedRarities("protectExotic", [])).toEqual([
      "common",
      "uncommon",
      "fine",
      "rare",
      "epic",
      "legendary",
      "mythic",
    ]);
    expect(sacrificedRarities("custom", ["exotic", "common", "nope"])).toEqual(["common", "exotic"]);
  });

  it("模式认不出时退回默认（保护传说及以上），自选为空时什么都不献", () => {
    expect(sacrificedRarities("bogus", [])).toEqual(["common", "uncommon", "fine", "rare", "epic"]);
    expect(sacrificedRarities("custom", [])).toEqual([]);
    expect(sacrificedRarities(undefined, [])).toEqual(["common", "uncommon", "fine", "rare", "epic"]);
  });
});

/* ==================== 自动切图：优先级与评分 ==================== */

describe("parsePriorities", () => {
  it("解析顺序（有序子集：用户放几项就是几项）", () => {
    expect(parsePriorities("golden,competition,experience")).toEqual(["golden", "competition", "experience"]);
    expect(parsePriorities(["golden", "follow"])).toEqual(["golden", "follow"]);
  });

  it("★ 认不出的项丢掉、重复的只留一次，空值用默认顺序", () => {
    expect(parsePriorities("experience")).toEqual(["experience"]);
    expect(parsePriorities("golden,golden,experience")).toEqual(["golden", "experience"]);
    expect(parsePriorities("")).toEqual(DEFAULT_PRIORITIES);
    expect(parsePriorities(undefined)).toEqual(DEFAULT_PRIORITIES);
    expect(parsePriorities("看心情")).toEqual(DEFAULT_PRIORITIES);
  });

  it("1.7.0 短暂存在过的「涌流」项被当成认不出的项丢掉（老配置不会卡住保存）", () => {
    expect(parsePriorities("competition,golden,surge,experience")).toEqual([
      "competition",
      "golden",
      "experience",
    ]);
  });
});

describe("xpWeight / valueWeight（经验只看天气）", () => {
  it("★ 经验权重只看天气倍率，不算专精与公会", () => {
    // 专精 +31.5%、公会 +50% 都不参与 —— 否则专精高的老图永远赢
    const biome = {
      masteryXpBonusBasisPoints: 3150,
      guildXpBonusBasisPoints: 5000,
      weather: { weatherId: "mist" }, // 雾语 +20%
    };
    expect(xpWeight(biome)).toBeCloseTo(1.2, 6);
  });

  it("九种天气都用倍率表（金风 / 枯潮的文本里没有「经验」二字）", () => {
    expect(xpWeight({ weather: { weatherId: "arcane_surge" } })).toBeCloseTo(1.75, 6);
    expect(xpWeight({ weather: { weatherId: "gilded_current" } })).toBeCloseTo(0.75, 6);
    expect(xpWeight({ weather: { weatherId: "wither_tide" } })).toBeCloseTo(0.5, 6);
    expect(xpWeight({ weather: { weatherId: "clear" } })).toBeCloseTo(1, 6);
  });

  it("天气字段缺失 / 只给 id / 不认识时按 1 倍，不编造", () => {
    expect(xpWeight({ weather: { id: "tempest" } })).toBeCloseTo(1.5, 6);
    expect(xpWeight({ weather: {} })).toBeCloseTo(1, 6);
    expect(xpWeight({})).toBeCloseTo(1, 6);
    expect(xpWeight({ weather: { weatherId: "新天气" } })).toBeCloseTo(1, 6);
  });

  it("鱼价值倍率缺失时按 1", () => {
    expect(valueWeight({ valueMultiplier: 1.4 })).toBe(1.4);
    expect(valueWeight({})).toBe(1);
  });

  it("isGolden 认的是金风天气", () => {
    expect(isGolden({ weather: { weatherId: "gilded_current" } })).toBe(true);
    expect(isGolden({ weather: { id: "gilded_current" } })).toBe(true);
    expect(isGolden({ weather: { weatherId: "clear" } })).toBe(false);
    expect(isGolden({})).toBe(false);
  });
});

describe("planTravel（按优先级选图）", () => {
  const biomes = [
    { id: "cur", name: "当前", isCurrent: true, valueMultiplier: 1, weather: { weatherId: "clear" } },
    { id: "xp", name: "经验图", valueMultiplier: 1.1, weather: { weatherId: "tempest" } }, // ×1.5
    { id: "gold", name: "金币图", valueMultiplier: 2.0, weather: { weatherId: "clear" } },
    { id: "goldwind", name: "金风图", valueMultiplier: 1.2, weather: { weatherId: "gilded_current" } },
  ];
  const plan = (over: Partial<Parameters<typeof planTravel>[0]> = {}) =>
    planTravel({
      priorities: DEFAULT_PRIORITIES,
      unlocked: biomes,
      currentBiomeId: "cur",
      competition: null,
      minImprovePct: 3,
      ...over,
    });

  it("★ 顺序即决定：比赛 > 金风 > 经验（默认）", () => {
    // 有比赛 → 去比赛图（哪怕金风 / 经验更好）
    expect(plan({ competition: { biomeId: "gold", why: "个人赛 #3 进行中" } })).toMatchObject({
      action: "travel",
      biomeId: "gold",
      reason: "competition",
    });
    // 没比赛 → 金风优先于经验
    expect(plan()).toMatchObject({ action: "travel", biomeId: "goldwind", reason: "golden" });
  });

  it("★ 把经验排到最前面，就去天气经验最高的图（不看专精 / 公会 / 鱼价值）", () => {
    const d = plan({ priorities: ["experience", "golden", "competition"] });
    expect(d).toMatchObject({ action: "travel", biomeId: "xp", reason: "experience" });
  });

  it("优先级可以只把金风排前面", () => {
    const d = plan({ priorities: ["golden", "experience", "competition"], competition: { biomeId: "gold", why: "个人赛 #9" } });
    expect(d).toMatchObject({ action: "travel", biomeId: "goldwind", reason: "golden" });
  });

  it("★ 已经在比赛图里就待着（不会被金风 / 经验拽走）", () => {
    const d = plan({ competition: { biomeId: "cur", why: "个人赛 #3 进行中" } });
    expect(d).toMatchObject({ action: "stay", reason: "competition" });
    expect(d.why).toContain("已在比赛地图");
  });

  it("★ 已经在金风图里就待着（金风排在经验前面时）", () => {
    const d = plan({ currentBiomeId: "goldwind" });
    expect(d).toMatchObject({ action: "stay", reason: "golden" });
  });

  it("当前图天气经验最高 → 待着（经验优先级）", () => {
    const d = plan({ priorities: ["experience", "golden", "competition"], currentBiomeId: "xp" });
    expect(d).toMatchObject({ action: "stay", reason: "experience" });
    expect(d.why).toContain("最优");
  });

  it("★ 迟滞：高得不够就不动（含具体数字，便于排查）", () => {
    // 当前 clear×1.00，目标 mist 在另一套数据里给 +20%
    const set = [
      { id: "cur", name: "当前", valueMultiplier: 1, weather: { weatherId: "rain" } }, // 1.05
      { id: "better", name: "稍好", valueMultiplier: 1, weather: { weatherId: "gale" } }, // 1.10 → 高 4.76%
    ];
    const d = planTravel({
      priorities: ["experience", "golden", "competition"],
      unlocked: set,
      currentBiomeId: "cur",
      competition: null,
      minImprovePct: 10, // 门槛 10% → 不动
    });
    expect(d).toMatchObject({ action: "stay", reason: "experience" });
    expect(d.why).toContain("4.8%");
    // 门槛降到 3% 就会切
    expect(
      planTravel({
        priorities: ["experience", "golden", "competition"],
        unlocked: set,
        currentBiomeId: "cur",
        competition: null,
        minImprovePct: 3,
      }),
    ).toMatchObject({ action: "travel", biomeId: "better" });
  });

  it("比赛 / 金风命中时不受迟滞影响（时段性的，犹豫就错过）", () => {
    const d = plan({ minImprovePct: 100, competition: { biomeId: "gold", why: "公会赛 #2 即将开赛" } });
    expect(d).toMatchObject({ action: "travel", biomeId: "gold" });
  });

  it("没有候选（没比赛、没金风、也没有别的图）→ 待着", () => {
    expect(plan({ unlocked: [biomes[0]], currentBiomeId: "cur" })).toMatchObject({ action: "stay" });
    expect(planTravel({ priorities: DEFAULT_PRIORITIES, unlocked: [], currentBiomeId: null, competition: null, minImprovePct: 0 })).toMatchObject({
      action: "stay",
      reason: null,
    });
  });

  it("多张金风图时挑鱼价值最高的", () => {
    const set = [
      { id: "cur", name: "当前", valueMultiplier: 1, weather: { weatherId: "clear" } },
      { id: "g1", name: "金风A", valueMultiplier: 1.1, weather: { weatherId: "gilded_current" } },
      { id: "g2", name: "金风B", valueMultiplier: 1.5, weather: { weatherId: "gilded_current" } },
    ];
    expect(plan({ unlocked: set })).toMatchObject({ action: "travel", biomeId: "g2" });
  });
});

describe("describeBiome（日志可核对）", () => {
  it("包含鱼价值与天气经验倍率，不再提专精 / 公会", () => {
    const text = describeBiome({
      name: "熔潮环礁",
      valueMultiplier: 1.4,
      masteryXpBonusBasisPoints: 2100,
      guildXpBonusBasisPoints: 1100,
      weather: { weatherId: "heatwave" }, // 热浪 +30%
    });
    expect(text).toContain("熔潮环礁");
    expect(text).toContain("鱼价值×1.40");
    expect(text).toContain("热浪");
    expect(text).toContain("×1.30");
    expect(text).not.toContain("专精");
    expect(text).not.toContain("公会");
  });
});

/* ==================== 模块清单自检 ==================== */

describe("模块清单自检", () => {
  it("启动自检通过（id 唯一、select 有 options、min ≤ max）", () => {
    expect(() => assertRegistryValid()).not.toThrow();
  });

  it("★ defaultConfig 与 configSchema 不漂移", () => {
    // 两处各写一份默认值是这套设计的弱点：只在 defaultConfig 里多写一个键，
    // 用户界面上就会多出一条「旧版本遗留配置」，而模块自己读的还是 configSchema 合并后的值。
    for (const def of MODULES) {
      const schemaKeys = def.configSchema.map((f) => f.key);
      expect(Object.keys(def.defaultConfig).sort(), def.id).toEqual([...schemaKeys].sort());
      for (const f of def.configSchema) {
        expect(def.defaultConfig[f.key], `${def.id}.${f.key}`).toEqual(f.default);
      }
    }
  });

  it("★ 地图选择字段接受游戏新地图 id 和自动选项", () => {
    const pity = MODULES.find((m) => m.id === "auto-pity")!;
    expect(pity.configSchema.find((f) => f.key === "arcaneBiome")?.type).toBe("biome-select");

    const resolved = resolveModuleConfig(pity, { exoticBiome: "b_016", arcaneBiome: "auto" });
    expect(resolved.issues).toEqual([]);
    expect(resolved.config.exoticBiome).toBe("b_016");
    expect(resolved.config.arcaneBiome).toBe("auto");

    const patch = validateConfigPatch(pity, { exoticBiome: "b_016", arcaneBiome: "auto" });
    expect(patch.errors).toEqual([]);
    expect(patch.patch).toEqual({ exoticBiome: "b_016", arcaneBiome: "auto" });
  });

  it("每个模块的字符串字段都有 label（前端表单靠它渲染）", () => {
    for (const def of MODULES) {
      for (const f of def.configSchema) {
        expect(f.label, `${def.id}.${f.key}`).toBeTruthy();
      }
    }
  });
});
