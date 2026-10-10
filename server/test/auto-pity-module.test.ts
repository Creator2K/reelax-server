// 保底切图：模块行为（对着假游戏 API 跑真实 onStart）
//
// 本项目**自己负责换图**，与官方助手零接触（不读它的开关、不接管、不提示）——
// 这里钉住的正是「一次助手接口都不发」，以及切图 / 切回 / 流程结束的链路：
//   · 快触发保底 → 切到保底图；出货 → 切回原图
//   · 中途用户自己切回原图并出货 → 流程要能自己结束（否则以后再也不会切图）
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoPity from "../src/modules/auto-pity/index.ts";

const BIOME_HOME = "b_001";
const BIOME_PITY = "b_015";

type FakeOpts = {
  config?: Record<string, unknown>;
};

function makeCtx(opts: FakeOpts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const calls: string[] = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];

  const world = {
    currentBiome: BIOME_HOME,
    dry: 1180, // hardPityCasts 1200 → 还差 20 杆（阈值 30 → 会切图）
  };

  const api = {
    now: () => Date.now(),
    biomes: async () => ({
      biomes: [
        { id: BIOME_HOME, name: "月落溪谷", isCurrent: world.currentBiome === BIOME_HOME },
        { id: BIOME_PITY, name: "星渊圣海", isCurrent: world.currentBiome === BIOME_PITY },
      ],
    }),
    statistics: async () => ({ pity: { arcane: { hardPityCasts: 1200, currentDryCasts: world.dry } } }),
    biomeTravel: async (id: string) => {
      calls.push(`TRAVEL ${id}`);
      world.currentBiome = id;
      return {};
    },
    // 与助手解耦后这里不该有任何调用：留一个会抛错的桩当绊线
    request: async (path: string) => {
      calls.push(`REQUEST ${path}`);
      throw new Error(`不该调用 ${path}`);
    },
  };

  const ctx = {
    moduleId: "auto-pity",
    config: {
      rarity: "arcane",
      thresholdCasts: 30,
      targetBiome: BIOME_PITY,
      checkEverySec: 60,
      returnDelaySec: 0,
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

  return {
    ctx,
    log,
    calls,
    world,
    start: async () => {
      await autoPity.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 20_000).at(-1);
        await t?.fn();
      };
    },
  };
}

const count = (calls: string[], needle: string) => calls.filter((c) => c === needle).length;

describe("保底切图模块", () => {
  it("★ 快触发保底 → 切进保底地图，出货 → 切回原图", async () => {
    const { calls, log, world, start } = makeCtx();
    const run = await start();

    await run();
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(1);
    expect(world.currentBiome).toBe(BIOME_PITY);
    expect(log.info.some((m) => m.includes("月落溪谷 → 星渊圣海"))).toBe(true);

    world.dry = 0; // 出货：dry 计数被重置
    await run();
    expect(count(calls, `TRAVEL ${BIOME_HOME}`)).toBe(1);
    expect(world.currentBiome).toBe(BIOME_HOME);
    expect(log.info.some((m) => m.includes("🎉"))).toBe(true);
  });

  it("★ 完全不碰助手：一次 /api/convenience 都不发（既不读也不写）", async () => {
    const { calls, log, start } = makeCtx();
    const run = await start();

    await run(); // 切图
    await run(); // 再检查一次
    expect(calls.filter((c) => c.includes("convenience"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("REQUEST"))).toEqual([]);
    // 只剩换图这一件事
    expect(calls.every((c) => c.startsWith("TRAVEL"))).toBe(true);
    expect(log.warn).toEqual([]);
  });

  it("★ 中途用户自己切回原图并出货：流程能自己结束，之后还能再切图", async () => {
    const { calls, world, start } = makeCtx();
    const run = await start();

    await run(); // 进保底图，记住原图
    expect(world.currentBiome).toBe(BIOME_PITY);

    // 用户自己切回原图，然后出货 → 决策是 stay，但流程必须结束
    world.currentBiome = BIOME_HOME;
    world.dry = 0;
    await run();
    expect(count(calls, `TRAVEL ${BIOME_HOME}`)).toBe(0); // 没多此一举地切图

    // 再次接近保底 → 应该能重新切进保底图（旧版本会卡死在这里）
    world.dry = 1180;
    await run();
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(2);
  });

  it("不到阈值不切图", async () => {
    const { calls, start } = makeCtx({ config: { thresholdCasts: 5 } });
    const run = await start();

    await run(); // 还差 20 杆 > 阈值 5
    expect(calls.filter((c) => c.startsWith("TRAVEL"))).toEqual([]);
  });

  it("读不到保底数据时不崩、也不换图", async () => {
    const { ctx, calls, start } = makeCtx();
    (ctx.api as unknown as { statistics: () => Promise<unknown> }).statistics = async () => ({ pity: {} });
    const run = await start();

    await run();
    expect(calls.filter((c) => c.startsWith("TRAVEL"))).toEqual([]);
  });
});
