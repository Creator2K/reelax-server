// 自动切图：纯函数决策（优先级解析 / 选「已解锁的最高地图」/ 涌流处理）
//
// ★ 涌流**不是**独立优先级：它是覆盖所有地图的全局天气，各图加成完全相同，排序没有意义。
//   它由「经验」优先级在内部处理 —— 否则「经验」的比大小只能靠 id 兜底，
//   涌流期间会把待在高级图的人拽去等级最低的新手图。
import { describe, expect, it } from "vitest";
import autoTravel, {
  DEFAULT_PRIORITIES,
  PRIORITY_LABELS,
  parsePriorities,
  pickHighestUnlocked,
  planTravel,
  type Priority,
} from "../src/modules/auto-travel/index.ts";

const HOME = { id: "b_001", name: "月落溪谷", valueMultiplier: 1, requiredLevel: 0, weather: { weatherId: "clear" } };
const MID = { id: "b_005", name: "星根洞窟", valueMultiplier: 1.2, requiredLevel: 350, weather: { weatherId: "clear" } };
const TOP = { id: "b_009", name: "极昼冰湾", valueMultiplier: 1.4, requiredLevel: 2000, weather: { weatherId: "clear" } };
/** 天气最好但地图等级低（用途：验证「经验」与「涌流」选的是不同的图） */
const STORM = { id: "b_002", name: "雾语湿地", valueMultiplier: 1.05, requiredLevel: 50, weather: { weatherId: "tempest" } };

const surge = (b: typeof HOME) => ({ ...b, weather: { weatherId: "arcane_surge" } });

describe("自动切图 · 优先级解析", () => {
  it("★ 顺序原样保留，不再自动补齐缺失的项（放几项由用户决定）", () => {
    expect(parsePriorities("experience")).toEqual(["experience"]);
    expect(parsePriorities(["golden", "competition"])).toEqual(["golden", "competition"]);
    expect(parsePriorities("golden,competition,experience,follow")).toEqual([
      "golden",
      "competition",
      "experience",
      "follow",
    ]);
  });

  it("认不出的项丢掉、重复的只留一次、空值用默认顺序", () => {
    // "surge" 是 1.7.0 里短暂存在过的独立优先级：老配置读进来要能自动忽略
    expect(parsePriorities("surge,surge,nope,golden")).toEqual(["golden"]);
    expect(parsePriorities("competition,golden,surge,experience")).toEqual([
      "competition",
      "golden",
      "experience",
    ]);
    expect(parsePriorities("")).toEqual(DEFAULT_PRIORITIES);
    expect(parsePriorities([])).toEqual(DEFAULT_PRIORITIES);
    expect(parsePriorities(null)).toEqual(DEFAULT_PRIORITIES);
  });

  it("1.7.x 的独立开关 fleetMode 由配置升级换算（这里不再有运行时兼容分支）", () => {
    // 运行时兼容会让旧键永久生效（用户删掉「跟船队走」也会被加回来），
    // 所以换算只在 modules/config-upgrades.ts 里做一次 —— 见 config-upgrades.test.ts
    expect(autoTravel.configSchema.some((f) => f.key === "fleetMode")).toBe(false);
    expect(parsePriorities("golden")).toEqual(["golden"]);
  });

  it("候选项：4 项且含「跟船队走」，不再是排列组合的下拉框", () => {
    const field = autoTravel.configSchema.find((f) => f.key === "priorities");
    expect(field?.type).toBe("order");
    if (field?.type === "order") {
      expect(field.options.map((o) => o.value)).toEqual(["competition", "golden", "experience", "follow"]);
      expect(field.default).toEqual(["competition", "golden", "experience"]);
    }
    // 旧开关已并入列表，不再是独立配置项
    expect(autoTravel.defaultConfig.fleetMode).toBeUndefined();
    expect(autoTravel.configSchema.some((f) => f.key === "fleetMode")).toBe(false);
  });

  it("每一项都有中文名（前端与日志共用）", () => {
    for (const p of DEFAULT_PRIORITIES) expect(PRIORITY_LABELS[p]).toBeTruthy();
    expect(PRIORITY_LABELS.follow).toBe("跟船队走");
  });
});

