// 模块纯函数单测
//
// 这些函数是各模块的「决策大脑」，抽出来是为了能脱离网络单独验证：
// 加点方案、装备分档、选图评分。算错任何一个都会静默做错事
// （加错点、卖错装备、把号从比赛图拽走），所以必须有测试。
import { describe, expect, it } from "vitest";
import { MODULES, assertRegistryValid } from "../src/modules/registry.ts";
import { investedOf, parseRatio, parseTargets, planAllocation } from "../src/modules/auto-stats/index.ts";
import { bucketOf } from "../src/modules/auto-sell-gear/index.ts";
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

describe("parseRatio / parseTargets", () => {
  it("解析冒号分隔的四项", () => {
    expect(parseRatio("2:3:0:1")).toEqual([2, 3, 0, 1]);
    expect(parseRatio("0:2000:0:100")).toEqual([0, 2000, 0, 100]);
  });

  it("容忍中文冒号、逗号与空格", () => {
    expect(parseRatio("2：3：0：1")).toEqual([2, 3, 0, 1]);
    expect(parseRatio("2,3,0,1")).toEqual([2, 3, 0, 1]);
    expect(parseRatio(" 2 3 0 1 ")).toEqual([2, 3, 0, 1]);
  });

  it("项数不对或含非法值时返回 null", () => {
    expect(parseRatio("1:2:3")).toBeNull();
    expect(parseRatio("1:2:3:4:5")).toBeNull();
    expect(parseRatio("a:b:c:d")).toBeNull();
    expect(parseRatio("-1:2:3:4")).toBeNull();
    expect(parseRatio("")).toBeNull();
  });

  it("全 0 的配比视为无效（ratio 模式），但目标值允许全 0", () => {
    expect(parseRatio("0:0:0:0")).toBeNull();
    expect(parseTargets("0:0:0:0")).toEqual([0, 0, 0, 0]);
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

describe("planAllocation（priority）", () => {
  it("全部点数投给主属性", () => {
    const r = planAllocation({
      mode: "priority",
      unspent: 10,
      invested: [0, 0, 0, 0],
      ratio: null,
      targets: null,
      primary: 1, // 智力
      autoReset: false,
      minPoints: 1,
    });
    expect("amounts" in r && r.amounts).toEqual([0, 10, 0, 0]);
  });

  it("低于门槛时跳过", () => {
    const r = planAllocation({
      mode: "priority",
      unspent: 0,
      invested: [0, 0, 0, 0],
      ratio: null,
      targets: null,
      primary: 1,
      autoReset: false,
      minPoints: 1,
    });
    expect("skip" in r).toBe(true);
  });
});

describe("planAllocation（ratio）", () => {
  it("按权重分摊，且总和恰好等于可用点数", () => {
    const r = planAllocation({
      mode: "ratio",
      unspent: 100,
      invested: [0, 0, 0, 0],
      ratio: [1, 1, 1, 1],
      targets: null,
      primary: 1,
      autoReset: false,
      minPoints: 1,
    });
    expect("amounts" in r).toBe(true);
    if ("amounts" in r) {
      expect(r.amounts.reduce((a, b) => a + b, 0)).toBe(100);
      expect(r.amounts).toEqual([25, 25, 25, 25]);
    }
  });

  it("不能整除时余数归最后一维（耐力），总和仍然守恒", () => {
    const r = planAllocation({
      mode: "ratio",
      unspent: 10,
      invested: [0, 0, 0, 0],
      ratio: [1, 1, 1, 1],
      targets: null,
      primary: 1,
      autoReset: false,
      minPoints: 1,
    });
    if ("amounts" in r) {
      const sum = r.amounts.reduce((a, b) => a + b, 0);
      expect(sum).toBe(10);
      // 前三维各 floor(10/4)=2，最后一维吃掉剩余 4
      expect(r.amounts).toEqual([2, 2, 2, 4]);
    }
  });

  it("配比为 0 的属性分不到点", () => {
    const r = planAllocation({
      mode: "ratio",
      unspent: 10,
      invested: [0, 0, 0, 0],
      ratio: [0, 1, 0, 1],
      targets: null,
      primary: 1,
      autoReset: false,
      minPoints: 1,
    });
    if ("amounts" in r) {
      expect(r.amounts[0]).toBe(0);
      expect(r.amounts[2]).toBe(0);
      expect(r.amounts[1] + r.amounts[3]).toBe(10);
    }
  });

  it("配比无效时报错", () => {
    const r = planAllocation({
      mode: "ratio",
      unspent: 10,
      invested: [0, 0, 0, 0],
      ratio: null,
      targets: null,
      primary: 1,
      autoReset: false,
      minPoints: 1,
    });
    expect("error" in r).toBe(true);
  });
});

describe("planAllocation（target）", () => {
  const base = {
    mode: "target",
    invested: [0, 0, 0, 0],
    ratio: null,
    primary: 1,
    autoReset: false,
    minPoints: 1,
  };

  it("点数充裕时按缺口补齐", () => {
    const r = planAllocation({ ...base, unspent: 5000, targets: [0, 2000, 0, 100] });
    expect("amounts" in r && r.amounts).toEqual([0, 2000, 0, 100]);
    if ("amounts" in r) expect(r.notes.join()).toContain("溢出");
  });

  it("已达标时跳过（不浪费点数）", () => {
    const r = planAllocation({
      ...base,
      unspent: 100,
      invested: [0, 2000, 0, 100],
      targets: [0, 2000, 0, 100],
    });
    expect("skip" in r).toBe(true);
  });

  it("点数不足且无可搬运时按顺序尽量填，不超额", () => {
    const r = planAllocation({ ...base, unspent: 1500, targets: [0, 2000, 0, 100] });
    if ("amounts" in r) {
      expect(r.amounts.reduce((a, b) => a + b, 0)).toBe(1500);
      // 顺序填：先把智力填满 1500（缺口 2000），耐力还轮不到
      expect(r.amounts[1]).toBe(1500);
      expect(r.amounts[3]).toBe(0);
    }
  });

  it("需搬运但未开启洗点 → 跳过并说明原因", () => {
    // 已投入 力量 3000（超目标 0），目标需要智力 2000 → 需搬运
    const r = planAllocation({
      ...base,
      unspent: 100,
      invested: [3000, 0, 0, 0],
      targets: [0, 2000, 0, 0],
      autoReset: false,
    });
    expect("skip" in r).toBe(true);
    if ("skip" in r) expect(r.skip).toContain("搬运");
  });

  it("需搬运且开启洗点 → 返回重置信号", () => {
    const r = planAllocation({
      ...base,
      unspent: 100,
      invested: [3000, 0, 0, 0],
      targets: [0, 2000, 0, 0],
      autoReset: true,
    });
    expect("error" in r && r.error).toBe("__NEED_RESET__");
  });

  it("目标值无效时报错", () => {
    const r = planAllocation({ ...base, unspent: 100, targets: null });
    expect("error" in r).toBe(true);
  });
});

/* ==================== 装备分档 ==================== */

describe("bucketOf（装备分档）", () => {
  // 阶梯：common(0) uncommon(1) fine(2) rare(3) epic(4) legendary(5) mythic(6) exotic(7) arcane(8)
  const LEGENDARY = 5;

  it("低于阈值 → 卖", () => {
    for (const r of ["common", "uncommon", "fine", "rare", "epic"]) {
      expect(bucketOf(r, LEGENDARY, -1), r).toBe("sell");
    }
  });

  it("达到阈值且未开分解 → 保留", () => {
    for (const r of ["legendary", "mythic", "exotic", "arcane"]) {
      expect(bucketOf(r, LEGENDARY, -1), r).toBe("keep");
    }
  });

  it("★ 只有传说/神话/奇异可分解；奥秘落在分解档也必须保留（否则等于凭空销毁）", () => {
    // 分解到 exotic(7)：传说、神话、奇异可分解
    expect(bucketOf("legendary", LEGENDARY, 7)).toBe("dismantle");
    expect(bucketOf("mythic", LEGENDARY, 7)).toBe("dismantle");
    expect(bucketOf("exotic", LEGENDARY, 7)).toBe("dismantle");
    // 奥秘(8) 超出分解上限 → 保留
    expect(bucketOf("arcane", LEGENDARY, 7)).toBe("keep");
  });

  it("分解上限低于出售阈值时等价于不分解", () => {
    expect(bucketOf("legendary", LEGENDARY, LEGENDARY - 1)).toBe("keep");
  });

  it("未知稀有度一律保留（安全侧）", () => {
    expect(bucketOf("unknown", LEGENDARY, 7)).toBe("keep");
    expect(bucketOf(undefined, LEGENDARY, 7)).toBe("keep");
    expect(bucketOf(null, LEGENDARY, -1)).toBe("keep");
  });

  it("把出售阈值调到最低时不卖任何东西", () => {
    for (const r of ["common", "legendary", "arcane"]) {
      expect(bucketOf(r, 0, -1), r).toBe("keep");
    }
  });
});

/* ==================== 自动切图：优先级与评分 ==================== */

describe("parsePriorities", () => {
  it("解析三项顺序", () => {
    expect(parsePriorities("golden,competition,experience")).toEqual(["golden", "competition", "experience"]);
  });

  it("★ 无论怎么写，结果都一定三项齐全且不重复（顺序才是配置项本身）", () => {
    expect(parsePriorities("experience")).toEqual(["experience", "competition", "golden"]);
    expect(parsePriorities("golden,golden,experience")).toEqual(["golden", "experience", "competition"]);
    expect(parsePriorities("")).toEqual(DEFAULT_PRIORITIES);
    expect(parsePriorities(undefined)).toEqual(DEFAULT_PRIORITIES);
    expect(parsePriorities("看心情")).toEqual(DEFAULT_PRIORITIES);
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

  it("每个模块的字符串字段都有 label（前端表单靠它渲染）", () => {
    for (const def of MODULES) {
      for (const f of def.configSchema) {
        expect(f.label, `${def.id}.${f.key}`).toBeTruthy();
      }
    }
  });
});
