// 后台编辑用户 + 单用户账号额度覆盖
//
// 「全局默认额度」与「某人的单独额度」是两层：后者优先。这组测试盯住三件事：
//  1) 能单独给某个人放宽额度，且只对他生效
//  2) 清除覆盖后回到全局默认
//  3) 改全局默认会传导到「没单独设置过」的人（这正是做成两层的意义）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";

let app: FullApp;
let admin: { jar: ReturnType<FullApp["seedApprovedUser"]>["jar"]; id: string };

beforeAll(async () => {
  app = await buildFullApp();
  admin = app.seedApprovedUser("admin", "admin");
});
afterAll(async () => {
  await app.close();
});

/** 造一个普通用户并返回它的 jar + id */
function seedUser(email: string) {
  const u = app.seedApprovedUser(email);
  return { id: u.id, jar: u.jar };
}

/** 用某个用户的身份加一个游戏账号 */
function addAccount(jar: ReturnType<FullApp["seedApprovedUser"]>["jar"], label: string) {
  return app.post(
    "/api/accounts",
    { label, email: `${label}@example.com`, password: "gamepw-123", autoStart: false },
    jar,
  );
}

describe("编辑用户：显示名与单独额度", () => {
  it("能改显示名", async () => {
    const u = seedUser("edit-name@example.com");
    const r = await app.patch(`/api/admin/users/${u.id}`, { displayName: "新名字" }, admin.jar);
    expect(r.status).toBe(200);
    expect(r.body.user.displayName).toBe("新名字");
    expect(app.repos.users.findById(u.id)?.display_name).toBe("新名字");
  });

  it("显示名不能为空 / 不能过长", async () => {
    const u = seedUser("edit-bad@example.com");
    expect((await app.patch(`/api/admin/users/${u.id}`, { displayName: "  " }, admin.jar)).status).toBe(400);
    expect((await app.patch(`/api/admin/users/${u.id}`, { displayName: "x".repeat(41) }, admin.jar)).status).toBe(400);
  });

  it("★ 单独给某人放宽额度，不影响别人", async () => {
    const a = seedUser("quota-a@example.com");
    const b = seedUser("quota-b@example.com");

    // 全局默认设成 1
    await app.patch("/api/admin/settings", { patch: { maxAccountsPerUser: 1 } }, admin.jar);

    // 给 a 单独放宽到 3
    const r = await app.patch(`/api/admin/users/${a.id}`, { quotaOverride: 3 }, admin.jar);
    expect(r.status).toBe(200);
    expect(r.body.user.quotaOverride).toBe(3);
    expect(r.body.user.accountLimit).toBe(3);

    // a 能加 3 个
    expect((await addAccount(a.jar, "qa1")).status).toBe(201);
    expect((await addAccount(a.jar, "qa2")).status).toBe(201);
    expect((await addAccount(a.jar, "qa3")).status).toBe(201);
    const fourth = await addAccount(a.jar, "qa4");
    expect(fourth.status).toBe(400);
    expect(fourth.body.error.code).toBe("ACCOUNT_QUOTA_EXCEEDED");

    // b 仍然受全局默认 1 的限制
    expect((await addAccount(b.jar, "qb1")).status).toBe(201);
    const bSecond = await addAccount(b.jar, "qb2");
    expect(bSecond.status).toBe(400);
    expect(bSecond.body.error.code).toBe("ACCOUNT_QUOTA_EXCEEDED");
  });

  it("★ 清除覆盖后回到全局默认", async () => {
    const u = seedUser("quota-clear@example.com");
    await app.patch("/api/admin/settings", { patch: { maxAccountsPerUser: 2 } }, admin.jar);
    await app.patch(`/api/admin/users/${u.id}`, { quotaOverride: 5 }, admin.jar);

    const cleared = await app.patch(`/api/admin/users/${u.id}`, { quotaOverride: null }, admin.jar);
    expect(cleared.status).toBe(200);
    expect(cleared.body.user.quotaOverride).toBeNull();
    expect(cleared.body.user.accountLimit).toBe(2);
  });

  it("★ 改全局默认会传导到没单独设置过的人", async () => {
    const u = seedUser("quota-inherit@example.com");
    await app.patch("/api/admin/settings", { patch: { maxAccountsPerUser: 1 } }, admin.jar);
    expect((await addAccount(u.jar, "qi1")).status).toBe(201);
    expect((await addAccount(u.jar, "qi2")).status).toBe(400);

    // 放宽全局默认 → 该用户立刻能再加
    await app.patch("/api/admin/settings", { patch: { maxAccountsPerUser: 3 } }, admin.jar);
    expect((await addAccount(u.jar, "qi2")).status).toBe(201);

    // 而单独设置过额度的人不受全局变化影响
    const pinned = seedUser("quota-pinned@example.com");
    await app.patch(`/api/admin/users/${pinned.id}`, { quotaOverride: 1 }, admin.jar);
    await app.patch("/api/admin/settings", { patch: { maxAccountsPerUser: 9 } }, admin.jar);
    const listed = await app.get<{ users: { id: string; accountLimit: number }[] }>(
      "/api/admin/users?q=quota-pinned",
      admin.jar,
    );
    expect(listed.body.users.find((x) => x.id === pinned.id)?.accountLimit).toBe(1);
  });

  it("额度只接受 1~100 的整数", async () => {
    const u = seedUser("quota-range@example.com");
    for (const bad of [0, -1, 101, 1.5]) {
      const r = await app.patch(`/api/admin/users/${u.id}`, { quotaOverride: bad }, admin.jar);
      expect(r.status, `quota=${bad}`).toBe(400);
    }
  });

  it("用户不存在时 404", async () => {
    expect((await app.patch("/api/admin/users/does-not-exist", { displayName: "x" }, admin.jar)).status).toBe(404);
  });

  it("普通用户不能编辑别人", async () => {
    const attacker = seedUser("edit-attacker@example.com");
    const victim = seedUser("edit-victim@example.com");
    const r = await app.patch(`/api/admin/users/${victim.id}`, { quotaOverride: 99 }, attacker.jar);
    expect(r.status).toBe(403);
    // 没被改到
    expect(app.repos.users.findById(victim.id)?.quota_override).toBeNull();
  });

  it("★ 用户列表里带出额度信息（前端要显示「已单独设置」）", async () => {
    const u = seedUser("quota-list@example.com");
    await app.patch(`/api/admin/users/${u.id}`, { quotaOverride: 4 }, admin.jar);

    const r = await app.get<{ users: { id: string; quotaOverride: number | null; accountLimit: number }[] }>(
      "/api/admin/users?limit=200",
      admin.jar,
    );
    const found = r.body.users.find((x) => x.id === u.id);
    expect(found?.quotaOverride).toBe(4);
    expect(found?.accountLimit).toBe(4);
  });

  it("编辑会留下审计记录", async () => {
    const u = seedUser("quota-audit@example.com");
    await app.patch(`/api/admin/users/${u.id}`, { displayName: "审计测试", quotaOverride: 2 }, admin.jar);

    const audit = await app.get<{ action: string; target: string | null }[]>(
      "/api/admin/audit?action=admin.user.updated&limit=20",
      admin.jar,
    );
    expect(audit.body.some((a) => a.target === u.id)).toBe(true);
  });
});
