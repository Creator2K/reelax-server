// 全栈集成测试脚手架：装配与生产一致的 App（除 WS）
//
// 与 test/helpers/server.ts 的区别：那个只挂 auth，用于认证流测试；
// 这个挂上 accounts / proxies / modules，用于越权矩阵与业务行为测试。
import http from "node:http";
import type { Express } from "express";
import { openDb, type Db } from "../../src/db/client.ts";
import { createRepos, type Repos } from "../../src/db/repositories/index.ts";
import { Limiters } from "../../src/auth/ratelimit.ts";
import { AuthService } from "../../src/auth/service.ts";
import { attachAuth } from "../../src/auth/middleware.ts";
import { CredentialVault } from "../../src/security/vault.ts";
import { RunnerRegistry } from "../../src/game/runner-registry.ts";
import { AccountService } from "../../src/services/account-service.ts";
import { ProxyService } from "../../src/services/proxy-service.ts";
import { Logger } from "../../src/lib/logger.ts";
import { Bus } from "../../src/lib/bus.ts";
import { createApp } from "../../src/api/server.ts";
import { createAuthRouter } from "../../src/api/routes/auth.ts";
import { createAccountsRouter } from "../../src/api/routes/accounts.ts";
import { createProxiesRouter } from "../../src/api/routes/proxy-routes.ts";
import { createModulesRouter } from "../../src/api/routes/modules.ts";
import { NotifyService } from "../../src/services/notify-service.ts";
import { createNotifyRouter } from "../../src/api/routes/notify-routes.ts";
import { createLogsRouter } from "../../src/api/routes/logs-routes.ts";
import { createStatsRouter } from "../../src/api/routes/stats-routes.ts";
import { createAdminRouter } from "../../src/api/routes/admin-routes.ts";
import { bootstrapModules } from "../../src/modules/bootstrap.ts";
import type { Env } from "../../src/env.ts";
import { CookieJar, type ApiResponse } from "./server.ts";

export type FullApp = {
  app: Express;
  db: Db;
  repos: Repos;
  auth: AuthService;
  vault: CredentialVault;
  registry: RunnerRegistry;
  accounts: AccountService;
  proxies: ProxyService;
  notify: NotifyService;
  limiters: Limiters;
  logger: Logger;
  bus: Bus;
  url: string;
  close(): Promise<void>;
  request<T = any>(
    method: string,
    path: string,
    opts?: { body?: unknown; jar?: CookieJar; headers?: Record<string, string> },
  ): Promise<ApiResponse<T>>;
  get<T = any>(path: string, jar?: CookieJar): Promise<ApiResponse<T>>;
  post<T = any>(path: string, body?: unknown, jar?: CookieJar): Promise<ApiResponse<T>>;
  patch<T = any>(path: string, body?: unknown, jar?: CookieJar): Promise<ApiResponse<T>>;
  del<T = any>(path: string, jar?: CookieJar): Promise<ApiResponse<T>>;
  /** 直接建一个已审批用户（跳过注册流程），返回其 cookie jar */
  seedApprovedUser(email: string, role?: "user" | "admin"): { jar: CookieJar; id: string };
  /** 直接建账号（不走路由） */
  seedAccount(userId: string, label?: string): string;
  seedProxy(userId: string, label?: string): string;
  /** 模拟「已配置可用推送通道」（默认 false，即日报不可配置） */
  setNotifyAvailable(v: boolean): void;
};

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    nodeEnv: "test",
    isProduction: false,
    port: 0,
    host: "127.0.0.1",
    dataDir: ":memory:",
    masterKey: Buffer.alloc(32, 9),
    baseUrl: "https://reelax.cn",
    globalProxy: "",
    proxyEchoUrl: "",
    trustProxy: false,
    cookieSecure: false,
    allowRegistration: true,
    maxAccountsPerUser: 5,
    maxRunningAccounts: 50,
    logLevel: "error",
    logRetentionDays: 14,
    sessionTtlDays: 30,
    ...overrides,
  };
}

