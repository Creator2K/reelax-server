// 运行日志 API（前端「刷新后回填」直接用它）
//
// 页面以前只靠 WebSocket 现推，刷新一下就空白了；现在会在挂载时拉一次历史。
// 这里钉住三件事：顺序（旧→新，前端直接渲染）、隔离（只看得到自己的）、上限（一次最多 1000 条）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";

let app: FullApp;

beforeAll(async () => {
  app = await buildFullApp();
});

afterAll(async () => {
  await app.close();
});

type Entry = { t: number; level: string; tag: string; msg: string; accountId: string | null };

describe("运行日志 API", () => {
  it("★ history=1 按「旧 → 新」返回自己的日志（前端直接渲染这个顺序）", async () => {
    const A = app.seedApprovedUser("logs-a@example.com");
    const accountId = app.seedAccount(A.id, "甲号");
    for (let i = 0; i < 5; i++) {
      app.repos.logs.insert({ userId: A.id, accountId, level: "info", tag: "测试", msg: `第 ${i} 条`, createdAt: 1000 + i });
    }

    const r = await app.get<Entry[]>("/api/logs?history=1&limit=1000", A.jar);
    expect(r.status).toBe(200);
    // 只看这个用例自己插的 5 条（服务启动那几行是系统级日志，也会一起返回）
    const mine = r.body.filter((e) => e.msg.startsWith("第 ")).map((e) => e.msg);
    expect(mine).toEqual(["第 0 条", "第 1 条", "第 2 条", "第 3 条", "第 4 条"]);
    expect(r.body.find((e) => e.msg === "第 0 条")?.accountId).toBe(accountId);
  });

  it("★ 只看得到自己的日志（别人的、系统级的一条都没有）", async () => {
    const A = app.seedApprovedUser("logs-a2@example.com");
    const B = app.seedApprovedUser("logs-b2@example.com");
    app.repos.logs.insert({ userId: A.id, level: "info", tag: "测试", msg: "甲的日志" });
    app.repos.logs.insert({ userId: B.id, level: "info", tag: "测试", msg: "乙的日志" });
    // 无归属（系统级）的日志：服务启动/迁移这类，**只在管理员日志页可见**
    app.repos.logs.insert({ userId: null, level: "error", tag: "系统", msg: "系统级日志" });

    const rb = await app.get<Entry[]>("/api/logs?history=1&limit=1000", B.jar);
    const msgs = rb.body.map((e) => e.msg);
    expect(msgs).toContain("乙的日志");
    expect(msgs).not.toContain("甲的日志"); // ★ 别人的不能有
    expect(msgs).not.toContain("系统级日志"); // ★ 系统级也不给普通用户看（用户反馈过"怎么显示管理员的东西"）
  });

  it("limit 允许到 1000，超过就拒绝（前端一次拉满 1000 条）", async () => {
    const A = app.seedApprovedUser("logs-a3@example.com");
    expect((await app.get("/api/logs?history=1&limit=1000", A.jar)).status).toBe(200);
    expect((await app.get("/api/logs?history=1&limit=1001", A.jar)).status).toBe(400);
  });

  it("不带 history 时走内存环形缓冲（实时视图，也按用户过滤）", async () => {
    const A = app.seedApprovedUser("logs-a4@example.com");
    // 测试环境的 Logger 只记 error 及以上（保持测试安静），所以这里用 error 级别
    app.logger.push("error", "测试", "内存里的甲日志", { userId: A.id });
    app.logger.push("error", "测试", "内存里的乙日志", { userId: "别的人" });
    app.logger.push("error", "测试", "内存里的系统日志");

    const r = await app.get<Entry[]>("/api/logs?limit=100&level=error", A.jar);
    expect(r.status).toBe(200);
    expect(r.body.some((e) => e.msg === "内存里的甲日志")).toBe(true);
    expect(r.body.some((e) => e.msg === "内存里的乙日志")).toBe(false);
    // 系统级（无归属）也不出现在普通用户的实时视图里
    expect(r.body.some((e) => e.msg === "内存里的系统日志")).toBe(false);
  });

  it("按级别筛选：只要 warn 以上时 info 不返回", async () => {
    const A = app.seedApprovedUser("logs-a5@example.com");
    app.repos.logs.insert({ userId: A.id, level: "info", tag: "测试", msg: "普通信息" });
    app.repos.logs.insert({ userId: A.id, level: "warn", tag: "测试", msg: "警告信息" });

    const r = await app.get<Entry[]>("/api/logs?history=1&level=warn&limit=1000", A.jar);
    const msgs = r.body.map((e) => e.msg);
    expect(msgs).toContain("警告信息");
    expect(msgs).not.toContain("普通信息");
  });

  it("★ 清除日志只清自己的（别人的和系统级的都留着）", async () => {
    const A = app.seedApprovedUser("logs-clear-a@example.com");
    const B = app.seedApprovedUser("logs-clear-b@example.com");
    app.repos.logs.insert({ userId: A.id, level: "info", tag: "测试", msg: "甲要清掉的" });
    app.repos.logs.insert({ userId: B.id, level: "info", tag: "测试", msg: "乙的日志" });
    app.repos.logs.insert({ userId: null, level: "info", tag: "引擎", msg: "系统级日志" });
    app.logger.push("error", "测试", "甲的内存日志", { userId: A.id });
    app.logger.push("error", "测试", "乙的内存日志", { userId: B.id });

    const r = await app.del<{ removed: number; forgotten: number }>("/api/logs", A.jar);
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(1);
    expect(r.body.forgotten).toBe(1);

    // 甲的没了
    const a = await app.get<Entry[]>("/api/logs?history=1&limit=1000", A.jar);
    expect(a.body.some((e) => e.msg === "甲要清掉的")).toBe(false);
    // 别人的与系统级的日志都还在（只是普通用户看不到系统级）
    const b = await app.get<Entry[]>("/api/logs?history=1&limit=1000", B.jar);
    expect(b.body.some((e) => e.msg === "乙的日志")).toBe(true);
    expect(b.body.some((e) => e.msg === "系统级日志")).toBe(false);
    // 内存缓冲同样只丢自己的
    expect(app.logger.recent({ userId: A.id, limit: 100 }).some((e) => e.msg === "甲的内存日志")).toBe(false);
    expect(app.logger.recent({ userId: B.id, limit: 100 }).some((e) => e.msg === "乙的内存日志")).toBe(true);
  });

  it("清除日志需要登录", async () => {
    expect((await app.del("/api/logs")).status).toBe(401);
  });
});
