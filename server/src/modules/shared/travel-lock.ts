// 「此刻谁在占着换图决策权」的跨模块协作锁
//
// 为什么需要它：模块之间不互相 import（会形成依赖边），但有的模块需要**只让出部分行为**，
// 而不是整个停掉 —— 典型是「自动报名赛事」：保底流程期间它不该跑进比赛地图，
// 但**报名必须照常**（报名有时效，错过就没了）。停掉整个模块会把报名一起停掉，
// 所以给「要不要换图」这一件事做一个极小的共享状态：
//
//   持有方（auto-pity 保底切图）  holdTravel(accountId, tag, label)
//                                 releaseTravel(accountId, tag)
//   让路方（auto-tournament）     travelHeldBy(accountId) → 跳过「进图」这一步，其它照做
//
// 性质：
//  - **按账号隔离**：A 账号在守保底，绝不能挡住 B 账号进比赛图。
//  - 同一 tag **幂等**：重复 hold 只是刷新，重复 release 无害 ——
//    不会因为"计数泄漏"把某个账号的进图永久锁死。
//  - **纯内存**：进程重启即清空。那时保底流程本身也没了，两边都从头开始，语义一致。
//  - 只影响「要不要换图」，**绝不影响**别的行为（例如报名）。
//  - 持有方要在 `onStop` 里 release（模块被停 / 账号被停都要放锁），并在 `onStart` 里
//    先 release 一次自己上次可能留下的锁（改配置重启时老实例不一定跑到 onStop）。
//  - 让路方每次跳过都留一句可见的日志（默认 info 一次），这样万一锁没被放掉也能被发现。

type Hold = { label: string; since: number };

/** accountId → (tag → 持有信息) */
const holds = new Map<string, Map<string, Hold>>();

export const TRAVEL_LOCK_HELD_BY_PITY = "保底切图";

/** 声明「从现在起由我决定去哪张图」 */
export function holdTravel(accountId: string, tag: string, label = tag): void {
  if (!accountId || !tag) return;
  let byTag = holds.get(accountId);
  if (!byTag) {
    byTag = new Map();
    holds.set(accountId, byTag);
  }
  byTag.set(tag, { label, since: Date.now() });
}

/** 释放（幂等；没持有过也无害） */
export function releaseTravel(accountId: string, tag: string): void {
  const byTag = holds.get(accountId);
  if (!byTag) return;
  byTag.delete(tag);
  if (!byTag.size) holds.delete(accountId);
}

/** 当前是否有人占着（让路方用这个判断） */
export function isTravelHeld(accountId: string): boolean {
  return (holds.get(accountId)?.size ?? 0) > 0;
}

/** 占着的话是谁（多个用「、」连接）——给日志用 */
export function travelHeldBy(accountId: string): string | null {
  const byTag = holds.get(accountId);
  if (!byTag || !byTag.size) return null;
  return [...byTag.values()].map((h) => h.label).join("、");
}

/** 持有明细（排查用：谁、什么时候开始） */
export function travelHolders(accountId: string): { tag: string; label: string; since: number }[] {
  const byTag = holds.get(accountId);
  if (!byTag) return [];
  return [...byTag.entries()].map(([tag, h]) => ({ tag, label: h.label, since: h.since }));
}

/** 清空全部（仅测试用：模块级单例会跨用例残留） */
export function clearTravelLocks(): void {
  holds.clear();
}
