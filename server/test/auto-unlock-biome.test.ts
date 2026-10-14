// 自动解锁地图：按等级与金币条件逐张解锁（对着假游戏 API 跑真实 onStart）
//
// 花出去的金币退不回来，所以这组测试盯的是「不该买的绝不买」：
//   · 等级不够 → 跳过（并说清还差多少级）
//   · 金币不够 / 要留底 → 跳过
//   · 已解锁的不动
//   · 每次检查只解锁 maxPerRun 张（默认 1）
//   · 干跑只报告、不扣金币
//   · 先便宜的（等级低）先买
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoUnlockBiome from "../src/modules/auto-unlock-biome/index.ts";

type Opts = {
  config?: Record<string, unknown>;
  gold?: number;
  level?: number;
  /** 已解锁的地图 id */
  unlocked?: string[];
  /** 地图列表（默认用 b_001..b_005 的小表） */
  biomes?: unknown[];
  /** 解锁接口一律抛这个错误 */
  unlockError?: Error;
};

const TABLE = [
  { id: "b_001", name: "月落溪谷", requiredLevel: 0, unlockCost: 0 },
  { id: "b_002", name: "雾语湿地", requiredLevel: 50, unlockCost: 15_000 },
  { id: "b_003", name: "镜潮海岸", requiredLevel: 100, unlockCost: 200_000 },
  { id: "b_004", name: "雷痕峡湾", requiredLevel: 200, unlockCost: 500_000 },
  { id: "b_005", name: "星根洞窟", requiredLevel: 350, unlockCost: 1_000_000 },
];

function makeCtx(opts: Opts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const timers: Array<{ ms: number; fn: () => unknown }> = [];
  const world = {
    gold: opts.gold ?? 0,
    level: opts.level ?? 1,
    unlocked: new Set(opts.unlocked ?? ["b_001"]),
    unlocks: [] as string[],
  };

  const api = {
    biomes: async () => ({
      biomes: (opts.biomes ?? TABLE).map((b: any) => ({
        id: b.id,
        name: b.name,
        requiredLevel: b.requiredLevel,
        unlockCost: b.unlockCost,
        isUnlocked: world.unlocked.has(b.id),
      })),
    }),
    me: async () => ({ player: { gold: world.gold, level: world.level } }),
    biomeUnlock: async (id: string) => {
      if (opts.unlockError) throw opts.unlockError;
      const def = (opts.biomes ?? TABLE).find((b: any) => b.id === id) as any;
      world.unlocks.push(id);
      world.unlocked.add(id);
      world.gold -= Number(def?.unlockCost) || 0;
      return { player: { gold: world.gold } };
    },
  };

  const ctx = {
    moduleId: "auto-unlock-biome",
    config: {
      maxPerRun: 1,
      maxCostPerBiome: 0,
      goldReserve: 0,
      checkEveryMin: 5,
      dryRun: false,
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
    world,
    start: async () => {
      await autoUnlockBiome.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 40_000).at(-1);
        await t?.fn();
      };
    },
  };
}

describe("自动解锁地图", () => {
  it("★ 等级够、钱够 → 解锁最便宜的那张（一次一张）", async () => {
    const { log, world, start } = makeCtx({ gold: 20_000, level: 60 });
    const run = await start();

    await run();
    expect(world.unlocks).toEqual(["b_002"]);
    expect(world.gold).toBe(5_000);
    expect(log.info.some((m) => m.includes("已解锁「雾语湿地」") && m.includes("15,000"))).toBe(true);
  });

  it("★ 等级不够的跳过，并说清还差多少级", async () => {
    const { log, world, start } = makeCtx({ gold: 10_000_000, level: 1 });
    const run = await start();

    await run();
    expect(world.unlocks).toEqual([]);
    const line = log.info.find((m) => m.includes("暂时没有可解锁"));
    expect(line).toContain("需 Lv 50");
  });

  it("★ 金币不够的跳过（余额与所需都写出来）", async () => {
    const { log, world, start } = makeCtx({ gold: 10_000, level: 400 });
    const run = await start();

    await run();
    // 等级够的候选：b_002（15,000）买不起 → 跳过；b_003 更贵也跳过
    expect(world.unlocks).toEqual([]);
    expect(log.info.some((m) => m.includes("需 15,000") && m.includes("余额 10,000"))).toBe(true);
  });

  it("★ 「保留金币」生效：解锁后不能低于它", async () => {
    const { world, start } = makeCtx({ gold: 20_000, level: 60, config: { goldReserve: 10_000 } });
    const run = await start();

    await run();
    // 15,000 花掉后剩 5,000 < 保留 10,000 → 不该买
    expect(world.unlocks).toEqual([]);
  });

  it("★ 「单个地图花费上限」生效", async () => {
    const { world, start } = makeCtx({ gold: 10_000_000, level: 400, config: { maxCostPerBiome: 100_000 } });
    const run = await start();

    await run();
    // b_002 15,000 在上限内 → 买它；b_003 200,000 超限
    expect(world.unlocks).toEqual(["b_002"]);
  });

  it("★ 每次检查只解锁 maxPerRun 张（默认 1）", async () => {
    const { world, start } = makeCtx({ gold: 10_000_000, level: 400 });
    const run = await start();

    await run();
    expect(world.unlocks).toEqual(["b_002"]); // 只有一张

    const many = makeCtx({ gold: 10_000_000, level: 400, config: { maxPerRun: 3 } });
    const runMany = await many.start();
    await runMany();
    expect(many.world.unlocks).toEqual(["b_002", "b_003", "b_004"]);
    expect(many.log.info.some((m) => m.includes("还有") && m.includes("条件满足"))).toBe(true);
  });

  it("★ 干跑只报告、不扣金币", async () => {
    const { log, world, start } = makeCtx({ gold: 20_000, level: 60, config: { dryRun: true } });
    const run = await start();

    await run();
    expect(world.unlocks).toEqual([]);
    expect(world.gold).toBe(20_000);
    expect(log.info.some((m) => m.includes("[干跑] 本该解锁") && m.includes("雾语湿地"))).toBe(true);
  });

  it("已解锁的不动；全解锁后写一条说明", async () => {
    const { log, world, start } = makeCtx({
      gold: 10_000_000,
      level: 400,
      unlocked: TABLE.map((b) => b.id),
    });
    const run = await start();

    await run();
    expect(world.unlocks).toEqual([]);
    expect(log.info.some((m) => m.includes("所有地图都已解锁"))).toBe(true);
  });

  it("接口返回缺 requiredLevel/unlockCost 时用本地表兜底", async () => {
    const { world, start } = makeCtx({
      gold: 20_000,
      level: 60,
      // 故意不给等级与花费，只能靠内置地图表
      biomes: TABLE.map(({ id, name }) => ({ id, name })),
    });
    const run = await start();

    await run();
    expect(world.unlocks).toEqual(["b_002"]); // 本地表：15,000 / Lv 50
  });

  it("解锁接口报错时如实记录，并且本轮不再继续试下一张", async () => {
    const { log, world, start } = makeCtx({
      gold: 10_000_000,
      level: 400,
      config: { maxPerRun: 3 },
      unlockError: new Error("金币不足。"),
    });
    const run = await start();

    await run();
    expect(world.unlocks).toEqual([]);
    expect(log.warn.some((m) => m.includes("解锁「雾语湿地」失败") && m.includes("金币不足"))).toBe(true);
  });
});