export async function buildFullApp(opts: { env?: Partial<Env>; fetchImpl?: typeof fetch } = {}): Promise<FullApp> {
  bootstrapModules();
  const env = testEnv(opts.env);
  const logger = new Logger({ limit: 1000, minLevel: "error" });
  const bus = new Bus();
  const db = openDb(":memory:");
  db.migrate();
  const repos = createRepos(db);
  const limiters = new Limiters();
  const auth = new AuthService({ repos, env, limiter: limiters, logger });
  const vault = new CredentialVault(env.masterKey, logger);
  const registry = new RunnerRegistry({
    repos,
    vault,
    logger,
    bus,
    maxRunningAccounts: env.maxRunningAccounts,
    maxAccountsPerUser: env.maxAccountsPerUser,
    globalProxy: null,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  // 测试默认「没有可用推送通道」，需要时用 setNotifyAvailable(true) 打开
  let notifyAvailable = false;
  // accounts 与 notify 互相引用（日报前置检查 / 微信命令）。
  // 闭包捕获的是绑定而非值，`onCommand` 只在真正收到消息时才求值，所以顺序安全。
  const accounts = new AccountService({
    repos,
    vault,
    registry,
    hasUsableChannel: (): boolean => notifyAvailable,
  });
  const notify = new NotifyService({
    repos,
    vault,
    logger,
    dataDir: ":memory:",
    // 测试里不接微信命令（避免启动真实 bot）
    onCommand: async () => null,
  });
  const proxies = new ProxyService({
    repos,
    vault,
    registry,
    logger,
    baseUrl: env.baseUrl,
    proxyEchoUrl: env.proxyEchoUrl,
  });

  const app = createApp({
    logger,
    isProduction: false,
    trustProxy: false,
    version: "test",
    startedAt: Date.now(),
    mount: (a) => {
      a.use("/api", attachAuth(auth));
      a.use("/api/auth", createAuthRouter({ auth, env: { ...env, version: "test" }, logger }));
      a.use("/api/modules", createModulesRouter({ notify, hasUsableChannel: () => notifyAvailable }));
      a.use("/api/notify", createNotifyRouter({ notify, audit: repos.audit, limiters }));
      a.use("/api/accounts", createAccountsRouter({ accounts, registry, audit: repos.audit }));
      a.use("/api/proxies", createProxiesRouter({ proxies, accounts, audit: repos.audit, limiters }));
      a.use("/api/logs", createLogsRouter({ logger, logs: repos.logs }));
      a.use(
        "/api/stats",
        createStatsRouter({
          stats: repos.stats,
          repos,
          registry,
          sessionStats: (userId) => {
            const own = registry.list().filter((r) => r.userId === userId);
            return {
              accounts: own.length,
              running: own.filter((r) => r.status !== "stopped").length,
              online: own.filter((r) => r.status === "online").length,
              castsResolved: own.reduce((acc, r) => acc + r.stats.castsResolved, 0),
              gold: own.reduce((acc, r) => acc + r.stats.gold, 0),
              fishCount: own.reduce((acc, r) => acc + r.stats.fishCount, 0),
              experience: own.reduce((acc, r) => acc + r.stats.experience, 0),
            };
          },
        }),
      );
      a.use(
        "/api/admin",
        createAdminRouter({
          auth,
          invites: repos.invites,
          audit: repos.audit,
          repos,
          registry,
          env,
          version: "test",
          startedAt: Date.now(),
        }),
      );
    },
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = async <T = any>(
    method: string,
    path: string,
    o: { body?: unknown; jar?: CookieJar; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const cookie = o.jar?.header();
    if (cookie) headers["Cookie"] = cookie;

    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const setCookie = resp.headers.getSetCookie();
    if (o.jar) o.jar.absorb(setCookie);
    const text = await resp.text();
    let body: T;
    try {
      body = text ? (JSON.parse(text) as T) : (null as T);
    } catch {
      body = text as unknown as T;
    }
    return { status: resp.status, body, cookies: setCookie };
  };

  return {
    app,
    db,
    repos,
    auth,
    vault,
    registry,
    accounts,
    proxies,
    notify,
    limiters,
    logger,
    bus,
    url: baseUrl,
    request,
    get: (p, jar) => request("GET", p, { jar }),
    post: (p, body, jar) => request("POST", p, { body, jar }),
    patch: (p, body, jar) => request("PATCH", p, { body, jar }),
    del: (p, jar) => request("DELETE", p, { jar }),
    async close() {
      await registry.stopAll().catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
    seedApprovedUser(email: string, role: "user" | "admin" = "user") {
      const row = repos.users.create({
        // 占位哈希：这个用户的登录走真实路由时不适用，但 seedApprovedUser 是直接塞 cookie，
        // 因此只要格式合法（scrypt$N=,r=,p$$salt$hash）即可，校验永远不会成功。
        passwordHash: "scrypt$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        email,
        displayName: email.split("@")[0] ?? email,
        role,
        status: "approved",
      });
      const jar = new CookieJar();
      const token = auth.createSession(row, null, null);
      // 直接把 cookie 塞进 jar（跳过真实登录，测试更快也更稳）
      jar.absorb([`reelax_session=${token.token}; Path=/; HttpOnly; SameSite=Lax`]);
      return { jar, id: row.id };
    },
    seedAccount(userId: string, label = "测试账号") {
      return repos.accounts.create({
        userId,
        label,
        authType: "credentials",
        email: `${label}@game.example`,
        baseUrl: "https://reelax.cn",
      }).id;
    },
    setNotifyAvailable(v: boolean) {
      notifyAvailable = v;
    },
    seedProxy(userId: string, label = "测试代理") {
      return repos.proxies.create({
        userId,
        label,
        protocol: "http",
        host: "127.0.0.1",
        port: 8080,
      }).id;
    },
  };
}
