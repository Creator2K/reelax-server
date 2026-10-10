// 公会区域经验增益：该不该买 / 买几份
//
// 花的是**公会金库**（不是自己的钱），所以判定同样保守：
// 没权限、读不到单价、金库不够（含你设的保留下限）、已有生效中的增益 —— 一律不买。
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoGuildBoost from "../src/modules/auto-guild-boost/index.ts";
import {
  boostOf,
  decideGuildBoost,
  readGuildFunds,
  type GuildBoostRow,
} from "../src/modules/auto-guild-boost/decide.ts";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIN = 60_000;

const decide = (over: Partial<Parameters<typeof decideGuildBoost>[0]> = {}) =>
  decideGuildBoost({
    boosts: [],
    unitCost: 500,
    maxUnits: 10,
    canActivate: true,
    treasuryGold: 100_000,
    minimumTreasuryGold: 0,
    currentBiomeId: "b_009",
    targetBiome: "current",
    unitsWanted: 1,
    renewAheadMs: 0,
    now: NOW,
    ...over,
  });

describe("readGuildFunds", () => {
  it("从 /api/guilds/me 摘出金库 / 单价 / 权限", () => {
    expect(
      readGuildFunds({
        guild: { treasuryGold: 12_345 },
        config: { boostUnitCost: 500 },
        membership: { permissions: { canActivateBoosts: true } },
      }),
    ).toEqual({ treasuryGold: 12_345, unitCost: 500, canActivate: true });
  });

  it("字段缺失时给安全值（0 / 无权限）", () => {
    expect(readGuildFunds({})).toEqual({ treasuryGold: 0, unitCost: 0, canActivate: false });
    expect(readGuildFunds(null)).toEqual({ treasuryGold: 0, unitCost: 0, canActivate: false });
  });
});

describe("boostOf", () => {
  it("按地图找，找不到返回 null", () => {
    const rows: GuildBoostRow[] = [{ biomeId: "b_009", endsAt: "x" }];
    expect(boostOf(rows, "b_009")).toBe(rows[0]);
    expect(boostOf(rows, "b_012")).toBeNull();
    expect(boostOf(null, "b_009")).toBeNull();
  });
});

describe("decideGuildBoost", () => {
  it("★ 权限 / 金库都够 → 给当前地图买（默认 1 份）", () => {
    const d = decide();
    expect(d.action).toBe("activate");
    expect(d.action === "activate" && d.biomeId).toBe("b_009");
    expect(d.action === "activate" && d.units).toBe(1);
    expect(d.action === "activate" && d.cost).toBe(500);
  });

  it("★ 没有干部权限 → 不买（并说明原因）", () => {
    const d = decide({ canActivate: false });
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.reason).toContain("权限");
  });

  it("★ 读不到单价 → 不买（避免误花公会金库）", () => {
    const d = decide({ unitCost: 0 });
    expect(d.action === "skip" && d.reason).toContain("单价");
  });

  it("★ 金库不够本次开销 → 不买", () => {
    const d = decide({ unitsWanted: 3, treasuryGold: 1000 }); // 需要 1500
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.reason).toContain("金库不足");
  });

  it("★ 买完会低于「金库保留」下限 → 不买", () => {
    const d = decide({ unitsWanted: 2, treasuryGold: 1500, minimumTreasuryGold: 1000 }); // 买完剩 500
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.reason).toContain("金库下限");
  });

  it("刚好等于下限 → 可以买", () => {
    const d = decide({ unitsWanted: 2, treasuryGold: 2000, minimumTreasuryGold: 1000 });
    expect(d.action).toBe("activate");
  });

  it("★ 已经有生效中的增益 → 不重复买", () => {
    const d = decide({
      boosts: [{ biomeId: "b_009", isActive: true, endsAt: new Date(NOW + 20 * MIN).toISOString() }],
    });
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.reason).toContain("还在");
  });

  it("★ 设了「剩余 N 分钟就续」时，快到期会提前续上", () => {
    const boosts = [{ biomeId: "b_009", isActive: true, endsAt: new Date(NOW + 10 * MIN).toISOString() }];
    expect(decide({ boosts }).action).toBe("skip"); // 默认 renewAhead = 0：还剩 10 分钟，不续
    const d = decide({ boosts, renewAheadMs: 30 * MIN });
    expect(d.action).toBe("activate");
  });

  it("过期（endsAt 已过）→ 可以买", () => {
    const d = decide({ boosts: [{ biomeId: "b_009", isActive: false, endsAt: new Date(NOW - MIN).toISOString() }] });
    expect(d.action).toBe("activate");
  });

  it("排队中的增益还在生效期内 → 不买", () => {
    const d = decide({
      boosts: [{ biomeId: "b_009", isQueued: true, endsAt: new Date(NOW + 5 * MIN).toISOString() }],
      renewAheadMs: 10 * MIN, // 即使过了续买阈值，也不该叠加排队
    });
    expect(d.action).toBe("skip");
  });

  it("★ 份数压到服务端的单次上限", () => {
    const d = decide({ unitsWanted: 50, maxUnits: 3 });
    expect(d.action === "activate" && d.units).toBe(3);
    expect(d.action === "activate" && d.cost).toBe(1500);
  });

  it("跟随当前地图但拿不到当前地图 → 不买", () => {
    const d = decide({ currentBiomeId: null });
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.reason).toContain("拿不到要开增益的地图");
  });

  it("固定地图时与当前地图无关", () => {
    const d = decide({ targetBiome: "b_012", currentBiomeId: null });
    expect(d.action === "activate" && d.biomeId).toBe("b_012");
  });
});

