// 账号生命周期：启停竞态
//
// 这两条都是真实存在的 bug（先写测试把它钉住，再修）：
//  1) 停止时**在飞的**请求返回后会把状态写回 online —— 界面与数据库显示在线、
//     实际没有在钓鱼，而且还占着一个全局并发名额（再点「启动」是静默无操作）。
//  2) 启动过程中被停止（用户连点，或两个请求撞车）会「复活」：状态变 online，
//     模块定时器挂在已经被清空的池子上，代理连接也已经关掉了。
import { describe, expect, it } from "vitest";
import { buildFullApp } from "./helpers/full-app.ts";

/** 简易 proof：客户端只解析里面的 expiresAt */
const PROOF = `${Buffer.from(
  JSON.stringify({ version: 1, expiresAt: Date.now() + 3_600_000 }),
).toString("base64url")}.sig`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（避免用固定 sleep 赌时序） */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error("等待条件超时");
}

/**
 * 假游戏服务：只实现引擎真正会走的几个接口，其余一律返回空对象。
 *  - nextCastAt 故意给「已经过期」，这样循环会立刻走到 sync（否则要等 60 秒）
 *  - stateDelayMs / syncDelayMs / meDelayMs 用来制造「请求在飞」的窗口
 */
function makeGameFetch(opts: { meDelayMs?: number; syncDelayMs?: number; syncFailTimes?: number; overdueSyncs?: number } = {}) {
  const calls: string[] = [];
  let syncFailed = 0;
  let syncCount = 0;
  /** 前几次 state 把 nextCastAt 说成「已过期」，让循环立刻走到 sync；之后给未来时间，避免测试里空转 */
  const overdue = opts.overdueSyncs ?? 1;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-arcane-request-proof": PROOF },
    });

  const impl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);

    if (path === "/api/me") {
      if (opts.meDelayMs) await sleep(opts.meDelayMs);
      return json({ player: { nickname: "测试", level: 1 } });
    }
    if (path === "/api/auth/login") return json({ ok: true });
    if (path === "/api/fishing/state") {
      return json({
        player: { unspentStatPoints: 0 },
        dailyHarvest: {
          date: "2026-10-10",
          goldIncome: 100,
          baitCost: 10,
          netGold: 90,
          fishByRarity: { common: 1 },
        },
        run: {
          id: "run-1",
          status: "running",
          cycleDurationMs: 60_000,
          nextCastAt: new Date(syncCount < overdue ? Date.now() - 1_000 : Date.now() + 60_000).toISOString(),
          totalCasts: 10,
          remainingCasts: 9,
        },
      });
    }
    if (path === "/api/fishing/sync") {
      syncCount++;
      // 模拟瞬时超时（代理抖动最常见的样子）；syncFailTimes 控制失败几次
      if (syncFailed < (opts.syncFailTimes ?? 0)) {
        syncFailed++;
        throw Object.assign(new Error("Connect Timeout Error (timeout: 10000ms)"), { name: "TimeoutError" });
      }
      if (opts.syncDelayMs) await sleep(opts.syncDelayMs);
      return json({
        run: {
          id: "run-1",
          status: "running",
          cycleDurationMs: 60_000,
          nextCastAt: new Date(Date.now() + 60_000).toISOString(),
        },
        settlement: { mode: "online", gold: 10 },
        playerPatch: {},
      });
    }
    return json({});
  };

  return { impl, calls };
}

describe("停止时在飞的请求不能把状态改回 online", () => {
  it("★ stop 之后状态必须停在 stopped（哪怕同步请求稍后才返回）", async () => {
    const { impl, calls } = makeGameFetch({ syncDelayMs: 2500 });
    const app = await buildFullApp({ fetchImpl: impl });
    try {
      const { id: userId } = app.seedApprovedUser("life1@example.com");
      const accountId = app.seedAccount(userId, "启停测试");
      const rt = app.registry.require(accountId);

      await rt.start();
      expect(rt.status).toBe("online");

      // 等到循环真的进入 sync（此时请求会挂 2500ms）
      // 超时给宽一点：引擎启动有 0~1.5s 的随机错峰
      await waitFor(() => calls.includes("/api/fishing/sync"), 4000);

      // stop 最多等 2 秒就会返回，而请求还要 ~450ms 才回来 —— 正是出问题的窗口
      await rt.stop("测试停止");
      expect(rt.status).toBe("stopped");

      // 给在飞的请求足够时间返回
      await sleep(900);

      expect(rt.status).toBe("stopped");
      expect(app.repos.accounts.findById(accountId)?.status).toBe("stopped");
    } finally {
      await app.close();
    }
  });
});