describe("自动切图 · 「跟船队走」也参与排序", () => {
  const unlocked = [HOME, MID, TOP];
  const base = {
    priorities: ["follow", "experience"] as Priority[],
    unlocked,
    currentBiomeId: "b_001",
    competition: null,
    minImprovePct: 0,
  };

  it("★ 在船队里 → 跟船队走（本模块不换图）", () => {
    const d = planTravel({
      ...base,
      party: { inParty: true, boatName: "芦汐轻舟", boatBiomeName: "星根洞窟", sameAsCurrent: false },
    });
    expect(d.action).toBe("follow");
    if (d.action === "follow") {
      expect(d.why).toContain("芦汐轻舟");
      expect(d.why).toContain("星根洞窟");
      expect(d.why).toContain("不自行换图");
    }
  });

  it("★ 没加入船队 → 这一项没有候选，跳过它继续看后面的经验", () => {
    const d = planTravel({
      ...base,
      unlocked: [HOME, STORM, TOP],
      party: { inParty: false },
    });
    expect(d).toMatchObject({ action: "travel", biomeId: "b_002", reason: "experience" });
  });

  it("船队状态拿不到（接口失败）时同样跳过，不会卡住不换图", () => {
    const d = planTravel({ ...base, unlocked: [HOME, STORM, TOP], party: null });
    expect(d).toMatchObject({ action: "travel", biomeId: "b_002", reason: "experience" });
  });

  it("★ 放在「经验」后面不会生效（经验在任何图上都有候选）—— 这是文档化的行为", () => {
    const d = planTravel({
      priorities: ["experience", "follow"] as Priority[],
      unlocked: [HOME, MID, TOP],
      currentBiomeId: "b_009", // 已经是「天气相同里鱼价值最高」的那张 → 经验这一项结论是 stay
      competition: null,
      minImprovePct: 0,
      party: { inParty: true, boatName: "芦汐轻舟", boatBiomeName: "星渊圣海", sameAsCurrent: true },
    });
    // 经验先命中「当前已最优」→ 终局；想让它兜底必须把 follow 挪到经验前面
    expect(d).toMatchObject({ action: "stay", reason: "experience" });
  });

  it("排在最后且没船队时，仍然会按天气换图（不会像旧的 follow 模式那样彻底不动）", () => {
    const d = planTravel({
      priorities: ["experience", "follow"] as Priority[],
      unlocked: [HOME, STORM, TOP],
      currentBiomeId: "b_001",
      competition: null,
      minImprovePct: 0,
      party: { inParty: false },
    });
    expect(d).toMatchObject({ action: "travel", biomeId: "b_002", reason: "experience" });
  });

  it("只留「跟船队走」一项时，没船队 → 没有可去的地图", () => {
    const d = planTravel({ ...base, priorities: ["follow"] as Priority[], party: { inParty: false } });
    expect(d).toMatchObject({ action: "stay", reason: null });
    if (d.action === "stay") expect(d.why).toContain("没有可去的地图");
  });
});

describe("自动切图 · 天气相同就看鱼价值（经验优先级）", () => {
  // 两张雷暴图（天气倍率一样），鱼的等级 / 价值不同
  const STORM_LOW = { id: "b_004", name: "雷痕峡湾", valueMultiplier: 1.15, weather: { weatherId: "tempest" } };
  const STORM_HIGH = { id: "b_012", name: "熔潮环礁", valueMultiplier: 1.55, weather: { weatherId: "tempest" } };
  // 天气更好但价值明显更低的反例素材（强风 ×1.10）
  const RICH_WIND = { id: "b_015", name: "星渊圣海", valueMultiplier: 1.7, weather: { weatherId: "gale" } };

  const plan = (input: {
    unlocked: any[];
    currentBiomeId: string;
    minImprovePct?: number;
  }) =>
    planTravel({
      priorities: ["experience"] as Priority[],
      unlocked: input.unlocked,
      currentBiomeId: input.currentBiomeId,
      competition: null,
      minImprovePct: input.minImprovePct ?? 3,
    });

  it("★ 两张都是雷暴：去**鱼价值更高**的那张，而不是 id 最小的", () => {
    // 旧版按 id 兜底 → 会选 b_004（雷痕峡湾，价值 1.15）
    const d = plan({ unlocked: [HOME, STORM_LOW, STORM_HIGH], currentBiomeId: "b_001" });
    expect(d).toMatchObject({ action: "travel", biomeId: "b_012", reason: "experience" });
  });

  it("★ 已经在低价值那张雷暴图 → 换到高价值的那张（天气提升 0% 也动）", () => {
    const d = plan({ unlocked: [STORM_LOW, STORM_HIGH], currentBiomeId: "b_004" });
    expect(d).toMatchObject({ action: "travel", biomeId: "b_012", reason: "experience" });
    if (d.action === "travel") expect(d.why).toContain("鱼价值");
  });

  it("已经站在价值最高的雷暴图 → 不动（不会来回横跳）", () => {
    const d = plan({ unlocked: [STORM_LOW, STORM_HIGH], currentBiomeId: "b_012" });
    expect(d).toMatchObject({ action: "stay", reason: "experience" });
  });

  it("★ 天气仍然是第一优先：价值低但天气更好的图照样去", () => {
    // 当前是价值最高的图（1.7）但只有强风 ×1.10；别处雷暴 ×1.50（价值 1.55）→ 依然去雷暴图
    const d = plan({ unlocked: [RICH_WIND, STORM_LOW, STORM_HIGH], currentBiomeId: "b_015" });
    expect(d).toMatchObject({ action: "travel", biomeId: "b_012", reason: "experience" });
    if (d.action === "travel") expect(d.why).toContain("天气经验更优");
  });

  it("天气提升没过迟滞门槛 → 不动（回归：避免天气小幅波动时来回横跳）", () => {
    const RAIN = { id: "b_001", name: "月落溪谷", valueMultiplier: 1, weather: { weatherId: "rain" } }; // 1.05
    const GALE = { id: "b_005", name: "星根洞窟", valueMultiplier: 1.2, weather: { weatherId: "gale" } }; // 1.10
    const d = plan({ unlocked: [RAIN, GALE], currentBiomeId: "b_001", minImprovePct: 10 });
    expect(d).toMatchObject({ action: "stay", reason: "experience" });
    if (d.action === "stay") expect(d.why).toContain("迟滞门槛");
  });
});