/* ==================== 模块行为 ==================== */

function makeCtx(opts: {
  treasuryGold?: number;
  unitCost?: number;
  canActivate?: boolean;
  boosts?: unknown[];
  config?: Record<string, unknown>;
} = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const purchases: Array<{ biomeId: string; units: number }> = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];

  const world = {
    boosts: opts.boosts ?? [],
    treasuryGold: opts.treasuryGold ?? 100_000,
  };

  const api = {
    now: () => Date.now(),
    guildsMe: async () => ({
      guild: { treasuryGold: world.treasuryGold },
      config: { boostUnitCost: opts.unitCost ?? 500 },
      membership: { permissions: { canActivateBoosts: opts.canActivate ?? true } },
    }),
    guildBoosts: async () => ({
      boosts: world.boosts,
      unitCost: opts.unitCost ?? 500,
      unitDurationMinutes: 30,
      maxUnits: 10,
      serverTime: new Date().toISOString(),
    }),
    biomes: async () => ({
      biomes: [
        { id: "b_001", name: "月落溪谷", isCurrent: false },
        { id: "b_009", name: "极昼冰湾", isCurrent: true },
      ],
    }),
    guildBoostPurchase: async (biomeId: string, units: number) => {
      purchases.push({ biomeId, units });
      world.treasuryGold -= units * (opts.unitCost ?? 500);
      world.boosts = [{ biomeId, isActive: true, endsAt: new Date(Date.now() + units * 30 * 60_000).toISOString() }];
      return {};
    },
  };

  const ctx = {
    moduleId: "auto-guild-boost",
    config: {
      targetBiome: "current",
      units: 1,
      minimumTreasuryGold: 0,
      renewAheadMin: 0,
      dryRun: false,
      checkEverySec: 300,
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
  } as unknown as ModuleContext;

  return {
    ctx,
    log,
    purchases,
    world,
    start: async () => {
      await autoGuildBoost.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 35_000).at(-1);
        await t?.fn();
      };
    },
  };
}

describe("公会区域增益模块", () => {
  it("★ 给当前地图买一份，买完不再重复买", async () => {
    const { purchases, log, start } = makeCtx();
    const run = await start();

    await run();
    expect(purchases).toEqual([{ biomeId: "b_009", units: 1 }]);
    expect(log.info.some((m) => m.includes("已给 极昼冰湾") && m.includes("500 金币"))).toBe(true);

    await run(); // 假接口现在报告「该图增益生效中」
    expect(purchases).toHaveLength(1);
  });

  it("演练模式不花钱", async () => {
    const { purchases, log, world, start } = makeCtx({ config: { dryRun: true } });
    const before = world.treasuryGold;
    const run = await start();

    await run();
    expect(purchases).toEqual([]);
    expect(world.treasuryGold).toBe(before);
    expect(log.debug.some((m) => m.includes("[演练]"))).toBe(true);
  });

  it("没权限时警告一次，不购买", async () => {
    const { purchases, log, start } = makeCtx({ canActivate: false });
    const run = await start();

    await run();
    await run();
    expect(purchases).toEqual([]);
    expect(log.warn.filter((m) => m.includes("权限"))).toHaveLength(1);
  });

  it("金库不足时警告一次，不购买", async () => {
    const { purchases, log, start } = makeCtx({ treasuryGold: 100, config: { units: 2 } });
    const run = await start();

    await run();
    expect(purchases).toEqual([]);
    expect(log.warn.filter((m) => m.includes("金库不足"))).toHaveLength(1);
  });

  it("接口报错只警告一次，不崩", async () => {
    const { ctx, log, start } = makeCtx();
    (ctx.api as unknown as { guildBoosts: () => Promise<unknown> }).guildBoosts = async () => {
      throw new Error("HTTP 500");
    };
    const run = await start();

    await run();
    await run();
    expect(log.warn.filter((m) => m.includes("购买公会区域增益失败"))).toHaveLength(1);
  });

  it("默认配置：跟随当前地图、1 份、不演练", () => {
    expect(autoGuildBoost.defaultConfig).toMatchObject({
      targetBiome: "current",
      units: 1,
      minimumTreasuryGold: 0,
      dryRun: false,
    });
  });
});
