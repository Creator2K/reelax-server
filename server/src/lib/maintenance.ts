// 维护任务的小逻辑（抽出来是为了能单测：index.ts 一被 import 就会启动服务）

/** 快照间隔：20 小时（比「每天一次」略短，容忍重启造成的时刻漂移） */
export const SNAPSHOT_INTERVAL_MS = 20 * 3_600_000;

/**
 * 现在是否该生成新的数据库快照。
 *
 * ★ 两个坑都踩过：
 *   1) 只看「今天是否已经做过」→ 进程频繁重启时永远不做（每次启动都重置判断）；
 *   2) 只挂在「每小时维护」上 → 活不过一小时的进程永远不做。
 *   所以判断依据是「距上次快照够不够久」，而 lastAt 必须在启动时从已有快照文件的
 *   mtime 恢复（见 index.ts），否则重启等于把计时清零。
 */
export function shouldSnapshot(now: number, lastAt: number, intervalMs = SNAPSHOT_INTERVAL_MS): boolean {
  return now - lastAt >= intervalMs;
}
