// 账号级「定时启停」调度器（服务端）
//
// ★ 为什么这件事必须是服务端级的、而不是一个模块：
//   账号被停掉以后，模块的定时器也跟着停了 —— 靠模块自己永远起不来。
//   所以这里直接读数据库里「定时挂机」模块的配置（account_modules 的 auto-schedule 行），
//   账号停着也照样到点启动。模块那边只负责提供配置入口、开关与日志。
//
// 语义（与 modules/auto-schedule/index.ts 的说明必须一致）：
//   1. 「到点生效」的里程碑：当前档 = 时间 ≤ 现在的最后一条，今天没到就用昨天的最后一条
//   2. **只在跨过新的一档时执行一次**：两档之间不反复对齐状态，
//      否则用户手动点「停止」会在半分钟内被拉起来，看起来像关不掉
//   3. 服务重启后 applied 是空的 → 会按当前档重新对齐一次（否则该跑的时候可能一直不跑）
//   4. 启动失败（凭证过期 / 并发上限）不会每 30 秒重试：冷却 5 分钟，日志同档只警告一次
//
// 与其它机制的优先级：**时间表说了算**。设了时间表又开着「自动启动」（auto_start）时，
// 到「off」那一档会被停掉（启动只发生在「on」那一档）。
import type { Repos } from "../db/repositories/index.ts";
import type { Logger } from "../lib/logger.ts";
import type { AccountStatus } from "../game/account-runtime.ts";
import { getModule } from "../modules/registry.ts";
import { resolveModuleConfig } from "../modules/types.ts";
import { milestoneOccurrence } from "../modules/shared/schedule.ts";
import { parseSchedulePlan, pickSchedulePlanEntry } from "../modules/auto-schedule/plan.ts";

/** 「定时挂机」模块 id（配置存在它的 account_modules 行里） */
export const SCHEDULE_MODULE_ID = "auto-schedule";

/** 扫描间隔 */
export const SCHEDULE_TICK_MS = 30_000;
/** 启动失败后的冷却（避免凭证坏了就每 30 秒撞一次） */
export const SCHEDULE_RETRY_MS = 5 * 60_000;
/** 服务启动后多久做第一次对齐（错开启动瞬间的登录高峰） */
export const SCHEDULE_FIRST_TICK_MS = 20_000;

/** 调度器只用得到这两个方法（窄接口：单测注入假 logger 也方便） */
export type ScheduleLogger = {
  info(tag: string, msg: string): unknown;
  warn(tag: string, msg: string): unknown;
};

/** 调度器需要的能力（窄接口便于单测注入假实现） */
export type ScheduleRegistry = {
  statusOf(accountId: string): AccountStatus;
  start(accountId: string): Promise<unknown>;
  stop(accountId: string, reason?: string): Promise<unknown>;
};

export type AccountScheduleDeps = {
  repos: Repos;
  registry: ScheduleRegistry;
  logger: Logger;
};

export type ScheduleAction = "start" | "stop" | "none";

export class AccountScheduleService {
  private deps: AccountScheduleDeps;
  /** accountId → 已经执行过的那一档（`<occurrenceMs>:on|off`） */
  private applied = new Map<string, string>();
  /** accountId → 上次启动失败时间 / 已警告过的那一档 */
  private failedAt = new Map<string, number>();
  private warnedKey = new Map<string, string>();
  /** 扫一轮可能比间隔还慢（账号多、启动要登录），用重入锁避免两轮叠在一起 */
  private ticking = false;

  constructor(deps: AccountScheduleDeps) {
    this.deps = deps;
  }

  /** 清掉全部记忆（测试用） */
  reset(): void {
    this.applied.clear();
    this.failedAt.clear();
    this.warnedKey.clear();
  }

