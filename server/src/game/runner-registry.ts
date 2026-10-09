// 账号运行时注册表
//
// 为什么运行时实例不等于「正在运行」：即使账号处于 stopped，UI 仍要展示它的
// 统计、地图、等级等信息。所以每个账号都持有一个常驻的 AccountRuntime 实例，
// 只有 start() / stop() 改变它的状态。
import type { Repos } from "../db/repositories/index.ts";
import type { AccountRow } from "../db/repositories/accounts.ts";
import type { CredentialVault } from "../security/vault.ts";
import type { Logger } from "../lib/logger.ts";
import type { Bus } from "../lib/bus.ts";
import { AccountRuntime, type AccountStatus } from "./account-runtime.ts";
import type { ProxyConfig } from "./proxy.ts";
import { HttpError } from "../api/server.ts";

export type RunnerRegistryDeps = {
  repos: Repos;
  vault: CredentialVault;
  logger: Logger;
  bus: Bus;
  /**
   * 并发与配额改成**函数**而不是常量：这两个值能在后台在线修改，
   * 存成常量就得重启才生效（早期实现就是这个毛病）。
   */
  limits: {
    maxRunningAccounts: () => number;
    maxAccountsPerUser: () => number;
  };
  globalProxy: ProxyConfig | null;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
};

export class RunnerRegistry {
  private runners = new Map<string, AccountRuntime>();
  private deps: RunnerRegistryDeps;
  private starting = 0;

  constructor(deps: RunnerRegistryDeps) {
    this.deps = deps;
  }

  /** 为所有账号建立运行时（服务启动时调用一次） */
  initAll(): void {
    for (const record of this.deps.repos.accounts.listAll()) {
      this.ensure(record);
    }
    this.deps.logger.info("引擎", `已为 ${this.runners.size} 个账号建立运行时`);
  }

  /** 惰性建立（账号刚创建时） */
  ensure(record: AccountRow): AccountRuntime {
    const existing = this.runners.get(record.id);
    if (existing) return existing;

    const rt = new AccountRuntime({
      repos: this.deps.repos,
      vault: this.deps.vault,
      logger: this.deps.logger,
      bus: this.deps.bus,
      record,
      label: record.label,
      globalProxy: this.deps.globalProxy,
      onPersistStatus: (accountId, status, lastError) => {
        try {
          this.deps.repos.accounts.setStatus(accountId, status, lastError);
        } catch {
          /* 状态回写失败不影响运行 */
        }
      },
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    this.runners.set(record.id, rt);
    return rt;
  }

  get(accountId: string): AccountRuntime | null {
    return this.runners.get(accountId) ?? null;
  }

  /** 取或按数据库最新状态重建（账号记录被改过时用） */
  require(accountId: string): AccountRuntime {
    const existing = this.runners.get(accountId);
    if (existing) return existing;
    const record = this.deps.repos.accounts.findById(accountId);
    if (!record) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
    return this.ensure(record);
  }

  list(): AccountRuntime[] {
    return [...this.runners.values()];
  }

  get runningCount(): number {
    return this.list().filter((r) => r.status !== "stopped").length;
  }

  get capacity(): { running: number; max: number; available: number } {
    const running = this.runningCount;
    // 每次读设置：后台改了并发上限，下一次启动/容量查询就按新值算
    const max = this.deps.limits.maxRunningAccounts();
    return { running, max, available: Math.max(0, max - running) };
  }

  /** 单用户账号配额（运行时设置提供；这里透出便于服务层复用） */
  get limitPerUser(): number {
    return this.deps.limits.maxAccountsPerUser();
  }

  /**
   * 启动账号。超出全局并发上限时明确拒绝（而不是静默排队 —— 用户需要知道为什么没起来）。
   */
  async start(accountId: string): Promise<AccountRuntime> {
    const rt = this.require(accountId);
    if (rt.status !== "stopped") return rt;

    if (this.runningCount >= this.deps.limits.maxRunningAccounts()) {
      throw new HttpError(
        409,
        "RUNNING_LIMIT_REACHED",
        `同时运行的账号数已达上限（${this.deps.limits.maxRunningAccounts()}），请先停止其他账号。`,
      );
    }
    await rt.start();
    return rt;
  }

  async stop(accountId: string, reason?: string): Promise<AccountRuntime> {
    const rt = this.require(accountId);
    await rt.stop(reason);
    return rt;
  }

  /** 账号被删除：停止并丢弃运行时、关掉代理连接池 */
  async dispose(accountId: string): Promise<void> {
    const rt = this.runners.get(accountId);
    if (!rt) return;
    await rt.stop("账号已删除").catch(() => {});
    await rt.dispose().catch(() => {});
    this.runners.delete(accountId);
  }

  /** 账号凭证或代理被改：同步到运行时（运行中的账号会热切换） */
  refreshFromRecord(accountId: string, opts: { credentials?: boolean; proxy?: boolean } = {}): void {
    const rt = this.runners.get(accountId);
    if (!rt) return;
    if (opts.credentials) rt.refreshCredentials();
    if (opts.proxy) rt.refreshProxy();
  }

  /**
   * 服务启动：恢复 autoStart 的账号。
   * 刻意错峰（每次 2.5 秒）避免并发登录触发风控，
   * 但**会等全部完成后才返回** —— 旧版用 fire-and-forget，SIGTERM 可能跑在启动完成之前。
   */
  async startAutoStartAccounts(): Promise<{ started: number; failed: number }> {
    const targets = this.list().filter((r) => {
      const row = this.deps.repos.accounts.findById(r.accountId);
      return row?.auto_start === 1;
    });
    if (!targets.length) return { started: 0, failed: 0 };

    this.deps.logger.info("引擎", `恢复 ${targets.length} 个自动启动账号（错峰 ${targets.length * 2.5}s）`);

    let started = 0;
    let failed = 0;
    for (const [i, rt] of targets.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2500));
      // 超过全局并发上限就停手，剩下的账号保持 stopped 并给出明确原因
      if (this.runningCount >= this.deps.limits.maxRunningAccounts()) {
        this.deps.logger.warn(
          "引擎",
          `已达同时运行上限（${this.deps.limits.maxRunningAccounts()}），其余账号保持停止。请在控制台手动启动。`,
        );
        break;
      }
      try {
        await rt.start();
        started++;
      } catch (err) {
        failed++;
        this.deps.logger.warn(
          "引擎",
          `账号「${rt.label}」自动启动失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { started, failed };
  }

  /**
   * 优雅关闭：停掉所有账号。
   *
   * ★ 并发停而不是串行：单个 stop 最多等 2 秒（等在飞的请求退出），
   *   串行时 50 个账号就要 100 秒 —— 远超关闭预算，会被 SIGKILL 掉，
   *   于是状态写不回、日志落不了库、WAL 也不做 checkpoint。
   */
  async stopAll(): Promise<void> {
    await Promise.allSettled(this.list().map((rt) => rt.stop("服务关闭")));
  }

  /**
   * 停掉某个用户的全部账号（封禁用户时调用）。
   * 不能让被封禁的用户继续占用挂机资源。
   */
  async stopAllForUser(userId: string): Promise<number> {
    const targets = this.list().filter((r) => r.userId === userId && r.status !== "stopped");
    for (const rt of targets) {
      await rt.stop("账号已被封禁").catch(() => {});
    }
    return targets.length;
  }

  statusOf(accountId: string): AccountStatus {
    return this.runners.get(accountId)?.status ?? "stopped";
  }
}
