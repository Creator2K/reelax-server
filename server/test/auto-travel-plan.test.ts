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
  it("三项齐全，缺的补在后面", () => {
    expect(parsePriorities("experience")).toEqual(["experience", "competition", "golden"]);
    expect(parsePriorities("golden,competition,experience")).toEqual(["golden", "competition", "experience"]);
  });

  it("认不出的项丢掉、重复的只留一次", () => {
    // "surge" 是 1.7.0 里短暂存在过的独立优先级：老配置读进来要能自动忽略
    expect(parsePriorities("surge,surge,nope,golden")).toEqual(["golden", "competition", "experience"]);
    expect(parsePriorities("competition,golden,surge,experience")).toEqual([
      "competition",
      "golden",
      "experience",
    ]);
    expect(parsePriorities("")).toEqual(DEFAULT_PRIORITIES);
  });

  it("每一项都有中文名（前端与日志共用）", () => {
    for (const p of DEFAULT_PRIORITIES) expect(PRIORITY_LABELS[p]).toBeTruthy();
  });

  it("下拉框只给 3 项的 6 种排列（涌流不在其中）", () => {
    const field = autoTravel.configSchema.find((f) => f.key === "priorities");
    expect(field?.type).toBe("select");
    if (field?.type === "select") {
      expect(field.options).toHaveLength(6);
      for (const o of field.options) expect(o.label).not.toContain("涌流");
    }
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