  /** 扫一遍所有开了「定时挂机」的账号 */
  async tick(now: Date = new Date()): Promise<void> {
    // 上一轮还没扫完（账号多时启动很慢）→ 跳过这一轮，不叠着跑
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce(now);
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(now: Date): Promise<void> {
    const { repos } = this.deps;
    let rows: ReturnType<Repos["modules"]["listByModule"]>;
    try {
      rows = repos.modules.listByModule(SCHEDULE_MODULE_ID, { enabledOnly: true });
    } catch (err) {
      this.deps.logger.warn("定时挂机", `读取时间表失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.accountId);
      try {
        await this.applyOne(row.accountId, row.config, now);
      } catch (err) {
        this.deps.logger.warn(
          "定时挂机",
          `处理账号 ${row.accountId} 的时间表失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 不再配置的账号：清掉记忆，避免 map 无限增长
    for (const id of [...this.applied.keys()]) if (!seen.has(id)) this.applied.delete(id);
    for (const id of [...this.failedAt.keys()]) if (!seen.has(id)) this.failedAt.delete(id);
    for (const id of [...this.warnedKey.keys()]) if (!seen.has(id)) this.warnedKey.delete(id);
  }

  /**
   * 单个账号：算出这一档该开还是该关，必要时执行。
   * 抽成 public 是为了能直接单测（不必每次构造整个 repos）。
   */
  async applyOne(accountId: string, storedConfig: Record<string, unknown>, now: Date): Promise<ScheduleAction> {
    const { registry } = this.deps;
    const def = getModule(SCHEDULE_MODULE_ID);
    if (!def) return "none";
    // 用模块自己的 schema 合并默认值：不要在调度器里再写一份默认值（会漂移）
    const { config } = resolveModuleConfig(def, storedConfig);
    const dryRun = config.dryRun === true;

    const { entries } = parseSchedulePlan(config.plan);
    if (!entries.length) return "none";
    const entry = pickSchedulePlanEntry(entries, now);
    if (!entry) return "none";

    const key = `${milestoneOccurrence(entry, now)}:${entry.on ? "on" : "off"}`;
    if (this.applied.get(accountId) === key) return "none";

    const status = registry.statusOf(accountId);
    const running = status !== "stopped";
    const log = this.logFor(accountId);

    if (dryRun) {
      this.applied.set(accountId, key);
      log.info(
        "定时挂机",
        `[演练] ${entry.at} 到点：应${entry.on ? "启动" : "停止"}账号（当前${running ? "运行中" : "已停止"}，未真的执行）`,
      );
      return "none";
    }

    // 已经就是该有的状态：记下这一档，不做无意义操作（也不会去"纠正"用户的手动操作）
    if (entry.on === running) {
      this.applied.set(accountId, key);
      return "none";
    }

    // 启动失败冷却：凭证过期这类问题不该每 30 秒撞一次
    // （用 tick 的时间而不是 Date.now()：判定整体只依赖传入的 now，便于测试与对齐）
    if (entry.on && now.getTime() - (this.failedAt.get(accountId) ?? 0) < SCHEDULE_RETRY_MS) return "none";

    try {
      if (entry.on) {
        await registry.start(accountId);
        log.info("定时挂机", `⏰ ${entry.at} 到点，已启动账号`);
      } else {
        await registry.stop(accountId, "定时关闭（时间表）");
        log.info("定时挂机", `⏰ ${entry.at} 到点，已停止账号`);
      }
      this.applied.set(accountId, key);
      this.failedAt.delete(accountId);
      this.warnedKey.delete(accountId);
      return entry.on ? "start" : "stop";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failedAt.set(accountId, now.getTime());
      // 同一档只警告一次，之后每 5 分钟静默重试
      if (this.warnedKey.get(accountId) !== key) {
        this.warnedKey.set(accountId, key);
        log.warn(
          "定时挂机",
          `⏰ ${entry.at} 到点${entry.on ? "启动" : "停止"}账号失败：${msg}（${Math.round(SCHEDULE_RETRY_MS / 60_000)} 分钟后重试）`,
        );
      }
      return "none";
    }
  }

  /** 带账号标签的日志（会进 logs 表，账号日志页能看到） */
  private logFor(accountId: string): ScheduleLogger {
    const row = this.deps.repos.accounts.findById(accountId);
    return row ? this.deps.logger.child({ userId: row.user_id, accountId }) : this.deps.logger;
  }
}