describe("自动切图 · 已解锁的最高地图", () => {
  it("按鱼价值倍率取最高的那张", () => {
    expect(pickHighestUnlocked([HOME, MID, TOP])?.id).toBe("b_009");
  });

  it("倍率缺失时按所需等级、再按内置地图表顺序", () => {
    const noMult = [
      { id: "b_003", name: "镜潮海岸", requiredLevel: 100 },
      { id: "b_007", name: "云汐悬湖", requiredLevel: 750 },
    ];
    expect(pickHighestUnlocked(noMult)?.id).toBe("b_007");

    const noInfo = [{ id: "b_003" }, { id: "b_011" }];
    // 内置表里 b_011 更靠后 = 更高级
    expect(pickHighestUnlocked(noInfo)?.id).toBe("b_011");
  });

  it("倍率相同时按内置表里的等级高低，表里都不认识才按 id 取最小（结果稳定）", () => {
    // 倍率都是 1，但 b_004（雷痕峡湾）在表里比 b_002（雾语湿地）靠后 = 更高级
    const same = [
      { id: "b_004", valueMultiplier: 1 },
      { id: "b_002", valueMultiplier: 1 },
    ];
    expect(pickHighestUnlocked(same)?.id).toBe("b_004");

    const unknown = [
      { id: "b_x9", valueMultiplier: 1 },
      { id: "b_x2", valueMultiplier: 1 },
    ];
    expect(pickHighestUnlocked(unknown)?.id).toBe("b_x2");
  });

  it("空列表返回 null", () => {
    expect(pickHighestUnlocked([])).toBeNull();
  });
});

describe("自动切图 · 涌流（由「经验」优先级处理，不是独立一项）", () => {
  const base = {
    priorities: ["experience"] as Priority[],
    currentBiomeId: "b_001",
    competition: null,
    minImprovePct: 0,
  };

  it("★ 涌流期间去指定的地图", () => {
    const d = planTravel({
      ...base,
      unlocked: [surge(HOME), surge(MID), surge(TOP)],
      surgeBiomeId: "b_005",
    });
    expect(d).toMatchObject({ action: "travel", biomeId: "b_005", reason: "experience" });
  });

  it("★ 没指定（留空）→ 去已解锁的最高地图，而不是 id 最小的新手图", () => {
    const d = planTravel({ ...base, unlocked: [surge(HOME), surge(MID), surge(TOP)], surgeBiomeId: "" });
    expect(d).toMatchObject({ action: "travel", biomeId: "b_009", reason: "experience" });
    if (d.action === "travel") expect(d.why).toContain("涌流");
  });

  it("指定的图还没解锁 → 退回最高地图，并在理由里说明", () => {
    const d = planTravel({
      ...base,
      unlocked: [surge(HOME), surge(MID)],
      currentBiomeId: "b_001",
      surgeBiomeId: "b_009",
    });
    expect(d).toMatchObject({ action: "travel", biomeId: "b_005", reason: "experience" });
    if (d.action === "travel") expect(d.why).toContain("未解锁");
  });

  it("★ 已经在涌流目标图 → 不动（不会来回横跳）", () => {
    const d = planTravel({ ...base, unlocked: [surge(HOME), surge(TOP)], currentBiomeId: "b_009", surgeBiomeId: "" });
    expect(d).toMatchObject({ action: "stay", reason: "experience" });
  });

  it("★ 没有涌流时不看涌流目标：照常按天气经验挑", () => {
    const d = planTravel({
      ...base,
      unlocked: [HOME, STORM, TOP],
      currentBiomeId: "b_001",
      surgeBiomeId: "b_009",
    });
    // 雷暴 ×1.5 的天气经验比晴空 ×1.0 高 → 去天气图，而不是配置的涌流目标 b_009
    expect(d).toMatchObject({ action: "travel", biomeId: "b_002", reason: "experience" });
  });

  it("涌流只在有比赛 / 金风候选时才被让位（优先级顺序不变）", () => {
    const d = planTravel({
      ...base,
      priorities: ["golden", "experience"] as Priority[],
      unlocked: [surge(HOME), { ...surge(TOP), weather: { weatherId: "gilded_current" } }],
      currentBiomeId: "b_001",
      surgeBiomeId: "",
    });
    // 金风排第一 → 先去金风图，涌流目标（b_001 已解锁且倍率最高的其实是 b_009…）不参与
    expect(d).toMatchObject({ action: "travel", biomeId: "b_009", reason: "golden" });
  });
});
