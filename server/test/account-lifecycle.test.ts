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
function makeGameFetch(opts: { meDelayMs?: number; syncDelayMs?: number } = {}) {
  const calls: string[] = [];
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
          // 已经到期 → sleepUntil 立即返回，循环马上进入 sync
          nextCastAt: new Date(Date.now() - 1_000).toISOString(),
          totalCasts: 10,
          remainingCasts: 9,
        },
      });
    }
    if (path === "/api/fishing/sync") {
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
      await waitFor(() => calls.includes("/api/fishing/sync"));

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
