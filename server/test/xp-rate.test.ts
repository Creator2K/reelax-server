// 经验速率：每小时多少经验、还差多久升级
//
// ★ 为什么值得单测：这两个数字是用户判断「这样挂下去有没有意义」「刚换的图/饵是不是更划算」
//   的唯一量化依据。口径错了（比如把升级时的经验归零当成负增长、或样本太密就出结论）
//   会给出完全错误的预期，比不显示更糟。
import { describe, expect, it } from "vitest";
import {
  computeXpRate,
  withLevelEta,
  XP_RATE_MIN_SPAN_MS,
  type XpSample,
} from "../src/game/xp-rate.ts";
import { buildStatusPanel } from "../src/modules/keep-online/status-panel.ts";

const MIN = 60_000;
const now = Date.parse("2026-10-14T12:00:00+08:00");

/** 生成一条采样 */
const s = (minutesAgo: number, xp: number, level = 10): XpSample => ({
  t: now - minutesAgo * MIN,
  xp,
  level,
});

describe("computeXpRate", () => {
  it("★ 按窗口内的实际增量折算每小时经验", () => {
    // 10 分钟涨了 6000 → 每小时 36000
    const rate = computeXpRate([s(10, 1_000), s(5, 4_000), s(0, 7_000)], now);
    expect(rate).not.toBeNull();
    expect(rate!.perHour).toBeCloseTo(36_000, 0);
    expect(rate!.windowSec).toBe(600);
    expect(rate!.samples).toBe(3);
    expect(rate!.levelGain).toBe(0);
  });

  it("样本不足 / 跨度太短 → null（界面显示「采样中」，不猜数字）", () => {
    expect(computeXpRate([], now)).toBeNull();
    expect(computeXpRate([s(1, 100)], now)).toBeNull();
    // 只有 2 分钟跨度（低于 5 分钟门槛）
    expect(computeXpRate([s(2, 100), s(0, 200)], now)).toBeNull();
    expect(XP_RATE_MIN_SPAN_MS).toBe(5 * MIN);
  });

  it("★ 升级（本级经验归零）不会算成负增长：只用升级之后的样本", () => {
    const rate = computeXpRate(
      [
        s(13, 900, 10),
        s(12, 990, 10),
        s(7, 10, 11), // 升级后重来
        s(1, 310, 11),
      ],
      now,
    );
    expect(rate).not.toBeNull();
    // 6 分钟涨 300 → 每小时 3000
    expect(rate!.perHour).toBeCloseTo(3_000, 0);
    expect(rate!.levelGain).toBe(1); // 窗口内升了 1 级
  });

  it("经验回退（换号 / 回档）→ null，不给离谱的速率", () => {
    expect(computeXpRate([s(10, 5_000), s(0, 1_000)], now)).toBeNull();
  });

  it("窗口外的老样本不参与计算", () => {
    const rate = computeXpRate([s(120, 0), s(8, 1_000), s(2, 4_000)], now);
    expect(rate).not.toBeNull();
    // 只用 8 分钟 → 2 分钟这两条：6 分钟涨 3000 → 30000/时
    expect(rate!.perHour).toBeCloseTo(30_000, 0);
    expect(rate!.samples).toBe(2);
  });
});

describe("withLevelEta", () => {
  const rate = { windowSec: 600, perHour: 36_000, samples: 3, levelGain: 0 };

  it("★ 剩余经验 ÷ 速率 = 升级预计时间", () => {
    // 还差 18000（= 半小时）
    const v = withLevelEta(rate, 2_000, 20_000);
    expect(v).not.toBeNull();
    expect(v!.remaining).toBe(18_000);
    expect(v!.etaSec).toBe(1_800);
  });

  it("本级经验已满 → 剩余 0、预计时间 0", () => {
    const v = withLevelEta(rate, 20_000, 20_000);
    expect(v!.remaining).toBe(0);
    expect(v!.etaSec).toBe(0);
  });

  it("拿不到本级经验 / 速率为 0 时不瞎估（etaSec 为 null）", () => {
    expect(withLevelEta(rate, null, null)!.remaining).toBeNull();
    expect(withLevelEta(rate, null, null)!.etaSec).toBeNull();
    expect(withLevelEta({ ...rate, perHour: 0 }, 100, 1_000)!.etaSec).toBeNull();
  });

  it("没有速率 → null", () => {
    expect(withLevelEta(null, 100, 1_000)).toBeNull();
  });
});

describe("状态面板接线（xpRate）", () => {
  const rate = { windowSec: 600, perHour: 36_000, samples: 3, levelGain: 0 };

  it("★ 面板给出每小时经验与升级预计时间", () => {
    const panel = buildStatusPanel({
      state: { run: { biomeId: "b_001" } },
      biomesById: new Map(),
      me: { player: { level: 812, experience: 2_000, experienceToNextLevel: 20_000 } },
      reincarnation: null,
      bait: null,
      xp: rate,
    });
    expect(panel.xpRate?.perHour).toBe(36_000);
    expect(panel.xpRate?.remaining).toBe(18_000);
    expect(panel.xpRate?.etaSec).toBe(1_800);
  });

  it("没有速率数据时为 null（界面显示「采样中」）", () => {
    const panel = buildStatusPanel({
      state: { run: { biomeId: "b_001" } },
      biomesById: new Map(),
      me: { player: { level: 812, experience: 2_000, experienceToNextLevel: 20_000 } },
      reincarnation: null,
      bait: null,
    });
    expect(panel.xpRate).toBeNull();
  });
});
