// 服务入口：解析配置 → 建库/迁移 → 装配引擎与 HTTP → 优雅关闭
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, EnvError, type Env } from "./env.ts";
import { createLogger, mirrorToConsole, type Logger } from "./lib/logger.ts";
import { Bus } from "./lib/bus.ts";
import { openDb, type Db } from "./db/client.ts";
import { createRepos, type Repos } from "./db/repositories/index.ts";
import { Limiters } from "./auth/ratelimit.ts";
import { AuthService } from "./auth/service.ts";
import { attachAuth } from "./auth/middleware.ts";
import { CredentialVault } from "./security/vault.ts";
import { RunnerRegistry } from "./game/runner-registry.ts";
import { AccountService } from "./services/account-service.ts";
import { ProxyService } from "./services/proxy-service.ts";
import { NotifyService } from "./services/notify-service.ts";
import { UpdateService } from "./services/update-service.ts";
import { SettingsService } from "./services/settings-service.ts";
import { VERSION } from "./version.ts";
import { runCommand } from "./services/wechat-commands.ts";
import { createNotifyRouter } from "./api/routes/notify-routes.ts";
import { parseGlobalProxy } from "./game/proxy.ts";
import { assertRegistryValid } from "./modules/registry.ts";
import { bootstrapModules } from "./modules/bootstrap.ts";
import { createAuthRouter } from "./api/routes/auth.ts";
import { createAccountsRouter } from "./api/routes/accounts.ts";
import { createProxiesRouter } from "./api/routes/proxy-routes.ts";
import { createModulesRouter } from "./api/routes/modules.ts";
import { createLogsRouter } from "./api/routes/logs-routes.ts";
import { createStatsRouter } from "./api/routes/stats-routes.ts";
import { createAdminRouter } from "./api/routes/admin-routes.ts";
import { WsGateway } from "./api/ws-gateway.ts";
import { createApp } from "./api/server.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err instanceof Error ? (err.stack ?? err.message) : err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.stack ?? err.message);
});

type Ctx = {
  env: Env;
  logger: Logger;
  bus: Bus;
  db: Db;
  repos: Repos;
  limiters: Limiters;
  auth: AuthService;
  vault: CredentialVault;
  registry: RunnerRegistry;
  accounts: AccountService;
  proxies: ProxyService;
  notify: NotifyService;
  update: UpdateService;
  /** 运行时设置：环境变量只给初始值，之后可在后台在线改 */
  settings: SettingsService;
};

