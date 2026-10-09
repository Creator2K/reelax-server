// 保底切图决策单测
//
// 这是「看保底快到了就切图、钓到再切回」的核心逻辑，抽成纯函数便于验证。
// 判错会导致账号被永久留在错误的地图上，所以逐条覆盖。
import { describe, expect, it } from "vitest";
import { decidePityAction, didCatch, readPity } from "../src/modules/auto-pity/decide.ts";

describe("readPity", () => {
  it("解析奇异 / 奥秘保底进度", () => {
    const pity = {
      exotic: { hardPityCasts: 500, currentDryCasts: 480 },
      arcane: { hardPityCasts: 1200, currentDryCasts: 1180 },
    };
    expect(readPity(pity, "exotic")).toEqual({
      rarity: "exotic",
      totalCasts: 500,
      dryCasts: 480,
      remaining: 20,
      ready: false,
    });
    expect(readPity(pity, "arcane")?.remaining).toBe(20);
  });

  it("remaining 为 0 时 ready 为 true", () => {
    const p = readPity({ arcane: { hardPityCasts: 100, currentDryCasts: 100 } }, "arcane");
    expect(p?.remaining).toBe(0);
    expect(p?.ready).toBe(true);
  });

  it("dry 超过 total 时 remaining 不为负", () => {
    const p = readPity({ arcane: { hardPityCasts: 100, currentDryCasts: 130 } }, "arcane");
    expect(p?.remaining).toBe(0);
  });

  it("缺数据 / 非法值时返回 null", () => {
    expect(readPity(null, "arcane")).toBeNull();
    expect(readPity({}, "arcane")).toBeNull();
    expect(readPity({ arcane: {} }, "arcane")).toBeNull();
    expect(readPity({ arcane: { hardPityCasts: 0 } }, "arcane")).toBeNull();
    expect(readPity({ arcane: { hardPityCasts: -5 } }, "arcane")).toBeNull();
  });

  it("currentDryCasts 缺失或负数按 0 处理", () => {
    expect(readPity({ arcane: { hardPityCasts: 100 } }, "arcane")?.dryCasts).toBe(0);
    expect(readPity({ arcane: { hardPityCasts: 100, currentDryCasts: -3 } }, "arcane")?.dryCasts).toBe(0);
    expect(readPity({ arcane: { hardPityCasts: 100 } }, "arcane")?.remaining).toBe(100);
  });
});

describe("didCatch（用 dry 计数下降判定出货）", () => {
  const mk = (dry: number) => ({ rarity: "arcane" as const, totalCasts: 100, dryCasts: dry, remaining: 100 - dry, ready: false });

  it("dry 变小 = 出了货（计数被重置）", () => {
    expect(didCatch(mk(95), mk(0))).toBe(true);
    expect(didCatch(mk(95), mk(3))).toBe(true);
  });

  it("dry 变大或不变 = 没出货", () => {
    expect(didCatch(mk(90), mk(91))).toBe(false);
    expect(didCatch(mk(90), mk(90))).toBe(false);
  });

  it("缺任一侧数据时判定为没出货（安全侧，不会误切回）", () => {
    expect(didCatch(null, mk(0))).toBe(false);
    expect(didCatch(mk(90), null)).toBe(false);
    expect(didCatch(null, null)).toBe(false);
  });
});

describe("decidePityAction", () => {
  const base = {
    threshold: 30,
    currentBiome: "b_001",
    targetBiome: "b_015",
    returnBiome: null as string | null,
    caught: false,
  };

  it("距保底还远 → 不动", () => {
    const d = decidePityAction({ ...base, remaining: 500 });
    expect(d.action).toBe("stay");
  });

  it("★ 距保底进入阈值 → 切到保底地图", () => {
    const d = decidePityAction({ ...base, remaining: 30 });
    expect(d.action).toBe("enter");
    if (d.action === "enter") expect(d.biomeId).toBe("b_015");
  });

  it("刚好等于阈值也切（边界含等号）", () => {
    expect(decidePityAction({ ...base, remaining: 30 }).action).toBe("enter");
  });

  it("超阈值一杆就不切", () => {
    expect(decidePityAction({ ...base, remaining: 31 }).action).toBe("stay");
  });

  it("已在保底流程且没出货 → 留在原地", () => {
    const d = decidePityAction({ ...base, remaining: 10, currentBiome: "b_015", returnBiome: "b_001", caught: false });
    expect(d.action).toBe("stay");
  });

  it("★ 在保底流程里出货 → 切回原地图", () => {
    const d = decidePityAction({ ...base, remaining: 0, currentBiome: "b_015", returnBiome: "b_001", caught: true });
    expect(d.action).toBe("return");
    if (d.action === "return") expect(d.biomeId).toBe("b_001");
  });

  it("出货后已经回到原图 → 无需再切（视为结束）", () => {
    const d = decidePityAction({ ...base, remaining: 0, currentBiome: "b_001", returnBiome: "b_001", caught: true });
    expect(d.action).toBe("stay");
  });

  it("★ 用户自己就在目标图时不接管（不会把它误切回去）", () => {
    // returnBiome 为空说明不是本模块切过来的
    const d = decidePityAction({ ...base, remaining: 5, currentBiome: "b_015", returnBiome: null, caught: false });
    expect(d.action).toBe("stay");
    if (d.action === "stay") expect(d.reason).toContain("不干预");
  });

  it("读不到保底数据 → 不动", () => {
    expect(decidePityAction({ ...base, remaining: null }).action).toBe("stay");
  });

  it("未配置目标地图 → 不动", () => {
    const d = decidePityAction({ ...base, remaining: 5, targetBiome: "" });
    expect(d.action).toBe("stay");
    if (d.action === "stay") expect(d.reason).toContain("未配置");
  });

  it("阈值可调：更小的阈值更晚才切", () => {
    expect(decidePityAction({ ...base, remaining: 10, threshold: 5 }).action).toBe("stay");
    expect(decidePityAction({ ...base, remaining: 5, threshold: 5 }).action).toBe("enter");
  });

  it("return 分支优先于 enter（保底流程未结束时不重复进入）", () => {
    // 即使 remaining 又变大（例如换饵导致 hardPityCasts 变化），只要还在保底流程就不重入
    const d = decidePityAction({ ...base, remaining: 999, currentBiome: "b_015", returnBiome: "b_001", caught: false });
    expect(d.action).toBe("stay");
  });
});
