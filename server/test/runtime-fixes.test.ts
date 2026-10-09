// 本轮修复的回归测试（每一条都对应一个真实踩到过的 bug）
//
//  1) 模块的 bus 订阅从不释放 —— 停/启或改配置后旧实例继续收 fishing:sync，
//     两个 auto-bait 同时买饵、两个 auto-travel 抢着切图，且随每次重启线性累积。
//  2) tickLoop 每轮都调 setStatus("online", null) —— 每个账号每 ~6 秒白写一次 SQLite。
//  3) `Math.max(0, indexOf(primary)) || 1` —— 下标 0（力量）是 falsy，被静默改成智力。
//  4) cookie 的 Max-Age 取自启动时的 env 值 —— 后台改「登录态有效期」不生效。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import type { ModuleDefinition } from "../src/modules/types.ts";
import { statIndex } from "../src/modules/auto-stats/index.ts";
import { isFreshDay, isReportDue, parseReportAt } from "../src/modules/daily-digest/index.ts";
import { shouldSnapshot, SNAPSHOT_INTERVAL_MS } from "../src/lib/maintenance.ts";

let app: FullApp;
let admin: ReturnType<FullApp["seedApprovedUser"]>;

beforeAll(async () => {
  // 注册限流默认 5 次/小时，这个文件要注册几个用户 —— 放宽它
  app = await buildFullApp({ limits: { register: { windowMs: 60_000, max: 100 } } });
  admin = app.seedApprovedUser("admin", "admin");
  await app.patch("/api/admin/settings", { patch: { requireInvite: false } }, admin.jar);
});
afterAll(async () => {
  await app.close();
});

/** 造一个「只注册一个 bus 订阅」的合成模块，用来观察订阅是否被释放 */
function syntheticModule(id: string, onStartExtra?: (ctx: unknown) => void): ModuleDefinition {
  return {
    id,
    name: `合成模块 ${id}`,
    version: "1.0.0",
    description: "仅用于测试：onStart 里注册一个 bus 订阅",
    defaultEnabled: true,
    defaultConfig: {},
    configSchema: [],
    onStart(ctx) {
      ctx.on("fishing:sync", () => {
        /* 什么都不做，只为计数 */
      });
      onStartExtra?.(ctx);
    },
  };
}

describe("模块事件订阅的生命周期（曾经泄漏）", () => {
  it("★ stopModule 会释放 ctx.on 注册的订阅", async () => {
    const { id: userId } = app.seedApprovedUser("leak1@example.com");
    const accountId = app.seedAccount(userId, "泄漏测试1");
    const rt = app.registry.require(accountId);

    const baseline = app.bus.count("fishing:sync");
    await rt.startModule(syntheticModule("t-leak1"));
    expect(app.bus.count("fishing:sync")).toBe(baseline + 1);

    await rt.stopModule("t-leak1");
    expect(app.bus.count("fishing:sync")).toBe(baseline);
  });

  it("★ 反复停/启不会累积订阅（累积 = 重复买饵、重复切图）", async () => {
    const { id: userId } = app.seedApprovedUser("leak2@example.com");
    const accountId = app.seedAccount(userId, "泄漏测试2");
    const rt = app.registry.require(accountId);

    const baseline = app.bus.count("fishing:sync");
    for (let i = 0; i < 3; i++) {
      await rt.startModule(syntheticModule("t-leak2"));
      await rt.stopModule("t-leak2");
    }
    expect(app.bus.count("fishing:sync")).toBe(baseline);
  });

  it("onStart 中途抛错时，已经注册的订阅也要释放", async () => {
    const { id: userId } = app.seedApprovedUser("leak3@example.com");
    const accountId = app.seedAccount(userId, "泄漏测试3");
    const rt = app.registry.require(accountId);

    const baseline = app.bus.count("fishing:sync");
    const res = await rt.startModule(
      syntheticModule("t-leak3", () => {
        throw new Error("启动到一半失败");
      }),
    );
    expect(res.ok).toBe(false);
    expect(app.bus.count("fishing:sync")).toBe(baseline);
    expect(rt.moduleInstances).not.toContain("t-leak3");
  });
});

