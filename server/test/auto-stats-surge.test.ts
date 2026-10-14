// 自动加点 · 奥秘涌流期间切换方案（对着假游戏 API 跑真实 onStart）
//
// 需求（用户原话方向）：涌流的时候洗点成某种配点，过了涌流再切换回去。
// 这里钉住四条关键行为：
//   1. 只在「当前配点 ≠ 目标方案」时才洗点（洗点有成本，白洗一次毫无意义）
//   2. 没开「允许自动洗点搬运 / 切换方案」时只提示、不动手
//   3. 状态变化后先确认一会儿（防天气抖动来回洗）
//   4. 涌流结束后切回平时方案
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoStats from "../src/modules/auto-stats/index.ts";

const NORMAL = {
  mode: "target",
  statPlan: [
    { key: "intelligence", value: 2000 },
    { key: "endurance", value: 100 },
    { key: "strength", value: 0 },
    { key: "luck", value: 0 },
  ],
};
const SURGE = {
  surgeMode: "priority",
  surgePlan: [
    { key: "luck", value: 0 },
    { key: "intelligence", value: 0 },
    { key: "endurance", value: 0 },
    { key: "strength", value: 0 },
  ],
};

type Opts = { config?: Record<string, unknown>; surge?: boolean; unspent?: number; invested?: number[] };

function makeCtx(opts: Opts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const timers: Array<{ ms: number; fn: () => unknown }> = [];
  const world = {
    surge: opts.surge ?? true,
    unspent: opts.unspent ?? 1000,
    invested: opts.invested ?? [0, 0, 0, 0],
    resets: 0,
    allocs: [] as Record<string, number>[],
  };

  const api = {
    me: async () => ({
      player: {
        unspentStatPoints: world.unspent,
        stats: {
          base: {
            strength: world.invested[0],
            intelligence: world.invested[1],
            luck: world.invested[2],
            endurance: world.invested[3],
          },
        },
      },
    }),
    biomes: async () => ({
      biomes: [{ id: "b_001", isCurrent: true, weather: { weatherId: world.surge ? "arcane_surge" : "clear" } }],
    }),
    statsReset: async () => {
      world.resets += 1;
      world.unspent += world.invested.reduce((a, b) => a + b, 0);
      world.invested = [0, 0, 0, 0];
      return {};
    },
    statsAllocate: async (body: Record<string, number>) => {
      world.allocs.push(body);
      const amounts = [body.strength ?? 0, body.intelligence ?? 0, body.luck ?? 0, body.endurance ?? 0];
      world.invested = amounts;
      world.unspent = Math.max(0, world.unspent - amounts.reduce((a, b) => a + b, 0));
      return { player: { unspentStatPoints: world.unspent } };
    },
  };

  const ctx = {
    moduleId: "auto-stats",
    config: {
      ...NORMAL,
      ...SURGE,
      surgeEnabled: true,
      autoReset: true,
      minPoints: 1,
      ...(opts.config ?? {}),
    },
    state: {},
    log: {
      debug: (_t: string, m: string) => log.debug.push(m),
      info: (_t: string, m: string) => log.info.push(m),
      warn: (_t: string, m: string) => log.warn.push(m),
      error: (_t: string, m: string) => log.warn.push(m),
    },
    api,
    account: {},
    on: () => () => {},
    every: () => ({}) as NodeJS.Timeout,
    schedule: (ms: number, fn: () => unknown) => {
      timers.push({ ms, fn });
      return {} as NodeJS.Timeout;
    },
    persistState: () => {},
  } as unknown as ModuleContext;

  const run = async () => {
    const t = timers.filter((x) => x.ms === 15_000).at(-1);
    await t?.fn();
  };

  /** 把「等待确认」的时间拨到过去，等价于等够了防抖时间 */
  const passDebounce = () => {
    const S = ctx.state as { pendingSince?: number };
    S.pendingSince = Date.now() - 61_000;
  };

  /** 让天气缓存失效（换天气后立刻重读；生产里靠 60 秒 TTL） */
  const resetWeather = () => {
    const S = ctx.state as { weatherAt?: number; weatherSurge?: boolean };
    S.weatherAt = 0;
    S.weatherSurge = undefined;
  };

  return {
    ctx,
    log,
    world,
    run,
    passDebounce,
    resetWeather,
    start: async () => {
      await autoStats.onStart!(ctx);
      return run;
    },
  };
}

