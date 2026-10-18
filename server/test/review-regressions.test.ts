import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import { AccountScheduleService } from "../src/services/account-schedule-service.ts";
import { ProxyDispatcherHolder, proxyFingerprint } from "../src/game/proxy.ts";
import { TtlCache } from "../src/lib/timers.ts";

let app: FullApp;
let seq = 0;
beforeAll(async () => { app = await buildFullApp(); });
afterAll(async () => { await app.close(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const user = () => app.seedApprovedUser(`review-${++seq}@example.com`);

describe("登录会话续期", () => {
  it("续期数据库的同时续期浏览器 Cookie，未接近过期时不反复下发", async () => {
    const u = user();
    const session = app.repos.sessions.listForUser(u.id)[0]!;
    app.db.run("UPDATE auth_sessions SET expires_at = ? WHERE id = ?", Date.now() + 1000, session.id);
    const renewed = await app.get("/api/auth/me", u.jar);
    expect(renewed.status).toBe(200);
    expect(renewed.cookies).toHaveLength(1);
    expect(renewed.cookies[0]).toContain("Max-Age=2592000");
    expect(renewed.cookies[0]).toContain("HttpOnly; SameSite=Lax");
    expect(renewed.cookies[0]).not.toContain("Secure");
    expect(app.repos.sessions.findById(session.id)!.expires_at).toBeGreaterThan(Date.now() + 2_000_000_000);
    expect((await app.get("/api/auth/me", u.jar)).cookies).toEqual([]);
  });

  it.each([true, false, undefined])("续期遵守 COOKIE_SECURE=%s", async (secure) => {
    const isolated = await buildFullApp({ env: { cookieSecure: secure } });
    try {
      const u = isolated.seedApprovedUser("secure@example.com");
      const session = isolated.repos.sessions.listForUser(u.id)[0]!;
      isolated.db.run("UPDATE auth_sessions SET expires_at = ? WHERE id = ?", Date.now() + 1000, session.id);
      const response = await isolated.request("GET", "/api/auth/me", { jar: u.jar, headers: { "x-forwarded-proto": "https" } });
      expect(response.cookies).toHaveLength(1);
      expect(response.cookies[0]!.includes("; Secure")).toBe(secure !== false);
    } finally { await isolated.close(); }
  });

  it("续期读取后台修改后的会话时长", async () => {
    const u = user();
    const admin = app.seedApprovedUser(`admin-${++seq}@example.com`, "admin");
    const session = app.repos.sessions.listForUser(u.id)[0]!;
    await app.patch("/api/admin/settings", { patch: { sessionTtlDays: 7 } }, admin.jar);
    try {
      app.db.run("UPDATE auth_sessions SET expires_at = ? WHERE id = ?", Date.now() + 1000, session.id);
      expect((await app.get("/api/auth/me", u.jar)).cookies[0]).toContain("Max-Age=604800");
    } finally {
      await app.patch("/api/admin/settings", { patch: { sessionTtlDays: 30 } }, admin.jar);
    }
  });
});

describe("启动入口必须校验账号所有者", () => {
  it.each(["banned", "pending"] as const)("%s 用户不能被定时任务重新启动", async (status) => {
    const u = user();
    const id = app.seedAccount(u.id);
    const runtime = app.registry.require(id);
    const start = vi.spyOn(runtime, "start").mockResolvedValue();
    app.repos.modules.upsert(id, "auto-schedule", { enabled: true, config: { plan: "00:00 on" } });
    app.repos.users.setStatus(u.id, status);
    const schedule = new AccountScheduleService({ repos: app.repos, registry: app.registry, logger: app.logger });
    await schedule.tick();
    expect(start).not.toHaveBeenCalled();
    expect(runtime.status).toBe("stopped");
    await expect(app.registry.start(id)).rejects.toMatchObject({ code: "OWNER_NOT_APPROVED" });
  });

  it("开机恢复跳过未审批/封禁用户，但能恢复已获批用户", async () => {
    const blocked = user();
    const approved = user();
    const ids = [blocked, approved].map((u) => {
      const id = app.seedAccount(u.id);
      app.repos.accounts.update(id, u.id, { autoStart: true });
      return id;
    });
    app.repos.users.setStatus(blocked.id, "banned");
    const blockedStart = vi.spyOn(app.registry.require(ids[0]!), "start").mockResolvedValue();
    const allowedStart = vi.spyOn(app.registry.require(ids[1]!), "start").mockResolvedValue();
    const result = await app.registry.startAutoStartAccounts();
    expect(blockedStart).not.toHaveBeenCalled();
    expect(allowedStart).toHaveBeenCalledOnce();
    expect(result).toEqual({ started: 1, failed: 0 });
  });
});

describe("代理密码热切换", () => {
  it("仅改密码也重建 Agent，日志不出现密码或密码摘要", async () => {
    const logs: string[] = [];
    const holder = new ProxyDispatcherHolder((msg) => logs.push(msg));
    const oldConfig = { protocol: "http" as const, host: "127.0.0.1", port: 9999, username: "test", password: "old-secret" };
    const next = { ...oldConfig, password: "new-secret" };
    try {
      holder.set(oldConfig);
      const previous = holder.current;
      expect(holder.set(next)).toBe(true);
      expect(holder.current).not.toBe(previous);
      expect(holder.set({ ...next })).toBe(false);
      expect(logs.join("\n")).not.toContain("secret");
      expect(logs.join("\n")).not.toContain(proxyFingerprint(next).split(":").at(-1));
    } finally { await holder.close(); }
  });
});

describe("快照成本与空值缓存", () => {
  it("一个账号的全部模块状态只读一次配置，仍保留默认值与显式开关", () => {
    const u = user();
    const id = app.seedAccount(u.id);
    app.repos.modules.upsert(id, "keep-online", { enabled: false, config: { syncJitterMs: 800 } });
    const runtime = app.registry.require(id);
    const list = vi.spyOn(app.repos.modules, "listForAccount");
    const find = vi.spyOn(app.repos.modules, "find");
    const states = runtime.moduleStates();
    expect(list).toHaveBeenCalledOnce();
    expect(find).not.toHaveBeenCalled();
    expect(states.find((s) => s.id === "keep-online")).toMatchObject({
      enabled: false, running: false, config: { syncJitterMs: 800, autoRefill: true, retrySec: 30 },
    });
    expect(states.length).toBeGreaterThan(10);
  });

  it("没有鱼饵的 null 结果也缓存，到期和主动失效后才重新加载", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const load = vi.fn(async () => null);
    const cache = new TtlCache<null>(90_000);
    await cache.get(load);
    await cache.get(load);
    expect(load).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(90_001);
    await cache.get(load);
    expect(load).toHaveBeenCalledTimes(2);
    cache.invalidate();
    await cache.get(load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("缓存加载失败可以重试，重试的并发调用合并为一次", async () => {
    const cache = new TtlCache<null>(90_000);
    await expect(cache.get(async () => { throw new Error("网络断开"); })).rejects.toThrow("网络断开");
    const load = vi.fn(async () => null);
    expect(await Promise.all([cache.get(load), cache.get(load)])).toEqual([null, null]);
    expect(load).toHaveBeenCalledOnce();
  });
});