describe("状态写库（曾经每轮都写）", () => {
  it("★ 状态与错误都没变时不重复写库", async () => {
    const { id: userId } = app.seedApprovedUser("persist@example.com");
    const accountId = app.seedAccount(userId, "写库测试");
    const rt = app.registry.require(accountId);

    let writes = 0;
    const original = app.repos.accounts.setStatus.bind(app.repos.accounts);
    app.repos.accounts.setStatus = ((...args: Parameters<typeof original>) => {
      writes += 1;
      return original(...args);
    }) as typeof app.repos.accounts.setStatus;

    try {
      rt.setStatus("online", null);
      expect(writes).toBe(1);

      // tickLoop 每轮都会这样调用一次：内容没变就不该再写
      rt.setStatus("online", null);
      rt.setStatus("online", null);
      expect(writes).toBe(1);

      rt.setStatus("reconnecting", "网络抖动");
      expect(writes).toBe(2);
      rt.setStatus("reconnecting", "网络抖动");
      expect(writes).toBe(2);

      // 原因变了要写
      rt.setStatus("reconnecting", "换了原因");
      expect(writes).toBe(3);

      // 恢复正常（清掉 lastError）也要写
      rt.setStatus("online", null);
      expect(writes).toBe(4);
    } finally {
      app.repos.accounts.setStatus = original;
    }
  });
});

describe("自动加点的主属性下标（曾经把「力量」改成「智力」）", () => {
  it("★ 下标 0 的力量不会被改成下标 1", () => {
    expect(statIndex("strength")).toBe(0);
    expect(statIndex("intelligence")).toBe(1);
    expect(statIndex("luck")).toBe(2);
    expect(statIndex("endurance")).toBe(3);
  });

  it("名字不认识 / 为空时退回「智力」（下标 1）", () => {
    expect(statIndex("bogus")).toBe(1);
    expect(statIndex(undefined)).toBe(1);
    expect(statIndex("")).toBe(1);
  });
});

