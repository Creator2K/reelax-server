// 仓储集合：集中装配，service 层只依赖这一个入口
import type { Db } from "../client.ts";
import { UsersRepo } from "./users.ts";
import { AuthSessionsRepo } from "./auth-sessions.ts";
import { InvitesRepo } from "./invites.ts";
import { ProxiesRepo } from "./proxies.ts";
import { AccountsRepo } from "./accounts.ts";
import { AccountModulesRepo } from "./account-modules.ts";
import { LogsRepo } from "./logs.ts";
import { StatsRepo } from "./stats.ts";
import { AuditRepo } from "./audit.ts";
import { NotifyRepo } from "./notify.ts";

export type Repos = {
  users: UsersRepo;
  sessions: AuthSessionsRepo;
  invites: InvitesRepo;
  proxies: ProxiesRepo;
  accounts: AccountsRepo;
  modules: AccountModulesRepo;
  logs: LogsRepo;
  stats: StatsRepo;
  audit: AuditRepo;
  notify: NotifyRepo;
};

export function createRepos(db: Db): Repos {
  return {
    users: new UsersRepo(db),
    sessions: new AuthSessionsRepo(db),
    invites: new InvitesRepo(db),
    proxies: new ProxiesRepo(db),
    accounts: new AccountsRepo(db),
    modules: new AccountModulesRepo(db),
    logs: new LogsRepo(db),
    stats: new StatsRepo(db),
    audit: new AuditRepo(db),
    notify: new NotifyRepo(db),
  };
}

export * from "./users.ts";
export * from "./auth-sessions.ts";
export * from "./invites.ts";
export * from "./proxies.ts";
export * from "./accounts.ts";
export * from "./account-modules.ts";
export * from "./logs.ts";
export * from "./stats.ts";
export * from "./audit.ts";
export * from "./notify.ts";

/**
 * 测试/开发辅助：建一个内存库并跑迁移。
 * 放在这里而不是 test/ 是因为集成测试与非测试脚本（如冒烟）都要用。
 */
export async function createTestDb(): Promise<{ db: Db; repos: Repos }> {
  const { openDb } = await import("../client.ts");
  const db = openDb(":memory:");
  db.migrate();
  return { db, repos: createRepos(db) };
}
