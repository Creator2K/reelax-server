// 经验速率：算出「每小时多少经验」（纯函数，可单测）
//
// ★ 数据源是**终身累计经验**（`/api/statistics` 的 `totals.fishingExperience`），
//   不是「本级经验」。原因：本级经验在升级时会归零，用它算速率就得跨级作废重来 ——
//   而升级很快，于是会一直停在"采样中"（用户实际遇到的就是这个）。
//   终身累计经验单调递增，升级不影响它，速率因此一直可用。
//
// 采样与折算口径：
//  · 窗口默认 30 分钟；至少要有 2 分钟跨度才给结论（否则两三个样本能算出离谱的速率）；
//  · 样本不足 / 经验回退（换号、回档）时返回 null，界面显示「采样中」，绝不猜一个数字。
export const XP_RATE_WINDOW_MS = 30 * 60_000;
/** 至少要有这么长的跨度才给速率（2 分钟：前几分钟就能看到数，之后越算越准） */
export const XP_RATE_MIN_SPAN_MS = 2 * 60_000;
/** 两次采样之间至少间隔这么久 */
export const XP_SAMPLE_MIN_GAP_MS = 60_000;

/** 一条经验采样：终身累计经验 + 当时的等级 */
export type XpSample = { t: number; xp: number; level: number };

export type XpRate = {
  /** 实际覆盖的时间跨度（秒）—— 界面上写「近 N 分钟」 */
  windowSec: number;
  /** 每小时经验 */
  perHour: number;
  /** 参与折算的样本数 */
  samples: number;
  /** 窗口内升了几级（0 = 没升级） */
  levelGain: number;
};

/**
 * 由采样序列算出速率。
 *
 * 返回 null 的情形：样本不足、跨度太短、数据回退（异常）。
 */
export function computeXpRate(samples: XpSample[], now = Date.now()): XpRate | null {
  const win = samples.filter((s) => s && Number.isFinite(s.t) && now - s.t <= XP_RATE_WINDOW_MS);
  if (win.length < 2) return null;

  const first = win[0]!;
  const last = win[win.length - 1]!;
  const spanMs = last.t - first.t;
  if (spanMs < XP_RATE_MIN_SPAN_MS) return null;

  const gained = last.xp - first.xp;
  if (!Number.isFinite(gained) || gained < 0) return null; // 换号 / 回档等异常数据，不给速率

  return {
    windowSec: Math.round(spanMs / 1000),
    perHour: (gained / spanMs) * 3_600_000,
    samples: win.length,
    // 升级很快，所以顺便报一下窗口内升了几级（终身经验不受升级影响）
    levelGain: Math.max(0, last.level - first.level),
  };
}