describe("登录限流不能被伪造的 X-Forwarded-For 绕过", () => {
  it("★ 默认（不信任代理头）时，客户端自己填的 XFF 完全不参与限流", async () => {
    // 复现当初实测到的漏洞：同一台机器每次换一个 XFF，6 次尝试全部通过（限流失效）。
    // 修好后 clientIp 只取 req.ip（= TCP 对端），第 6 次必被拦（5 次/15 分钟）。
    const codes: number[] = [];
    for (let i = 1; i <= 6; i++) {
      const r = await app.request("POST", "/api/auth/login", {
        body: { username: "xff-probe-user", password: "wrong-password" },
        headers: { "x-forwarded-for": `8.8.8.${i}` },
      });
      codes.push(r.status);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });

  it("★ 反代模式（TRUST_PROXY=1）下，按用户名的第二道闸仍然生效", async () => {
    // 反代场景里 req.ip 来自 XFF（可能被伪造或配置错误），
    // 所以必须有「不含 IP」的兜底闸：同一账号 10 次/15 分钟。
    const proxyApp = await buildFullApp({ env: { trustProxy: true } });
    try {
      const codes: number[] = [];
      for (let i = 1; i <= 12; i++) {
        const r = await proxyApp.request("POST", "/api/auth/login", {
          body: { username: "behind-proxy-user", password: "wrong-password" },
          headers: { "x-forwarded-for": `9.9.9.${i}` },
        });
        codes.push(r.status);
      }
      expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
      expect(codes[10]).toBe(429);
      expect(codes[11]).toBe(429);
    } finally {
      await proxyApp.close();
    }
  });
});

describe("日报发送时刻（曾经「错过那一分钟就整天不发」）", () => {
  it("非法时间返回 null，而不是静默变成 00:00（半夜发）", () => {
    expect(parseReportAt("09:00")).toEqual({ hh: 9, mm: 0 });
    expect(parseReportAt("9:05")).toEqual({ hh: 9, mm: 5 });
    expect(parseReportAt("23:59")).toEqual({ hh: 23, mm: 59 });
    expect(parseReportAt("24:00")).toBeNull();
    expect(parseReportAt("09:60")).toBeNull();
    expect(parseReportAt("9点")).toBeNull();
    expect(parseReportAt("")).toBeNull();
    expect(parseReportAt(undefined)).toBeNull();
  });

  it("★ 过了设定时刻也算「到点」（重启/卡顿错过后当天仍会补发）", () => {
    const at = { hh: 9, mm: 0 };
    expect(isReportDue(new Date(2026, 9, 10, 8, 59), at)).toBe(false);
    expect(isReportDue(new Date(2026, 9, 10, 9, 0), at)).toBe(true);
    expect(isReportDue(new Date(2026, 9, 10, 9, 31), at)).toBe(true);
    expect(isReportDue(new Date(2026, 9, 10, 23, 59), at)).toBe(true);
  });
});

describe("数据库快照的时机（曾经永远不备份 / 频繁重启就永远不备份）", () => {
  const H = 3_600_000;

  it("距上次快照不足间隔时不做（避免每次重启都拍一份）", () => {
    const now = 1_000 * H;
    expect(shouldSnapshot(now, now - 1 * H, SNAPSHOT_INTERVAL_MS)).toBe(false);
    expect(shouldSnapshot(now, now - 19 * H, SNAPSHOT_INTERVAL_MS)).toBe(false);
  });

  it("★ 超过间隔就做 —— 即使中间重启过（lastAt 从已有快照文件恢复）", () => {
    const now = 1_000 * H;
    expect(shouldSnapshot(now, now - 20 * H, SNAPSHOT_INTERVAL_MS)).toBe(true);
    expect(shouldSnapshot(now, now - 30 * H, SNAPSHOT_INTERVAL_MS)).toBe(true);
    // 从来没备份过（lastAt = 0）→ 立刻做
    expect(shouldSnapshot(now, 0, SNAPSHOT_INTERVAL_MS)).toBe(true);
  });
});

describe("日报的过期状态判定（跨重启恢复时不能拿几天前的当「昨日」）", () => {
  const now = new Date(2026, 9, 10, 10, 0); // 本地 2026-10-10 10:00

  it("今天 / 昨天算新鲜，更早的要丢掉", () => {
    expect(isFreshDay("2026-10-10", now)).toBe(true);
    expect(isFreshDay("2026-10-09", now)).toBe(true);
    expect(isFreshDay("2026-10-08", now)).toBe(false);
    expect(isFreshDay("", now)).toBe(false);
    expect(isFreshDay(undefined, now)).toBe(false);
  });
});

describe("模块状态的跨重启保留（日报的「昨日」不再因重启丢失）", () => {
  /** 一个「每次启动把计数 +1 并落库」的合成模块 */
  function counterModule(id: string, defaultEnabled: boolean): ModuleDefinition {
    return {
      id,
      name: `计数模块 ${id}`,
      version: "1.0.0",
      description: "测试用：累计启动次数并持久化",
      defaultEnabled,
      defaultConfig: {},
      configSchema: [],
      onStart(ctx) {
        ctx.state.runs = Number(ctx.state.runs ?? 0) + 1;
        ctx.persistState?.();
      },
    };
  }

  it("★ persistState 写的状态会在下次启动时装回 ctx.state", async () => {
    const { id: userId } = app.seedApprovedUser("state@example.com");
    const accountId = app.seedAccount(userId, "状态测试");
    const rt = app.registry.require(accountId);

    // 只有已经配置过的模块才会落库状态（见下一条测试）
    app.repos.modules.upsert(accountId, "t-state", { enabled: true, config: {} });

    const def = counterModule("t-state", false);
    await rt.startModule(def);
    await rt.stopModule("t-state");
    await rt.startModule(def);
    await rt.stopModule("t-state");

    // 两次启动累计到 2 → 状态确实跨实例活了下来
    expect(app.repos.modules.getState(accountId, "t-state")).toMatchObject({ runs: 2 });
  });

  it("★ 没有配置行的模块不会为了存状态而新建行（否则会把默认启用的模块关掉）", async () => {
    const { id: userId } = app.seedApprovedUser("state2@example.com");
    const accountId = app.seedAccount(userId, "状态测试2");
    const rt = app.registry.require(accountId);

    const def = counterModule("t-state2", true); // 默认启用，用户从没配置过 → 库里没有行
    await rt.startModule(def);

    expect(app.repos.modules.find(accountId, "t-state2")).toBeNull();
    // 关键：不能因为存状态就凭空插入 enabled=0 的行，把模块关掉
    expect(rt.isEnabled(def)).toBe(true);
    await rt.stopModule("t-state2");
  });
});

describe("登录态有效期是运行时设置（曾经冻结在启动值）", () => {
  /** 从 Set-Cookie 里取会话 cookie 的 Max-Age（秒） */
  function maxAgeOf(cookies: string[] | undefined): number | null {
    const line = (cookies ?? []).find((c) => c.startsWith("reelax_session="));
    const m = /Max-Age=(\d+)/.exec(line ?? "");
    return m?.[1] ? Number(m[1]) : null;
  }

  it("★ 后台改成 7 天后，新登录下发的 cookie Max-Age 跟着变", async () => {
    await app.post("/api/auth/register", { username: "ttl-user", password: "ttl-user-pw-1" });

    const before = await app.post("/api/auth/login", { username: "ttl-user", password: "ttl-user-pw-1" });
    expect(before.status).toBe(200);
    expect(maxAgeOf(before.cookies)).toBe(30 * 86_400); // testEnv 默认 30 天

    const set = await app.patch("/api/admin/settings", { patch: { sessionTtlDays: 7 } }, admin.jar);
    expect(set.status).toBe(200);

    const after = await app.post("/api/auth/login", { username: "ttl-user", password: "ttl-user-pw-1" });
    expect(after.status).toBe(200);
    expect(maxAgeOf(after.cookies)).toBe(7 * 86_400);

    // 收尾：还原成 30 天，避免影响同文件其他用例
    await app.patch("/api/admin/settings", { patch: { sessionTtlDays: 30 } }, admin.jar);
  });
});
