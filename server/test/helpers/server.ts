// 集成测试辅助：起一个真实的 Express + 内存 SQLite 实例，带 cookie jar
//
// 不用 supertest：直接用 node:http + fetch，少一个依赖，而且与生产路径完全一致。
import http from "node:http";
import { openDb, type Db } from "../../src/db/client.ts";
import { createRepos, type Repos } from "../../src/db/repositories/index.ts";
import { Limiters } from "../../src/auth/ratelimit.ts";
import { AuthService } from "../../src/auth/service.ts";
import { SettingsService } from "../../src/services/settings-service.ts";
import { attachAuth } from "../../src/auth/middleware.ts";
import { createApp } from "../../src/api/server.ts";
import { createAuthRouter } from "../../src/api/routes/auth.ts";
import { Logger } from "../../src/lib/logger.ts";
import type { Env } from "../../src/env.ts";
import type { Express } from "express";

export type ApiResponse<T = any> = {
  status: number;
  body: T;
  /** Set-Cookie 原始值的数组 */
  cookies: string[];
};

export class CookieJar {
  private jar = new Map<string, string>();

  absorb(setCookie: string[]): void {
    for (const raw of setCookie) {
      const pair = raw.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      // Max-Age=0 表示删除
      if (/max-age=0/i.test(raw) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string | undefined {
    if (!this.jar.size) return undefined;
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  clear(): void {
    this.jar.clear();
  }
}

export class TestServer {
  readonly app: Express;
  readonly db: Db;
  readonly repos: Repos;
  readonly auth: AuthService;
  readonly limiters: Limiters;
  readonly logger: Logger;
  private server: http.Server;
  private port = 0;

  constructor(opts: { env?: Partial<Env>; extend?: (app: Express) => void } = {}) {
    const env: Env = {
      nodeEnv: "test",
      isProduction: false,
      port: 0,
      host: "127.0.0.1",
      dataDir: ":memory:",
      masterKey: Buffer.alloc(32, 7),
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
      ...opts.env,
    };

    this.logger = new Logger({ limit: 1000, minLevel: "error" });
    this.db = openDb(":memory:");
    this.db.migrate();
    this.repos = createRepos(this.db);
    this.limiters = new Limiters();
    this.auth = new AuthService({ repos: this.repos, env, settings: new SettingsService(this.db, env), limiter: this.limiters, logger: this.logger });

    this.app = createApp({
      logger: this.logger,
      isProduction: false,
      trustProxy: false,
      version: "test",
      startedAt: Date.now(),
      mount: (a) => {
        a.use("/api", attachAuth(this.auth));
        a.use(
          "/api/auth",
          createAuthRouter({
            auth: this.auth,
            env: { ...env, version: "test" },
            logger: this.logger,
          }),
        );
        // 业务路由由各测试自行注入
        opts.extend?.(a);
      },
    });
    this.server = http.createServer(this.app);
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.db.close();
  }

  /** 发一个请求；传入 jar 则自动带上 cookie 并吸收响应 cookie */
  async request<T = any>(
    method: string,
    path: string,
    opts: { body?: unknown; jar?: CookieJar; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const cookie = opts.jar?.header();
    if (cookie) headers["Cookie"] = cookie;

    const resp = await fetch(`${this.url}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const setCookie = resp.headers.getSetCookie();
    if (opts.jar) opts.jar.absorb(setCookie);

    const text = await resp.text();
    let body: T;
    try {
      body = text ? (JSON.parse(text) as T) : (null as T);
    } catch {
      body = text as unknown as T;
    }

    return { status: resp.status, body, cookies: setCookie };
  }

  get<T = any>(path: string, jar?: CookieJar) {
    return this.request<T>("GET", path, { jar });
  }
  post<T = any>(path: string, body?: unknown, jar?: CookieJar) {
    return this.request<T>("POST", path, { body, jar });
  }
  patch<T = any>(path: string, body?: unknown, jar?: CookieJar) {
    return this.request<T>("PATCH", path, { body, jar });
  }
  del<T = any>(path: string, jar?: CookieJar) {
    return this.request<T>("DELETE", path, { jar });
  }

  /* ---------- 业务快捷方法 ---------- */

  /** 注册首个用户（自动成为管理员） */
  async seedAdmin(email = "admin@example.com", password = "admin-password-1"): Promise<{ jar: CookieJar; id: string }> {
    const jar = new CookieJar();
    const r = await this.post<{ user: { id: string } }>("/api/auth/register", { email, password, displayName: "管理员" }, jar);
    if (r.status !== 201) throw new Error(`seedAdmin 失败：${r.status} ${JSON.stringify(r.body)}`);
    return { jar, id: r.body.user.id };
  }

  /** 建邀请码 */
  createInvite(opts: { maxUses?: number | null; expiresAt?: number | null } = {}): string {
    return this.repos.invites.create({
      maxUses: opts.maxUses ?? 1,
      expiresAt: opts.expiresAt ?? null,
      note: "test",
    }).code;
  }

  /** 注册一个待审批用户 */
  async seedPendingUser(
    email: string,
    password = "user-password-1",
    inviteCode?: string,
  ): Promise<{ jar: CookieJar; id: string; status: string }> {
    const jar = new CookieJar();
    const code = inviteCode ?? this.createInvite();
    const r = await this.post<{ user: { id: string; status: string } }>(
      "/api/auth/register",
      { email, password, displayName: email.split("@")[0], inviteCode: code },
      jar,
    );
    if (r.status !== 201) throw new Error(`seedPendingUser 失败：${r.status} ${JSON.stringify(r.body)}`);
    return { jar, id: r.body.user.id, status: r.body.user.status };
  }

  /** 注册并审批通过的用户 */
  async seedApprovedUser(email: string, adminId: string, password = "user-password-1"): Promise<{ jar: CookieJar; id: string }> {
    const pending = await this.seedPendingUser(email, password);
    this.repos.users.setStatus(pending.id, "approved", adminId);
    // 审批会清会话，重新登录
    const jar = new CookieJar();
    await this.post("/api/auth/login", { email, password }, jar);
    return { jar, id: pending.id };
  }

  /** 直接建一个游戏账号（跳过路由，用于铺垫数据） */
  seedAccount(userId: string, label = "测试账号"): string {
    const row = this.repos.accounts.create({
      userId,
      label,
      authType: "credentials",
      email: `${label}@game.example`,
      baseUrl: "https://reelax.cn",
    });
    return row.id;
  }

  seedProxy(userId: string, label = "测试代理"): string {
    return this.repos.proxies.create({
      userId,
      label,
      protocol: "http",
      host: "127.0.0.1",
      port: 8080,
    }).id;
  }
}

/** 便捷：起服务、跑用例、关服务 */
export async function withServer<T>(
  fn: (s: TestServer) => Promise<T>,
  opts: { env?: Partial<Env>; extend?: (app: Express) => void } = {},
): Promise<T> {
  const s = new TestServer(opts);
  await s.listen();
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}