function buildContext(): Ctx {
  // 模块注册表自检：id 重复、配置写错在这里就该炸，而不是运行时
  assertRegistryValid();
  // 一次性注入（状态面板等），必须在建运行时之前完成
  bootstrapModules();

  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(env);
  mirrorToConsole(logger);

  const dataDir = path.resolve(env.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  const db = openDb(path.join(dataDir, "reelax.db"));
  const { applied, backup } = db.migrate();
  if (applied.length) {
    logger.info(
      "数据库",
      `已应用迁移：${applied.join(", ")}${backup ? `（迁移前备份：${path.basename(backup)}）` : ""}`,
    );
  }
  logger.info("数据库", `SQLite ${path.join(dataDir, "reelax.db")}${db.hasFts5() ? "（FTS5 可用）" : ""}`);

  const repos = createRepos(db);
  // 上次进程被杀留下的 running 状态是脏数据，启动时复位
  repos.accounts.resetAllStatuses();

  const vault = new CredentialVault(env.masterKey, logger);
  const limiters = new Limiters();
  // 运行时设置：环境变量只提供初始值，之后以数据库为准（后台可在线改）
  const settings = new SettingsService(db, env);
  const auth = new AuthService({ repos, env, settings, limiter: limiters, logger });

  const globalProxy = parseGlobalProxy(env.globalProxy);
  if (env.globalProxy && !globalProxy) {
    logger.warn("代理", `REELAX_GLOBAL_PROXY 无法解析，已忽略：${env.globalProxy}`);
  }

  const bus = new Bus();
  const registry = new RunnerRegistry({
    repos,
    vault,
    logger,
    bus,
    // 传函数而不是值：这两个上限能在后台在线改，值必须在调用时才读取
    limits: {
      maxRunningAccounts: () => settings.get("maxRunningAccounts"),
      maxAccountsPerUser: () => settings.get("maxAccountsPerUser"),
    },
    globalProxy,
  });
  // accounts 与 notify 互相引用：
  //   notify.onCommand          需要 accounts（微信命令要查账号）
  //   accounts.hasUsableChannel 需要 notify（日报前置检查）
  // 两个回调都只在请求时才求值，所以用「先建 notify、再赋值 accounts」的顺序即可。
  // 必须用 let：accounts 的初始化表达式依赖已建好的 notify，无法与声明合并。
  // eslint-disable-next-line prefer-const -- 见上，刻意后绑定
  let accounts!: AccountService;

  const notify = new NotifyService({
    repos,
    vault,
    logger,
    // 微信凭证目录：与数据库同盘，跟随数据卷一起备份/迁移
    dataDir: path.resolve(env.dataDir),
    // 微信里发命令 → 复用与桌面端一致的命令集（数据范围限该用户自己的账号）
    onCommand: (userId: string, text: string): Promise<string | null> =>
      runCommand({ repos, registry, accounts }, userId, text),
  });

  accounts = new AccountService({
    repos,
    vault,
    registry,
    // 收益日报依赖推送通道：注入判定（调用时才用到 notify）
    hasUsableChannel: (userId: string): boolean => notify.hasUsableChannel(userId),
  });

  const proxies = new ProxyService({
    repos,
    vault,
    registry,
    logger,
    baseUrl: env.baseUrl,
    proxyEchoUrl: env.proxyEchoUrl,
  });

  const update = new UpdateService({
    logger,
    repoSlug: env.repoSlug,
    // 代码工作区：只有在「仓库里直接跑」时才有 .git（Docker 镜像内没有），
    // 因此 Docker 部署下 canApplyLocal 自动为 false —— 这是刻意的：
    // 镜像里的代码无法替换自己，真正的更新交给旁路 updater。
    workDir: path.resolve(__dirname, "../.."),
    updaterUrl: env.updaterUrl,
    allowLocalUpdate: env.allowLocalUpdate,
  });

  return { env, logger, bus, db, repos, limiters, auth, vault, registry, accounts, proxies, notify, update, settings };
}

async function main(): Promise<void> {
  const ctx = buildContext();
  const { env, logger, bus, db, repos, auth, registry, accounts, proxies, notify, update, settings, limiters } = ctx;

  const checkpointTimer = setInterval(() => db.checkpoint(), 5 * 60_000);
  checkpointTimer.unref();

  /* ---------- 定期维护 ---------- */
  const maintenance = setInterval(
    () => {
      try {
        repos.sessions.purgeExpired();
        repos.logs.deleteOlderThan(Date.now() - env.logRetentionDays * 86_400_000);
        repos.audit.deleteOlderThan(Date.now() - 180 * 86_400_000);
      } catch (err) {
        logger.warn("维护", `清理任务失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    60 * 60_000,
  );
  maintenance.unref();

  /* ---------- 部署时的默认管理员 ----------
   * 为什么在启动时建：服务器部署时「第一个访问站点的人」未必是机主，
   * 把首注册变管理员等于把后台送给先来的人。这里用已知用户名 + 随机口令，
   * 并把口令写进数据目录（同时打一条日志），机主登录后自行修改。
   */
  if (env.adminUsername) {
    try {
      const seeded = await auth.ensureAdminAccount({
        username: env.adminUsername,
        ...(env.adminPassword ? { password: env.adminPassword } : {}),
      });

      if (seeded.created && seeded.password) {
        // 同时落盘一份：容器日志会滚动，而数据目录会跟卷一起备份
        const notePath = path.join(path.resolve(env.dataDir), "INITIAL_ADMIN.txt");
        fs.writeFileSync(
          notePath,
          [
            "初始管理员账户（首次部署自动生成）",
            "",
            `登录名：${seeded.username}`,
            `口  令：${seeded.password}`,
            "",
            "请登录后立即在「设置」里修改口令，然后删除本文件。",
            "",
          ].join("\n"),
          { encoding: "utf8", mode: 0o600 },
        );
        logger.info("管理员", "━".repeat(52));
        logger.info("管理员", `已创建默认管理员：${seeded.username}`);
        logger.info("管理员", `初始口令：${seeded.password}`);
        logger.info("管理员", `（也已写入 ${notePath}，登录后请尽快修改口令）`);
        logger.info("管理员", "━".repeat(52));
      } else if (seeded.created) {
        logger.info("管理员", `已创建默认管理员：${seeded.username}（口令取自 ADMIN_PASSWORD）`);
      } else if (seeded.note) {
        logger.info("管理员", `默认管理员 ${seeded.username}：${seeded.note}`);
      }
    } catch (err) {
      logger.warn("管理员", `创建默认管理员失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ---------- 为所有账号建立运行时（不启动） ---------- */
  registry.initAll();

  /* ---------- 日报 → 推送 ----------
   * 「收益日报」模块产出的是结构化 digest 事件（而不是靠字符串匹配日志），
   * 这里订阅它并广播给该用户的全部可用通道。
   * 旧版靠 /📊/ 匹配日志决定要不要推微信，而日报早已不带 emoji，链路静默失效 ——
   * 类型化事件从根上消除了这类问题。
   */
  bus.on("digest", (payload: unknown) => {
    const p = payload as {
      userId?: string;
      label?: string;
      lines?: string[];
      date?: string;
    } | null;
    if (!p?.userId || !Array.isArray(p.lines)) return;

    const body = p.lines.join("\n");
    void notify
      .sendToUser(p.userId, {
        title: `收益日报 · ${p.date ?? ""}`.trim(),
        body,
        accountLabel: p.label ?? null,
      })
      .then((r) => {
        if (r.sent > 0) {
          logger.info("推送", `日报已推送（成功 ${r.sent}${r.failed ? `，失败 ${r.failed}` : ""}）`, {
            userId: p.userId,
          });
        } else if (r.errors.length) {
          logger.warn("推送", `日报推送失败：${r.errors.join("；")}`, { userId: p.userId });
        }
      })
      .catch(() => {
        /* 推送失败不影响日报本身 */
      });
  });

  /* ---------- 恢复推送通道（微信需要重新登录复用凭证） ---------- */
  await notify.restoreAll().catch((err) => {
    logger.warn("推送", `恢复推送通道失败：${err instanceof Error ? err.message : String(err)}`);
  });

  const startedAt = Date.now();
  const app = createApp({
    logger,
    webDist: path.resolve(__dirname, "../../web/dist"),
    isProduction: env.isProduction,
    trustProxy: env.trustProxy,
    version: VERSION,
    startedAt,
    mount: (a) => {
      a.use("/api", attachAuth(auth));
      a.use("/api/auth", createAuthRouter({ auth, env: { ...env, version: VERSION }, logger }));
      a.use("/api/modules", createModulesRouter({ notify }));
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
          // 本次运行累计（内存统计，重启即清零）
          sessionStats: (userId) => {
            const own = registry.list().filter((r) => r.userId === userId);
            return {
              accounts: own.length,
              running: own.filter((r) => r.status !== "stopped").length,
              online: own.filter((r) => r.status === "online").length,
              castsResolved: own.reduce((a, r) => a + r.stats.castsResolved, 0),
              gold: own.reduce((a, r) => a + r.stats.gold, 0),
              fishCount: own.reduce((a, r) => a + r.stats.fishCount, 0),
              experience: own.reduce((a, r) => a + r.stats.experience, 0),
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
          update,
          settings,
          limiters,
          env,
          version: VERSION,
          startedAt,
        }),
      );
    },
  });

  const server = http.createServer(app);

  // WebSocket 网关：按用户分组推送快照 / 日志 / 事件
  const wsGateway = new WsGateway({ server, auth, accounts, logger, bus });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.error("HTTP", `端口 ${env.port} 已被占用。用 PORT 环境变量换一个端口。`);
      } else {
        logger.error("HTTP", `监听失败：${err.message}`);
      }
      reject(err);
    });
    server.listen(env.port, env.host, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : env.port;
      const shown = env.host === "0.0.0.0" || env.host === "::" ? "localhost" : env.host;
      logger.info("HTTP", `服务已启动：http://${shown}:${actual}`);

      const users = repos.users.countAll();
      if (users === 0) {
        logger.info("HTTP", "还没有任何用户 —— 第一个注册的人将成为管理员");
      } else {
        const pending = repos.users.countByStatus("pending");
        if (pending > 0) logger.info("HTTP", `有 ${pending} 个用户等待审批`);
      }
      if (!env.isProduction) logger.info("HTTP", `游戏地址 ${env.baseUrl}｜数据目录 ${path.resolve(env.dataDir)}`);
      resolve();
    });
  });

  /* ---------- 恢复自动启动的账号（错峰，且等全部完成） ---------- */
  const resumed = await registry.startAutoStartAccounts();
  if (resumed.started || resumed.failed) {
    logger.info("引擎", `自动启动完成：成功 ${resumed.started}，失败 ${resumed.failed}`);
  }

  /* ---------- 优雅关闭 ---------- */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("服务", `收到 ${signal}，正在关闭…`);
    const force = setTimeout(() => {
      logger.warn("服务", "关闭超时，强制退出");
      process.exit(1);
    }, 10_000);
    force.unref();

    try {
      clearInterval(checkpointTimer);
      clearInterval(maintenance);
      // 先停引擎（会把状态写回数据库），再关推送、WS 与 HTTP
      await registry.stopAll();
      await notify.disposeAll().catch(() => {});
      wsGateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      logger.info("服务", "已安全关闭");
      process.exit(0);
    } catch (err) {
      logger.error("服务", `关闭时出错：${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("启动失败：", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
