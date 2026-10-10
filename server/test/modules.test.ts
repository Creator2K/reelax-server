// 模块纯函数单测
//
// 这些函数是各模块的「决策大脑」，抽出来是为了能脱离网络单独验证：
// 加点方案、装备分档、选图评分。算错任何一个都会静默做错事
// （加错点、卖错装备、把号从比赛图拽走），所以必须有测试。
import { describe, expect, it } from "vitest";
import { MODULES, assertRegistryValid } from "../src/modules/registry.ts";
import { investedOf, parseRatio, parseTargets, planAllocation } from "../src/modules/auto-stats/index.ts";
import { bucketOf } from "../src/modules/auto-sell-gear/index.ts";
import { describeBiome, pickBest, primaryScore, valueWeight, xpWeight } from "../src/modules/auto-travel/index.ts";

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

/* ==================== 自动切图评分 ==================== */

describe("xpWeight / valueWeight", () => {
  it("经验权重 = (1 + 专精 + 公会) × (1 + 天气%)", () => {
    const biome = {
      masteryXpBonusBasisPoints: 3150, // +31.5%
      guildXpBonusBasisPoints: 5000, // +50%
      weather: { effect: "+20% 经验" },
    };
    // (1 + 0.315 + 0.5) × 1.2 = 2.178
    expect(xpWeight(biome)).toBeCloseTo(2.178, 6);
  });

  it("★ 专精与公会经验必须计入（旧版漏掉导致「经验优先」选错图）", () => {
    const withBonuses = { masteryXpBonusBasisPoints: 10_000, guildXpBonusBasisPoints: 0, weather: { effect: "" } };
    const withoutBonuses = { masteryXpBonusBasisPoints: 0, guildXpBonusBasisPoints: 0, weather: { effect: "" } };
    expect(xpWeight(withBonuses)).toBeCloseTo(2, 6);
    expect(xpWeight(withoutBonuses)).toBeCloseTo(1, 6);
  });

  it("无天气文本时按 1 倍", () => {
    expect(xpWeight({ weather: {} })).toBeCloseTo(1, 6);
    expect(xpWeight({})).toBeCloseTo(1, 6);
  });

  it("鱼价值倍率缺失时按 1", () => {
    expect(valueWeight({ valueMultiplier: 1.4 })).toBe(1.4);
    expect(valueWeight({})).toBe(1);
  });
});

describe("primaryScore / pickBest", () => {
  const biomes = [
    { id: "cur", name: "当前", isCurrent: true, masteryXpBonusBasisPoints: 0, valueMultiplier: 1, weather: {} },
    {
      id: "xp",
      name: "经验图",
      masteryXpBonusBasisPoints: 5000,
      valueMultiplier: 1.1,
      weather: { effect: "+20% 经验" },
    },
    {
      id: "gold",
      name: "金币图",
      masteryXpBonusBasisPoints: 0,
      valueMultiplier: 2.0,
      weather: {},
    },
    {
      id: "goldwind",
      name: "金风图",
      masteryXpBonusBasisPoints: 0,
      valueMultiplier: 1.2,
      weather: { weatherId: "gilded_current", effect: "每杆直接金币区间 +300~500" },
    },
  ];

  it("experience 模式选经验权重最高的", () => {
    const best = pickBest("experience", biomes, "cur");
    expect(best?.id).toBe("xp");
  });

  it("gold 模式选鱼价值最高的", () => {
    const best = pickBest("gold", biomes, "cur");
    expect(best?.id).toBe("gold");
  });

  it("balanced 模式按 鱼价值 × 经验权重", () => {
    const best = pickBest("balanced", biomes, "cur");
    // xp: 1.1 × (1.5×1.2=1.8) = 1.98；gold: 2.0 × 1 = 2.0 → gold 略高
    expect(best?.id).toBe("gold");
  });

  it("排除当前地图", () => {
    const only = [biomes[0]];
    expect(pickBest("experience", only as any[], "cur")).toBeNull();
  });

  it("primaryScore 与模式对应", () => {
    expect(primaryScore("experience", biomes[1])).toBeCloseTo(xpWeight(biomes[1]), 6);
    expect(primaryScore("gold", biomes[2])).toBeCloseTo(2.0, 6);
    expect(primaryScore("balanced", biomes[2])).toBeCloseTo(2.0, 6);
  });

  it("★ 金风文本里没有「经验」二字，经验权重不应被它虚高", () => {
    // 金风只影响金币，不该让它在「经验优先」里胜出
    expect(xpWeight(biomes[3])).toBeCloseTo(1, 6);
  });
});

describe("describeBiome（日志可核对）", () => {
  it("包含鱼价值与经验倍率及分项", () => {
    const text = describeBiome({
      name: "熔潮环礁",
      valueMultiplier: 1.4,
      masteryXpBonusBasisPoints: 2100,
      guildXpBonusBasisPoints: 1100,
      weather: { effect: "+5% 经验" },
    });
    expect(text).toContain("熔潮环礁");
    expect(text).toContain("鱼价值×1.40");
    expect(text).toContain("专精+21%");
    expect(text).toContain("公会+11%");
    expect(text).toContain("天气+5%");
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
