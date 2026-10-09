// 稀有鱼保底监控：快触发保底时切到指定地图，钓到后切回原图
//
// 协议：
//  - GET /api/statistics → pity: {
//        exotic: { hardPityCasts, currentDryCasts },   // 奇异鱼硬保底
//        arcane: { hardPityCasts, currentDryCasts },   // 奥秘鱼硬保底
//        effectiveLuck, luckTier, baitId, weatherId
//      }
//  - GET /api/giomes → 找目标地图 id
//  - PUT /api/player/current-biome { biomeId }        换图（免费）
//
// 硬保底含义：连续 currentDryCasts 杆没出目标稀有度，累计到 hardPityCasts 时必出。
//   hardPityCasts 会随运气/鱼饵/天气变化（不是固定值），所以每轮都要重新读。
//
// 工作流：
//   1. 读保底进度，算「还差多少杆」
//   2. 还差 <= 阈值 且当前不在目标地图 → 切到目标地图，记住原地图
//   3. 已经在目标地图且钓到了（dry 计数骤降 / 累计减少）→ 切回原地图
//   4. 被切走但也钓到了 → 同样切回原图
//
// 与官方航线助手：本模块也是"换图"，因此与助手的「自动换图」是硬冲突 —— 拒绝启动。

/** 从 /api/statistics 的 pity 结构里算保底进度 */
export type PityProgress = {
  /** 目标稀有度 */
  rarity: "exotic" | "arcane";
  /** 保底总杆数（随条件变化） */
  totalCasts: number;
  /** 已经连空多少杆 */
  dryCasts: number;
  /** 还差多少杆触发保底 */
  remaining: number;
  /** 是否已达成（remaining === 0） */
  ready: boolean;
};

export function readPity(pity: any, rarity: "exotic" | "arcane"): PityProgress | null {
  const block = pity?.[rarity];
  if (!block) return null;
  const total = Number(block.hardPityCasts);
  const dry = Number(block.currentDryCasts);
  if (!Number.isFinite(total) || total <= 0) return null;
  const dryVal = Number.isFinite(dry) && dry > 0 ? dry : 0;
  const remaining = Math.max(0, total - dryVal);
  return {
    rarity,
    totalCasts: total,
    dryCasts: dryVal,
    remaining,
    ready: remaining === 0,
  };
}

/** 判断本轮是否「钓到了目标稀有度」——dry 计数比上一轮明显下降即视为钓到 */
export function didCatch(prev: PityProgress | null, cur: PityProgress | null): boolean {
  if (!prev || !cur) return false;
  // dry 变小 = 计数被重置 = 出了该稀有度（或出了更高档导致重置）
  return cur.dryCasts < prev.dryCasts;
}

export type PityDecision =
  | { action: "enter"; biomeId: string; reason: string }
  | { action: "return"; biomeId: string; reason: string }
  | { action: "stay"; reason: string };

/**
 * 决策（纯函数，便于单测）。
 *
 * @param opts.remaining     目标稀有度还差多少杆（null = 拿不到数据）
 * @param opts.threshold     提前多少杆开始切图
 * @param opts.currentBiome  当前地图 id
 * @param opts.targetBiome   指定的保底地图 id
 * @param opts.returnBiome   之前记住的「原地图」（null 表示没在保底流程里）
 * @param opts.caught        本轮是否钓到了目标稀有度
 */
export function decidePityAction(opts: {
  remaining: number | null;
  threshold: number;
  currentBiome: string | null;
  targetBiome: string;
  returnBiome: string | null;
  caught: boolean;
}): PityDecision {
  const { remaining, threshold, currentBiome, targetBiome, returnBiome, caught } = opts;

  // 在保底流程里：钓到了就切回原图
  if (returnBiome) {
    if (!caught) {
      return { action: "stay", reason: `已在保底地图，等待出货（原地图 ${returnBiome} 已记住）` };
    }
    // 已经回到原图了（或原图就是当前图）
    if (currentBiome === returnBiome) {
      return { action: "stay", reason: "已钓到目标稀有度，且已在原地图" };
    }
    return { action: "return", biomeId: returnBiome, reason: "已钓到目标稀有度，切回原地图" };
  }

  // 不在保底流程：判断要不要进入
  if (remaining === null) {
    return { action: "stay", reason: "读不到保底数据" };
  }
  if (remaining > threshold) {
    return { action: "stay", reason: `距保底还差 ${remaining} 杆（阈值 ${threshold}），继续等待` };
  }
  if (!targetBiome) {
    return { action: "stay", reason: "未配置保底地图" };
  }
  if (currentBiome === targetBiome) {
    // 已经在目标图，但由于 returnBiome 为空，说明是用户自己来的 —— 不接管
    return { action: "stay", reason: "已在保底地图（非本模块切换），不干预" };
  }
  return {
    action: "enter",
    biomeId: targetBiome,
    reason: `距保底还差 ${remaining} 杆，切到保底地图`,
  };
}
