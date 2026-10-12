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
    expect(r.body.map((e) => e.msg)).toEqual(["第 0 条", "第 1 条", "第 2 条", "第 3 条", "第 4 条"]);
    expect(r.body[0]?.accountId).toBe(accountId);
  });

  it("★ 只看得到自己的日志（别人一条都拿不到）", async () => {
    const A = app.seedApprovedUser("logs-a2@example.com");
    const B = app.seedApprovedUser("logs-b2@example.com");
    app.repos.logs.insert({ userId: A.id, level: "info", tag: "测试", msg: "甲的日志" });
    app.repos.logs.insert({ userId: B.id, level: "info", tag: "测试", msg: "乙的日志" });
    // 没归属（系统级）的日志也不该漏给别人
    app.repos.logs.insert({ userId: null, level: "error", tag: "系统", msg: "系统级日志" });

    const rb = await app.get<Entry[]>("/api/logs?history=1&limit=1000", B.jar);
    expect(rb.body.map((e) => e.msg)).toEqual(["乙的日志"]);
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

    const r = await app.get<Entry[]>("/api/logs?limit=100&level=error", A.jar);
    expect(r.status).toBe(200);
    expect(r.body.some((e) => e.msg === "内存里的甲日志")).toBe(true);
    expect(r.body.some((e) => e.msg === "内存里的乙日志")).toBe(false);
  });

  it("按级别筛选：只要 warn 以上时 info 不返回", async () => {
    const A = app.seedApprovedUser("logs-a5@example.com");
    app.repos.logs.insert({ userId: A.id, level: "info", tag: "测试", msg: "普通信息" });
    app.repos.logs.insert({ userId: A.id, level: "warn", tag: "测试", msg: "警告信息" });

    const r = await app.get<Entry[]>("/api/logs?history=1&level=warn", A.jar);
    expect(r.body.map((e) => e.msg)).toEqual(["警告信息"]);
  });
});
