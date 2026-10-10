// 越权与配额矩阵
//
// 这是多用户服务里风险最高的一块，因此逐条写死预期：
//  - 越权访问一律 404（不泄漏资源是否存在）
//  - pending 用户被挡在所有业务接口之外
//  - 配额、并发上限有明确错误码
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";

let app: FullApp;
/** 用户 A（普通）、用户 B（普通）、管理员 */
let A: { jar: ReturnType<FullApp["seedApprovedUser"]>["jar"]; id: string };
let B: { jar: ReturnType<FullApp["seedApprovedUser"]>["jar"]; id: string };
let admin: { jar: ReturnType<FullApp["seedApprovedUser"]>["jar"]; id: string };
let aAccount: string;
let bAccount: string;
let bProxy: string;

beforeAll(async () => {
  app = await buildFullApp();
  A = app.seedApprovedUser("a@example.com");
  B = app.seedApprovedUser("b@example.com");
  admin = app.seedApprovedUser("admin@example.com", "admin");
  aAccount = app.seedAccount(A.id, "A 的账号");
  bAccount = app.seedAccount(B.id, "B 的账号");
  bProxy = app.seedProxy(B.id, "B 的代理");
});

afterAll(async () => {
  await app.close();
});

describe("账号：跨用户隔离", () => {
  it("A 能读自己的账号", async () => {
    const r = await app.get<{ id: string }>(`/api/accounts/${aAccount}`, A.jar);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(aAccount);
  });

  it("A 读 B 的账号 → 404（不是 403，避免存在性泄漏）", async () => {
    const r = await app.get(`/api/accounts/${bAccount}`, A.jar);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("A 改 B 的账号 → 404，且数据未变", async () => {
    const r = await app.patch(`/api/accounts/${bAccount}`, { label: "被改名了" }, A.jar);
    expect(r.status).toBe(404);
    expect(app.repos.accounts.findById(bAccount)?.label).toBe("B 的账号");
  });

  it("A 删 B 的账号 → 404，且账号仍在", async () => {
    const r = await app.del(`/api/accounts/${bAccount}`, A.jar);
    expect(r.status).toBe(404);
    expect(app.repos.accounts.findById(bAccount)).toBeDefined();
  });

  it("A 启停 B 的账号 → 404（不会真的去启动别人的账号）", async () => {
    expect((await app.post(`/api/accounts/${bAccount}/start`, {}, A.jar)).status).toBe(404);
    expect((await app.post(`/api/accounts/${bAccount}/stop`, {}, A.jar)).status).toBe(404);
    expect(app.registry.statusOf(bAccount)).toBe("stopped");
  });

  it("A 读 B 账号的模块状态 → 404", async () => {
    expect((await app.get(`/api/accounts/${bAccount}/modules`, A.jar)).status).toBe(404);
  });

  it("A 改 B 账号的模块 → 404，且 B 的模块配置未被写入", async () => {
    const r = await app.patch(`/api/accounts/${bAccount}/modules/keep-online`, { enabled: true }, A.jar);
    expect(r.status).toBe(404);
    expect(app.repos.modules.find(bAccount, "keep-online")).toBeNull();
  });

  it("列表只返回自己的账号", async () => {
    const ra = await app.get<{ id: string }[]>("/api/accounts", A.jar);
    const rb = await app.get<{ id: string }[]>("/api/accounts", B.jar);
    expect(ra.body.map((x) => x.id)).toEqual([aAccount]);
    expect(rb.body.map((x) => x.id)).toEqual([bAccount]);
  });
});

describe("代理：跨用户隔离", () => {
  it("A 读 B 的代理 → 404", async () => {
    expect((await app.get(`/api/proxies/${bProxy}`, A.jar)).status).toBe(404);
  });

  it("A 改/删 B 的代理 → 404，数据未变", async () => {
    expect((await app.patch(`/api/proxies/${bProxy}`, { label: "hacked" }, A.jar)).status).toBe(404);
    expect((await app.del(`/api/proxies/${bProxy}`, A.jar)).status).toBe(404);
    expect(app.repos.proxies.findById(bProxy)?.label).toBe("B 的代理");
  });

  it("A 测 B 的代理 → 404（不能拿别人的代理做探测）", async () => {
    expect((await app.post(`/api/proxies/${bProxy}/test`, {}, A.jar)).status).toBe(404);
  });

  it("A 把账号绑到 B 的代理 → 400 PROXY_NOT_OWNED", async () => {
    const r = await app.post("/api/accounts", { label: "A 的第二个账号", email: "a2@x.com", password: "pw123456", proxyId: bProxy }, A.jar);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("PROXY_NOT_OWNED");
  });

  it("代理列表只返回自己的", async () => {
    const ra = await app.get<{ id: string }[]>("/api/proxies", A.jar);
    const rb = await app.get<{ id: string }[]>("/api/proxies", B.jar);
    expect(ra.body).toHaveLength(0);
    expect(rb.body.map((x) => x.id)).toEqual([bProxy]);
  });
});

describe("未登录与未审批", () => {
  it("未登录访问业务接口 → 401", async () => {
    for (const path of ["/api/accounts", "/api/proxies", "/api/modules"]) {
      expect((await app.get(path)).status, path).toBe(401);
    }
  });

  it("pending 用户访问业务接口 → 403 NOT_APPROVED", async () => {
    const pending = app.repos.users.create({
      email: "pending@example.com",
      passwordHash: "scrypt$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      displayName: "等审批",
      status: "pending",
    });
    const jar = new (await import("./helpers/server.ts")).CookieJar();
    const token = app.auth.createSession(pending, null, null);
    jar.absorb([`reelax_session=${token.token}; Path=/; HttpOnly; SameSite=Lax`]);

    const r = await app.get("/api/accounts", jar);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("NOT_APPROVED");

    // 但 /api/auth/me 是允许的（前端要靠它渲染「等待审批」提示）
    expect((await app.get("/api/auth/me", jar)).status).toBe(200);
  });

  it("伪造 cookie → 401", async () => {
    const { CookieJar } = await import("./helpers/server.ts");
    const jar = new CookieJar();
    jar.absorb(["reelax_session=forged-token; Path=/"]);
    expect((await app.get("/api/accounts", jar)).status).toBe(401);
  });
});

describe("配额与并发上限", () => {
  it("超过单用户账号配额 → 400 ACCOUNT_QUOTA_EXCEEDED", async () => {
    const limited = await buildFullApp({ env: { maxAccountsPerUser: 2 } });
    try {
      const u = limited.seedApprovedUser("q@example.com");
      for (let i = 0; i < 2; i++) {
        const r = await limited.post(
          "/api/accounts",
          { label: `acc${i}`, email: `q${i}@x.com`, password: "pw123456" },
          u.jar,
        );
        expect(r.status).toBe(201);
      }
      const over = await limited.post("/api/accounts", { label: "第三个", email: "q9@x.com", password: "pw123456" }, u.jar);
      expect(over.status).toBe(400);
      expect(over.body.error.code).toBe("ACCOUNT_QUOTA_EXCEEDED");
    } finally {
      await limited.close();
    }
  });
});

describe("管理员专属路由", () => {
  it("管理员可以访问 /api/admin/users，且能看到全部用户", async () => {
    const r = await app.get<{ users: { id: string }[]; counts: { total: number } }>("/api/admin/users", admin.jar);
    expect(r.status).toBe(200);
    expect(r.body.counts.total).toBeGreaterThanOrEqual(3);
    const ids = r.body.users.map((u) => u.id);
    expect(ids).toContain(A.id);
    expect(ids).toContain(B.id);
  });

  it("普通用户访问 /api/admin/users → 403 ADMIN_ONLY", async () => {
    const r = await app.get<{ error: { code: string } }>("/api/admin/users", A.jar);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("ADMIN_ONLY");
  });

  it("普通用户访问 /api/admin/invites → 403（不能自助发邀请码）", async () => {
    expect((await app.get("/api/admin/invites", A.jar)).status).toBe(403);
    expect((await app.post("/api/admin/invites", { maxUses: 1 }, A.jar)).status).toBe(403);
  });

  it("普通用户访问 /api/admin/audit → 403（审计日志不给普通用户看）", async () => {
    expect((await app.get("/api/admin/audit", A.jar)).status).toBe(403);
  });

  it("未登录访问 /api/admin/* → 401", async () => {
    expect((await app.get("/api/admin/users")).status).toBe(401);
  });

  it("管理员不能封禁自己（避免把自己锁在门外）", async () => {
    const r = await app.patch(`/api/admin/users/${admin.id}/status`, { status: "banned" }, admin.jar);
    expect(r.status).toBe(400);
    expect(app.repos.users.findById(admin.id)?.status).toBe("approved");
  });

  it("管理员不能降级自己", async () => {
    const r = await app.patch(`/api/admin/users/${admin.id}/role`, { role: "user" }, admin.jar);
    expect(r.status).toBe(400);
    expect(app.repos.users.findById(admin.id)?.role).toBe("admin");
  });

  it("封禁用户会停掉他的全部账号", async () => {
    // 先让 B 的账号进入「运行中」状态（不真的启动，只改状态即可验证停手逻辑）
    const bRun = app.registry.require(bAccount);
    bRun.status = "online";
    expect(app.registry.runningCount).toBeGreaterThan(0);

    const r = await app.patch(`/api/admin/users/${B.id}/status`, { status: "banned" }, admin.jar);
    expect(r.status).toBe(200);

    // stopAllForUser 是 fire-and-forget 的（void 调用），等一下让它跑完
    await new Promise((res) => setTimeout(res, 300));
    expect(app.registry.statusOf(bAccount)).toBe("stopped");
  });
});

describe("模块清单", () => {
  it("返回全部 16 个内置功能，且带 configSchema", async () => {
    const r = await app.get<
      { id: string; name: string; defaultEnabled: boolean; defaultConfig: Record<string, unknown>; configSchema: unknown[] }[]
    >("/api/modules", A.jar);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(16);
    const ids = r.body.map((m) => m.id);
    expect(ids).toContain("keep-online");
    expect(ids).toContain("daily-digest");
    expect(ids).toContain("auto-loadout");
    expect(ids).toContain("auto-schedule");
    expect(ids).toContain("auto-sacrifice");
    expect(ids).toContain("auto-guild-boost");
    // 与官方助手解耦后不该再有「代驱动 / 接管」那个模块
    expect(ids).not.toContain("auto-assistant");
    expect(ids).toContain("auto-schedule");
    // 只有保持在线默认开启
    const defaults = r.body.filter((m) => m.defaultEnabled).map((m) => m.id);
    expect(defaults).toEqual(["keep-online"]);
    for (const m of r.body) {
      expect(m.configSchema.length, m.id).toBeGreaterThan(0);
      expect(Object.keys(m.defaultConfig).length, m.id).toBeGreaterThan(0);
    }
  });

  it("未登录 → 401", async () => {
    expect((await app.get("/api/modules")).status).toBe(401);
  });
});

describe("模块配置校验", () => {
  it("非法取值被拒（不静默丢弃）", async () => {
    const r = await app.patch(
      `/api/accounts/${aAccount}/modules/keep-online`,
      { config: { syncJitterMs: 99999 } },
      A.jar,
    );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_CONFIG");
  });

  it("未知配置键被拒", async () => {
    const r = await app.patch(
      `/api/accounts/${aAccount}/modules/keep-online`,
      { config: { notARealKey: 1 } },
      A.jar,
    );
    expect(r.status).toBe(400);
  });

  it("合法配置被接受并持久化", async () => {
    const r = await app.patch(
      `/api/accounts/${aAccount}/modules/keep-online`,
      { config: { syncJitterMs: 300, autoRefill: false } },
      A.jar,
    );
    expect(r.status).toBe(200);
    const stored = app.repos.modules.find(aAccount, "keep-online");
    expect(stored?.config.syncJitterMs).toBe(300);
    expect(stored?.config.autoRefill).toBe(false);
  });

  it("不存在的模块 → 404", async () => {
    const r = await app.patch(`/api/accounts/${aAccount}/modules/nope`, { enabled: true }, A.jar);
    expect(r.status).toBe(404);
  });

  it("恢复默认会清掉自定义值（但保留开关状态）", async () => {
    // 先打开功能并自定义一个值
    await app.patch(`/api/accounts/${aAccount}/modules/keep-online`, { enabled: true }, A.jar);
    await app.patch(`/api/accounts/${aAccount}/modules/keep-online`, { config: { syncJitterMs: 1200 } }, A.jar);
    expect(app.repos.modules.find(aAccount, "keep-online")?.config.syncJitterMs).toBe(1200);
    expect(app.repos.modules.find(aAccount, "keep-online")?.enabled).toBe(true);

    const r = await app.post<{ states: { id: string; enabled: boolean; config: Record<string, unknown> }[] }>(
      `/api/accounts/${aAccount}/modules/keep-online/reset`,
      {},
      A.jar,
    );
    expect(r.status).toBe(200);

    const state = r.body.states.find((s) => s.id === "keep-online");
    // 恢复默认 = 回到 defaultConfig（600），而不是留下空值
    expect(state?.config.syncJitterMs).toBe(600);
    // 开关不能被顺手重置 —— 否则点一下「恢复默认」就意外关掉了功能
    expect(state?.enabled).toBe(true);
  });

  it("恢复默认后数据库里不再有自定义键（靠取值时合并默认值）", async () => {
    const stored = app.repos.modules.find(aAccount, "keep-online");
    expect(stored?.config.syncJitterMs).toBeUndefined();
    // 但对外呈现的是完整配置（默认值 + 覆盖）
    const states = await app.get<{ id: string; config: Record<string, unknown> }[]>(`/api/accounts/${aAccount}/modules`, A.jar);
    expect(states.body.find((s) => s.id === "keep-online")?.config.syncJitterMs).toBe(600);
  });
});
