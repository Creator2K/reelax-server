// 经验速率：每小时多少经验
//
// ★ 为什么值得单测：这是用户判断「这样挂下去有没有意义」「刚换的图/饵是不是更划算」
//   的唯一量化依据。口径错了（样本太密就出结论、把升级当成负增长）会给出完全错误的预期。
//
// ★ v1.10 起数据源改成**终身累计经验**（单调递增）：本级经验每次升级都归零，
//   用它算速率会一直卡在"采样中"（升级很快），这正是用户报的问题。
import { describe, expect, it } from "vitest";
import { computeXpRate, XP_RATE_MIN_SPAN_MS, type XpSample } from "../src/game/xp-rate.ts";
import { buildStatusPanel } from "../src/modules/keep-online/status-panel.ts";

const MIN = 60_000;
const now = Date.parse("2026-10-14T12:00:00+08:00");

/** 生成一条采样（终身累计经验 + 当时的等级） */
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
    // 只有 1 分钟跨度（低于 2 分钟门槛）
    expect(computeXpRate([s(1, 100), s(0, 200)], now)).toBeNull();
    expect(XP_RATE_MIN_SPAN_MS).toBe(2 * MIN);
    // 刚好 2 分钟就给结果
    expect(computeXpRate([s(2, 100), s(0, 300)], now)?.perHour).toBeCloseTo(6_000, 0);
  });

  it("★ 跨升级照样给速率（用终身累计经验，升级不清零）", () => {
    const rate = computeXpRate(
      [
        s(20, 100_000, 10),
        s(10, 110_000, 11), // 中间升了一级：终身经验继续涨
        s(0, 120_000, 12),
      ],
      now,
    );
    expect(rate).not.toBeNull();
    // 20 分钟涨 20000 → 每小时 60000
    expect(rate!.perHour).toBeCloseTo(60_000, 0);
    expect(rate!.levelGain).toBe(2);
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

describe("状态面板接线（xpRate）", () => {
  const rate = { windowSec: 600, perHour: 36_000, samples: 3, levelGain: 1 };

  it("★ 面板原样给出「每小时经验」（不再算升级预计时间）", () => {
    const panel = buildStatusPanel({
      state: { run: { biomeId: "b_001" } },
      biomesById: new Map(),
      me: { player: { level: 812, experience: 2_000, experienceToNextLevel: 20_000 } },
      reincarnation: null,
      bait: null,
      xp: rate,
    });
    expect(panel.xpRate?.perHour).toBe(36_000);
    expect(panel.xpRate?.levelGain).toBe(1);
    // 面板只暴露 perHour / windowSec / samples / levelGain —— 没有 etaSec / remaining
    expect(Object.keys(panel.xpRate ?? {})).toEqual(["windowSec", "perHour", "samples", "levelGain"]);
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
