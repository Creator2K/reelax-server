// 模块定时器的生命周期：模块一停，它的定时器必须跟着停
//
// ★ 为什么值得单测（真实事故）：定时器原本只有账号级的 clear()，`stopModule()` 只释放
//   事件订阅。于是「关掉模块」之后它的 every/schedule 仍在跑 —— 模块从实例表里删了，
//   回调还拿着旧配置继续干活：关掉自动切图仍按天气换图、关掉自动换饵仍在买饵，
//   必须把账号停止再启动才消停。这组测试钉住：clearOwner 精确清理 + 停止模块后计时器归零。
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimerPool } from "../src/lib/timers.ts";
import { AccountRuntime } from "../src/game/account-runtime.ts";
import type { ModuleDefinition } from "../src/modules/types.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("TimerPool · 按归属清理", () => {
  it("★ clearOwner 只清掉该归属的定时器，别的不受影响", () => {
    vi.useFakeTimers();
    const ticks: string[] = [];
    const pool = new TimerPool();

    pool.every(10, () => ticks.push("a"), "mod-a");
    pool.every(10, () => ticks.push("b"), "mod-b");
    pool.every(10, () => ticks.push("全局")); // 账号级定时器（无 owner）
    expect(pool.size).toBe(3);

    pool.clearOwner("mod-a");
    expect(pool.size).toBe(2);

    vi.advanceTimersByTime(50);
    expect(ticks).not.toContain("a");
    expect(ticks).toContain("b");
    expect(ticks).toContain("全局");
  });

  it("schedule（一次性）也能按归属清掉，不会在停止后突然触发", () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    const pool = new TimerPool();

    pool.schedule(100, () => ticks.push(1), "mod-a");
    pool.clearOwner("mod-a");
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([]);
    expect(pool.size).toBe(0);
  });

  it("clear() 一次清空（账号停止时的兜底）", () => {
    vi.useFakeTimers();
    const pool = new TimerPool();
    pool.every(10, () => {}, "mod-a");
    pool.schedule(10, () => {}, "mod-b");
    pool.clear();
    expect(pool.size).toBe(0);
  });
});

/* ---------------- 运行时：停止模块 = 定时器归零 ---------------- */

/** 最小可用的 AccountRuntime（只需要模块生命周期用到的字段） */
function makeRuntime() {
  const record = {
    id: "acc-1",
    user_id: "user-1",
    label: "测试号",
    base_url: "https://reelax.cn",
    auth_type: "credentials",
    email: "a@b.c",
    password_enc: null,
    cookie_enc: null,
    proxy_id: null,
  } as any;
  const logger: any = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const deps: any = {
    record,
    label: "测试号",
    repos: {
      modules: {
        find: () => undefined,
        getState: () => ({}),
        listForAccount: () => [],
        setState: () => {},
        upsert: () => {},
      },
      proxies: { findById: () => null },
      accounts: {},
    },
    vault: { open: () => ({ ok: false, message: "测试里不解密凭证" }) },
    bus: { on: () => () => {}, emit: () => {}, off: () => {} },
    logger,
    fetchImpl: async () => {
      throw new Error("测试里不联网");
    },
  };
  return new AccountRuntime(deps);
}

function fakeModule(onStart: (ctx: any) => void): ModuleDefinition {
  return {
    id: "test-mod",
    name: "测试模块",
    version: "1.0.0",
    description: "只用来验证定时器生命周期",
    defaultEnabled: true,
    defaultConfig: {},
    configSchema: [],
    onStart,
  } as unknown as ModuleDefinition;
}

describe("AccountRuntime · 停止模块会清掉它的定时器", () => {
  it("★ 模块注册的 every 在 stopModule 之后不再触发（这正是「关了还在跑」的根因）", async () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    const ticks: number[] = [];

    await rt.startModule(fakeModule((ctx) => ctx.every(20, () => ticks.push(1))));
    expect(rt.moduleInstances).toContain("test-mod");

    vi.advanceTimersByTime(60);
    expect(ticks.length).toBeGreaterThan(0); // 定时器确实在工作

    await rt.stopModule("test-mod");
    expect(rt.moduleInstances).not.toContain("test-mod");
    expect(rt.timerCount).toBe(0); // ★ 关键断言：定时器被清干净

    const before = ticks.length;
    vi.advanceTimersByTime(200);
    expect(ticks.length).toBe(before); // 停止之后一次都不该再触发
  });

  it("★ 一次性 schedule 也不会在模块停止后突然触发", async () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    const ticks: number[] = [];

    await rt.startModule(fakeModule((ctx) => ctx.schedule(100, () => ticks.push(1))));
    await rt.stopModule("test-mod");

    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([]);
    expect(rt.timerCount).toBe(0);
  });

  it("onStart 抛错时留下的定时器也要清掉（不留孤儿）", async () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    const ticks: number[] = [];

    const res = await rt.startModule(
      fakeModule((ctx) => {
        ctx.every(20, () => ticks.push(1));
        throw new Error("启动失败");
      }),
    );
    expect(res.ok).toBe(false);
    expect(rt.timerCount).toBe(0);

    vi.advanceTimersByTime(100);
    expect(ticks).toEqual([]);
  });

  it("停一个模块不影响另一个模块的定时器", async () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    const a: number[] = [];
    const b: number[] = [];

    await rt.startModule({ ...fakeModule((ctx) => ctx.every(20, () => a.push(1))), id: "mod-a" } as ModuleDefinition);
    await rt.startModule({ ...fakeModule((ctx) => ctx.every(20, () => b.push(1))), id: "mod-b" } as ModuleDefinition);
    expect(rt.timerCount).toBe(2);

    await rt.stopModule("mod-a");
    expect(rt.timerCount).toBe(1);

    vi.advanceTimersByTime(60);
    expect(a).toEqual([]); // 停掉的模块不再触发
    expect(b.length).toBeGreaterThan(0); // 另一个照常工作
  });
});
