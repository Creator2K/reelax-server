// 认证与引导流程的安全回归测试。
//
// 这几条都对应线上可触发的边界：
//  - 空库并发注册时只能有一个管理员
//  - 关闭注册后，空库也不能绕过开关创建管理员
//  - 环境变量重置管理员口令后，旧会话必须立即失效
import { describe, expect, it } from "vitest";
import { buildFullApp } from "./helpers/full-app.ts";

describe("注册与管理员引导", () => {
  it("★ 空库并发注册只产生一个管理员，另一个正常消费邀请码", async () => {
    const app = await buildFullApp({ limits: { register: { windowMs: 60_000, max: 10 } } });
    try {
      const invite = app.repos.invites.create({ code: "CONCURRENT", maxUses: 1 });
      const register = (username: string) =>
        app.post("/api/auth/register", {
          username,
          password: `${username}-pw-1`,
          inviteCode: invite.code,
        });

      const [a, b] = await Promise.all([register("race-a"), register("race-b")]);
      expect([a.status, b.status].sort()).toEqual([201, 201]);
      expect([a.body.becameAdmin, b.body.becameAdmin].filter(Boolean)).toHaveLength(1);
      expect(app.repos.users.countAll()).toBe(2);
      expect(app.repos.users.count({ role: "admin" })).toBe(1);
      expect(app.repos.invites.findByCode(invite.code)?.used_count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("★ 关闭自助注册后，空库也不能被首位注册者绕过", async () => {
    const app = await buildFullApp({ env: { allowRegistration: false } });
    try {
      const r = await app.post("/api/auth/register", {
        username: "first-user",
        password: "first-user-pw-1",
      });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("REGISTRATION_DISABLED");
      expect(app.repos.users.countAll()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("★ 用环境变量重置管理员口令后，旧登录会话立即失效", async () => {
    const app = await buildFullApp();
    try {
      const user = app.seedApprovedUser("reset-admin@example.com");
      expect(app.repos.sessions.listForUser(user.id)).toHaveLength(1);

      const result = await app.auth.ensureAdminAccount({
        username: "reset-admin@example.com",
        password: "new-admin-pw-1",
      });

      expect(result.created).toBe(false);
      expect(app.repos.users.findById(user.id)?.role).toBe("admin");
      expect(app.repos.sessions.listForUser(user.id)).toHaveLength(0);
      expect((await app.get("/api/auth/me", user.jar)).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
