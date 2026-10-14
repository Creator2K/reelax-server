// 经验速率：把「每小时的多少经验」和「还差多久升级」算出来（纯函数，可单测）
//
// ★ 为什么需要它：等级 / 经验进度只告诉用户「现在离下一级多远」，
//   回答不了「这样挂下去到底多久能升级」「刚换了图/饵之后经验是变快还是变慢」。
//   有了速率，这些都能一眼看出来（也是判断某次改动是否有效的唯一量化依据）。
//
// 采样与折算口径：
//  · 只在**同一等级内**折算速率：升级会让「本级经验」归零，跨级算差值会得到负数；
//  · 窗口默认 30 分钟，且至少要有 5 分钟的跨度才给结论 —— 否则两三个样本能算出离谱的速率；
//  · 样本不足 / 经验回退（换号、转生等）时返回 null，界面显示「采样中」，绝不猜一个数字。

/** 采样窗口：30 分钟 */
export const XP_RATE_WINDOW_MS = 30 * 60_000;
/** 至少要有这么长的跨度才给速率（否则样本太密、噪声大） */
export const XP_RATE_MIN_SPAN_MS = 5 * 60_000;
/** 两次采样之间至少间隔这么久（避免每几秒就塞一条） */
export const XP_SAMPLE_MIN_GAP_MS = 30_000;

/** 一条经验采样：本级经验 + 当时的等级 */
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

/** 面板用的形状：速率 + 「还差多少 / 还要多久」 */
export type XpRateView = XpRate & {
  /** 距下一级还差多少经验（拿不到为 null） */
  remaining: number | null;
  /** 按当前速率估算的升级所需秒数（无法估算为 null，已经满了为 0） */
  etaSec: number | null;
};

/**
 * 由采样序列算出速率。
 *
 * 返回 null 的情形：样本不足、跨度太短、经验回退（异常数据）。
 */
export function computeXpRate(samples: XpSample[], now = Date.now()): XpRate | null {
  const win = samples.filter((s) => s && Number.isFinite(s.t) && now - s.t <= XP_RATE_WINDOW_MS);
  if (win.length < 2) return null;

  const last = win[win.length - 1]!;

  // 只取「最后一次升级之后」的样本：跨级差值会把经验归零算成负增长
  let startIdx = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    if (win[i]!.level !== last.level) {
      startIdx = i + 1;
      break;
    }
  }
  const tail = win.slice(startIdx);
  if (tail.length < 2) return null;

  const first = tail[0]!;
  const spanMs = last.t - first.t;
  if (spanMs < XP_RATE_MIN_SPAN_MS) return null;

  const gained = last.xp - first.xp;
  if (!Number.isFinite(gained) || gained < 0) return null; // 数据异常（换号 / 回档）时不给速率

  return {
    windowSec: Math.round(spanMs / 1000),
    perHour: (gained / spanMs) * 3_600_000,
    samples: tail.length,
    levelGain: Math.max(0, last.level - win[0]!.level),
  };
}

/** 把速率与「本级经验 / 下一级所需」拼成展示用的形状 */
export function withLevelEta(
  rate: XpRate | null | undefined,
  experience: number | null | undefined,
  experienceToNextLevel: number | null | undefined,
): XpRateView | null {
  if (!rate) return null;

  const exp = Number(experience);
  const next = Number(experienceToNextLevel);
  const known = Number.isFinite(exp) && Number.isFinite(next) && next > 0;
  const remaining = known ? Math.max(0, next - exp) : null;

  let etaSec: number | null = null;
  if (remaining === 0) etaSec = 0;
  else if (remaining != null && rate.perHour > 0) etaSec = Math.round((remaining / rate.perHour) * 3600);

  return { ...rate, remaining, etaSec };
}