describe("启动过程中被停止不能「复活」", () => {
  it("★ 并发 stop 后必须停在 stopped，且不能留下已启动的模块", async () => {
    const { impl } = makeGameFetch({ meDelayMs: 400 });
    const app = await buildFullApp({ fetchImpl: impl });
    try {
      const { id: userId } = app.seedApprovedUser("life2@example.com");
      const accountId = app.seedAccount(userId, "并发启停");
      const rt = app.registry.require(accountId);

      const starting = rt.start(); // 阻塞在 ensureSession（/api/me 延迟 400ms）
      await sleep(50);
      await rt.stop("并发停止");
      await starting.catch(() => {
        /* 启动被取消时抛错也可以接受 */
      });
      await sleep(300);

      expect(rt.status).toBe("stopped");
      expect(rt.moduleInstances).toEqual([]);
      expect(app.repos.accounts.findById(accountId)?.status).toBe("stopped");
    } finally {
      await app.close();
    }
  });
});

describe("瞬时网络错误：立刻重试一次（不退避 5 秒）", () => {
  it("★ 第一次同步超时 → 秒级内重试成功，且健康度里记到这次超时", async () => {
    const { impl, calls } = makeGameFetch({ syncFailTimes: 1, overdueSyncs: 2 });
    const app = await buildFullApp({ fetchImpl: impl });
    try {
      const { id: userId } = app.seedApprovedUser("quick1@example.com");
      const accountId = app.seedAccount(userId, "瞬时重试");
      const rt = app.registry.require(accountId);

      const t0 = Date.now();
      await rt.start();
      await waitFor(() => calls.filter((c) => c === "/api/fishing/sync").length >= 2, 4000);
      const elapsed = Date.now() - t0;

      // 退避第一档是 5 秒 → 秒级内就出现第二次同步，说明走的是「立刻重试」
      expect(elapsed).toBeLessThan(4000);
      // 没有因为一次抖动就被切成「重连中」（那会让界面闪一下，看上去像掉线）
      expect(rt.status).toBe("online");
      const s = rt.syncStats;
      expect(s.timeouts).toBe(1);
      expect(s.ok).toBeGreaterThanOrEqual(1);

      await rt.stop("测试结束");
    } finally {
      await app.close();
    }
  });
});

describe("同步失败必须在日志里看得见（链路问题排查）", () => {
  /**
   * 状态面板会显示「链路（近 10 分钟同步）· 超时 N 次」，但**日志里必须能找到对应的一条**，
   * 否则用户只能看到数字却无从排查（这是用户实测反馈）。
   * 又不能坏链路时每 6 秒刷一条 —— 所以是"第 1 次 + 每 10 次"记 warn，恢复了记一条 info。
   */
  it("★ 第一次失败记 warn，恢复后记 info（说明此前连续失败几次）", async () => {
    const { impl } = makeGameFetch({ syncFailTimes: 1, overdueSyncs: 2 });
    const app = await buildFullApp({ fetchImpl: impl, logLevel: "debug" });
    try {
      const entries: { level: string; tag: string; msg: string }[] = [];
      app.logger.subscribe((e) => entries.push({ level: e.level, tag: e.tag, msg: e.msg }));

      const { id: userId } = app.seedApprovedUser("sync-log@example.com");
      const accountId = app.seedAccount(userId, "同步日志");
      const rt = app.registry.require(accountId);

      await rt.start();
      await waitFor(() => entries.some((e) => e.level === "warn" && e.msg.includes("同步失败")), 4000);
      await waitFor(() => entries.some((e) => e.msg.includes("同步已恢复")), 4000);

      const warn = entries.find((e) => e.msg.includes("同步失败"));
      expect(warn?.level).toBe("warn");
      expect(warn?.tag).toBe("保持在线");
      expect(warn?.msg).toContain("超时"); // 原因原文带上，便于区分超时与代理拒绝

      const recovered = entries.find((e) => e.msg.includes("同步已恢复"));
      expect(recovered?.level).toBe("info");
      expect(recovered?.msg).toContain("此前连续失败 1 次");
      expect(rt.syncStats.failStreak).toBe(0);

      await rt.stop("测试结束");
    } finally {
      await app.close();
    }
  });
});
