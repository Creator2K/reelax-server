// 用户名注册 + 在线设置 的集成测试
//
// 覆盖两条本轮新增的行为：
//  1) 注册只要用户名与口令（不再要邮箱），且历史上用邮箱注册的用户照常能登录
//  2) 后台设置改动**立即生效**（注册开关、邀请码开关、账号额度、并发上限）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";

let app: FullApp;
let admin: { jar: ReturnType<FullApp["seedApprovedUser"]>["jar"]; id: string };

beforeAll(async () => {
  // 注册限流默认是「5 次/小时」，一个文件里注册十几次会被拦 —— 放宽它
  app = await buildFullApp({ limits: { register: { windowMs: 60_000, max: 200 } } });
  admin = app.seedApprovedUser("admin", "admin");
  // 默认要求邀请码（公开站点更安全）。这一组测试关注「用户名注册」本身，
  // 所以先把邀请码关掉；邀请码相关的那条测试会单独再打开验证。
  await app.patch("/api/admin/settings", { patch: { requireInvite: false } }, admin.jar);
});
afterAll(async () => {
  await app.close();
});

describe("注册：用户名 + 口令", () => {
  it("★ 用户名注册成功（不需要邮箱）", async () => {
    const r = await app.post("/api/auth/register", {
      username: "xiaowang",
      password: "xiaowang-pw-1",
    });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe("xiaowang");
    // 没填显示名时用用户名兜底
    expect(r.body.user.displayName).toBe("xiaowang");
    expect(r.body.user.status).toBe("approved");
  });

  it("可以用用户名登录", async () => {
    const r = await app.post("/api/auth/login", { username: "xiaowang", password: "xiaowang-pw-1" });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe("xiaowang");
  });

  it("邮箱格式的标识同样能用（兼容老用户）", async () => {
    const reg = await app.post("/api/auth/register", {
      username: "old@example.com",
      password: "olduser-pw-1",
    });
    expect(reg.status).toBe(201);
    const login = await app.post("/api/auth/login", { username: "old@example.com", password: "olduser-pw-1" });
    expect(login.status).toBe(200);
  });

  it("太短 / 带空格的用户名被拒绝", async () => {
    expect((await app.post("/api/auth/register", { username: "ab", password: "pw-123456" })).status).toBe(400);
    expect((await app.post("/api/auth/register", { username: "has space", password: "pw-123456" })).status).toBe(400);
    expect((await app.post("/api/auth/register", { username: "a/b", password: "pw-123456" })).status).toBe(400);
  });

  it("重名被拒绝", async () => {
    const r = await app.post("/api/auth/register", { username: "xiaowang", password: "another-pw-1" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("USERNAME_TAKEN");
  });

  it("口令仍然有长度下限（在请求校验层就被拦下）", async () => {
    const r = await app.post("/api/auth/register", { username: "shortpw", password: "123" });
    expect(r.status).toBe(400);
    // 长度限制写在校验 schema 里，所以错误码是 VALIDATION_ERROR 而不是 WEAK_PASSWORD
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("设置：在线修改并立即生效", () => {
  it("默认要求邀请码（公开站点更安全）—— 这一项在 seed 之后被测试改成 false，单独验证语义", async () => {
    // 前面 beforeAll 已关掉；这里重新打开验证「打开时确实要邀请码」
    await app.patch("/api/admin/settings", { patch: { requireInvite: true } }, admin.jar);
    const sys = await app.get<{ requireInvite: boolean; allowRegistration: boolean }>("/api/auth/system");
    expect(sys.body.requireInvite).toBe(true);
    expect(sys.body.allowRegistration).toBe(true);

    const denied = await app.post("/api/auth/register", { username: "needsinvite", password: "needsinvite-pw" });
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe("INVITE_REQUIRED");

    // 关掉后立刻可以不带邀请码注册（不重启）
    await app.patch("/api/admin/settings", { patch: { requireInvite: false } }, admin.jar);
    const ok = await app.post("/api/auth/register", { username: "noinvite", password: "noinvite-pw-1" });
    expect(ok.status).toBe(201);
  });

  it("管理员能看到设置清单（含初始值与是否改过）", async () => {
    const r = await app.get<{ items: { key: string; value: unknown; envValue: unknown; overridden: boolean }[] }>(
      "/api/admin/settings",
      admin.jar,
    );
    expect(r.status).toBe(200);
    const keys = r.body.items.map((i) => i.key);
    for (const k of ["allowRegistration", "requireInvite", "maxAccountsPerUser", "maxRunningAccounts"]) {
      expect(keys).toContain(k);
    }
    // 已被改过的项会标出来
    expect(r.body.items.find((i) => i.key === "requireInvite")?.overridden).toBe(true);
  });

  it("★ 关掉自助注册后，新用户注册被拒", async () => {
    await app.patch("/api/admin/settings", { patch: { allowRegistration: false } }, admin.jar);

    const sys = await app.get<{ allowRegistration: boolean }>("/api/auth/system");
    expect(sys.body.allowRegistration).toBe(false);

    const reg = await app.post("/api/auth/register", { username: "closedreg", password: "closedreg-pw-1" });
    expect(reg.status).toBe(403);
    expect(reg.body.error.code).toBe("REGISTRATION_DISABLED");

    // 复原，避免影响后续测试
    await app.patch("/api/admin/settings", { patch: { allowRegistration: true } }, admin.jar);
  });

  it("★ 每用户账号额度改动立即生效", async () => {
    const user = app.seedApprovedUser("quota-user");
    await app.patch("/api/admin/settings", { patch: { maxAccountsPerUser: 1 } }, admin.jar);

    // 第 1 个能加
    const first = await app.post(
      "/api/accounts",
      { label: "额度测试-1", email: "q1@example.com", password: "gamepw-1", autoStart: false },
      user.jar,
    );
    expect(first.status).toBe(201);

    // 第 2 个被上限拦住
    const second = await app.post(
      "/api/accounts",
      { label: "额度测试-2", email: "q2@example.com", password: "gamepw-1", autoStart: false },
      user.jar,
    );
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("ACCOUNT_QUOTA_EXCEEDED");

    // 放宽到 3 后立刻能加
    await app.patch("/api/admin/settings", { patch: { maxAccountsPerUser: 3 } }, admin.jar);
    const third = await app.post(
      "/api/accounts",
      { label: "额度测试-3", email: "q3@example.com", password: "gamepw-1", autoStart: false },
      user.jar,
    );
    expect(third.status).toBe(201);
  });

  it("非法设置值被拒绝，且不会写坏已有值", async () => {
    const before = await app.get<{ items: { key: string; value: unknown }[] }>("/api/admin/settings", admin.jar);
    const beforeVal = before.body.items.find((i) => i.key === "maxRunningAccounts")?.value;

    const bad = await app.patch("/api/admin/settings", { patch: { maxRunningAccounts: 0 } }, admin.jar);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_SETTING");

    const after = await app.get<{ items: { key: string; value: unknown }[] }>("/api/admin/settings", admin.jar);
    expect(after.body.items.find((i) => i.key === "maxRunningAccounts")?.value).toBe(beforeVal);
  });

  it("普通用户不能读改设置", async () => {
    const user = app.seedApprovedUser("plain-user");
    expect((await app.get("/api/admin/settings", user.jar)).status).toBe(403);
    expect((await app.patch("/api/admin/settings", { patch: { maxAccountsPerUser: 99 } }, user.jar)).status).toBe(403);
  });

  it("设置项在「重启」后仍然生效（环境变量只是初始值）", async () => {
    // 直接看数据库里持久化后的值：settings.update 走的是同一路径
    await app.patch("/api/admin/settings", { patch: { logRetentionDays: 30 } }, admin.jar);
    const rows = app.db.all<{ key: string; value: string }>(
      "SELECT key, value FROM app_settings WHERE key = 'logRetentionDays'",
    );
    expect(JSON.parse(rows[0]!.value)).toBe(30);
  });
});

describe("用户管理：搜索与批量", () => {
  it("按用户名搜索", async () => {
    const r = await app.get<{ users: { email: string }[]; filtered: number }>(
      "/api/admin/users?q=xiaowang",
      admin.jar,
    );
    expect(r.status).toBe(200);
    expect(r.body.users.every((u) => u.email.includes("xiaowang"))).toBe(true);
    expect(r.body.filtered).toBeGreaterThanOrEqual(1);
  });

  it("按状态筛选", async () => {
    const r = await app.get<{ users: { status: string }[] }>("/api/admin/users?status=banned", admin.jar);
    expect(r.status).toBe(200);
    expect(r.body.users.every((u) => u.status === "banned")).toBe(true);
  });

  it("按角色筛选", async () => {
    const r = await app.get<{ users: { role: string }[] }>("/api/admin/users?role=admin", admin.jar);
    expect(r.status).toBe(200);
    expect(r.body.users.every((u) => u.role === "admin")).toBe(true);
  });

  it("★ 批量封禁 / 解封", async () => {
    const a = app.seedApprovedUser("bulk-a");
    const b = app.seedApprovedUser("bulk-b");

    const ban = await app.post("/api/admin/users/bulk", { userIds: [a.id, b.id], action: "ban" }, admin.jar);
    expect(ban.status).toBe(200);
    expect(ban.body.updated).toHaveLength(2);
    expect(app.repos.users.findById(a.id)?.status).toBe("banned");
    expect(app.repos.users.findById(b.id)?.status).toBe("banned");

    const unban = await app.post("/api/admin/users/bulk", { userIds: [a.id, b.id], action: "unban" }, admin.jar);
    expect(unban.body.updated).toHaveLength(2);
    expect(app.repos.users.findById(a.id)?.status).toBe("approved");
  });

  it("★ 批量里有一条不合法时，其余照常处理并回报失败原因", async () => {
    const ok = app.seedApprovedUser("bulk-ok");
    // 把「自己」放进列表：服务端有「不能改自己状态」的约束
    const r = await app.post("/api/admin/users/bulk", { userIds: [ok.id, admin.id], action: "ban" }, admin.jar);
    expect(r.status).toBe(200);
    expect(r.body.updated).toEqual([ok.id]);
    expect(r.body.failed).toHaveLength(1);
    expect(r.body.failed[0].userId).toBe(admin.id);
    expect(r.body.failed[0].reason).toBeTruthy();
  });

  it("批量列表为空时被拒绝", async () => {
    const r = await app.post("/api/admin/users/bulk", { userIds: [], action: "ban" }, admin.jar);
    expect(r.status).toBe(400);
  });

  it("普通用户不能批量操作", async () => {
    const user = app.seedApprovedUser("bulk-plain");
    const r = await app.post("/api/admin/users/bulk", { userIds: [user.id], action: "ban" }, user.jar);
    expect(r.status).toBe(403);
  });

  it("管理员建号也走用户名口径", async () => {
    const r = await app.post("/api/admin/users", { username: "madebyadmin" }, admin.jar);
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe("madebyadmin");
    // 没给口令时返回一次性初始口令
    expect(r.body.initialPassword).toBeTruthy();
  });
});

describe("更新记录", () => {
  it("公开可读，含当前版本与内容", async () => {
    const r = await app.get<{
      version: string;
      latest: { version: string; changes: unknown[] };
      entries: unknown[];
    }>("/api/auth/changelog");
    expect(r.status).toBe(200);
    // 测试脚手架里的 version 是 "test"，所以这里只能断言结构关系：
    // 最新一条必须是 changelog 的第一条，且确实有内容可展示
    expect(r.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(r.body.latest.version).toBe((r.body.entries[0] as { version: string }).version);
    expect(r.body.latest.changes.length).toBeGreaterThan(0);
  });
});