describe("自动加点 · 涌流切换方案", () => {
  it("★ 涌流开始：等确认后洗点，并按涌流方案重配（等待期内不按旧方案加点）", async () => {
    const { ctx, log, world, passDebounce, start } = makeCtx();
    const exec = await start();

    await exec(); // 第一次只记「待确认」，且不按旧方案加点
    expect(world.resets).toBe(0);
    expect(world.allocs).toEqual([]);
    expect((ctx.state as { pendingPlan?: string }).pendingPlan).toBe("surge");

    passDebounce();
    await exec(); // 确认后动手
    expect(world.resets).toBe(1);
    expect(world.allocs).toEqual([{ strength: 0, intelligence: 0, luck: 1000, endurance: 0 }]);
    expect((ctx.state as { appliedPlan?: string }).appliedPlan).toBe("surge");
    expect(log.info.some((m) => m.includes("切换到涌流方案"))).toBe(true);
    expect(log.info.some((m) => m.includes("涌流方案已生效"))).toBe(true);
  });

  it("★ 已经在涌流方案上 → 不洗点（洗点有成本）", async () => {
    // 涌流方案 = 全部给运气；当前配点就已经全在运气上 → 洗点毫无意义
    const { ctx, world, passDebounce, start } = makeCtx({
      surge: true,
      unspent: 0,
      invested: [0, 0, 1000, 0],
      config: { surgeEnabled: true, autoReset: true },
    });
    const exec = await start();

    await exec();
    passDebounce();
    await exec();
    expect(world.resets).toBe(0);
    expect(world.allocs).toEqual([]);
    expect((ctx.state as { appliedPlan?: string }).appliedPlan).toBe("surge");
  });

  it("没开「允许自动洗点搬运 / 切换方案」→ 只提示，不洗点", async () => {
    const { log, world, passDebounce, start } = makeCtx({ config: { autoReset: false } });
    const exec = await start();

    await exec();
    passDebounce();
    await exec();
    expect(world.resets).toBe(0);
    expect(log.debug.some((m) => m.includes("未开启"))).toBe(true);
  });

  it("★ 涌流结束：切回平时方案（洗点 + 按平时方案重配）", async () => {
    const { ctx, world, passDebounce, resetWeather, start } = makeCtx();
    const exec = await start();

    await exec();
    passDebounce();
    await exec(); // → 涌流方案
    expect((ctx.state as { appliedPlan?: string }).appliedPlan).toBe("surge");

    // 涌流结束（顺手让天气缓存失效，生产里靠 60 秒 TTL）
    world.surge = false;
    resetWeather();
    await exec(); // 待确认
    passDebounce();
    await exec(); // 确认 → 切回平时
    expect((ctx.state as { appliedPlan?: string }).appliedPlan).toBe("normal");
    expect(world.resets).toBe(2);
    // 平时方案是「到目标值」：1000 点按顺序先补智力（目标 2000，补不满）
    expect(world.allocs.at(-1)).toEqual({ strength: 0, intelligence: 1000, luck: 0, endurance: 0 });
  });

  it("两套方案一样时不会洗点（用户只看不改 = 零副作用）", async () => {
    const { ctx, world, passDebounce, start } = makeCtx({
      config: { surgeMode: "target", surgePlan: NORMAL.statPlan, autoReset: true },
      unspent: 0,
      invested: [0, 500, 0, 0],
    });
    const exec = await start();

    await exec();
    passDebounce();
    await exec();
    expect(world.resets).toBe(0);
    expect((ctx.state as { appliedPlan?: string }).appliedPlan).toBe("surge");
  });

  it("不开「涌流期间切换方案」时完全不看天气、也不切换", async () => {
    const { ctx, world, start } = makeCtx({ config: { surgeEnabled: false } });
    const exec = await start();

    await exec();
    expect(world.resets).toBe(0);
    expect((ctx.state as { appliedPlan?: string }).appliedPlan ?? "").toBe("");
  });
});
