// 自动卖鱼：按勾选的稀有度卖鱼（对着假游戏 API 跑真实 onStart）
//
// 这组测试盯的是「卖错东西」这一类不可逆错误：
//   · 没勾的档位一条都不能卖
//   · 锁定的鱼（手动锁 / 专精锁）绝不动
//   · 带泰坦倍率的鱼默认保护
//   · 背包条目没有 rarity 字段时，要用内容表补齐（否则会把不该卖的当成未知档）
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoSellFish, { autoLockMasteryFishOf } from "../src/modules/auto-sell-fish/index.ts";

type Opts = {
  fish?: unknown[];
  content?: unknown;
  /** /api/inventory/fish 里的 settings（默认：自动锁定专精鱼已开启） */
  autoLockMasteryFish?: boolean | null;
  /** true = 切换设置的接口直接报错 */
  settingsError?: boolean;
  config?: Record<string, unknown>;
};

function makeCtx(opts: Opts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const sold: { fishId: string; quantity: number }[][] = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];
  const settingsCalls: { autoLockMasteryFish: boolean }[] = [];

  const autoLock = opts.autoLockMasteryFish === undefined ? true : opts.autoLockMasteryFish;

  const api = {
    inventoryFish: async () => ({
      // null = 响应里没有这项
      ...(autoLock === null ? {} : { settings: { autoLockMasteryFish: autoLock } }),
      fish: opts.fish ?? [
        { fishId: "f_common", name: "小杂鱼", rarity: "common", quantity: 100, sellPrice: 5 },
        { fishId: "f_rare", name: "稀有鱼", rarity: "rare", quantity: 10, sellPrice: 500 },
        { fishId: "f_arcane", name: "奥秘鱼", rarity: "arcane", quantity: 1, sellPrice: 50_000 },
      ],
    }),
    contentBootstrap: async () =>
      opts.content ?? { fish: [{ id: "f_common", rarity: "common", name: "小杂鱼", sellPrice: 5 }] },
    updateFishSettings: async (body: { autoLockMasteryFish: boolean }) => {
      if (opts.settingsError) throw new Error("HTTP 500");
      settingsCalls.push(body);
      return {};
    },
    sellFish: async (items: any[]) => {
      sold.push(items.map((i) => ({ fishId: String(i.fishId), quantity: Number(i.quantity) })));
      return { goldEarned: items.reduce((a, i) => a + Number(i.quantity) * 5, 0) };
    },
  };

  const ctx = {
    moduleId: "auto-sell-fish",
    config: {
      sellRarities: ["common", "uncommon", "fine"],
      protectTitan: true,
      protectMastery: true,
      maxPerRun: 2000,
      minIntervalMin: 10,
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
  } as unknown as ModuleContext;

  return {
    ctx,
    log,
    sold,
    settingsCalls,
    start: async () => {
      await autoSellFish.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 25_000).at(-1);
        await t?.fn();
      };
    },
  };
}

describe("自动卖鱼", () => {
  it("★ 只卖勾选的品质（默认 普通/罕见/精良）", async () => {
    const { sold, log, start } = makeCtx();
    const run = await start();

    await run();
    expect(sold).toEqual([[{ fishId: "f_common", quantity: 100 }]]);
    expect(log.info.some((m) => m.includes("已卖 100 条") && m.includes("普通×100"))).toBe(true);
    expect(log.info.some((m) => m.includes("金币"))).toBe(true);
  });

  it("★ 锁定的鱼一条都不卖（手动锁 / 专精锁）", async () => {
    const { sold, log, start } = makeCtx({
      fish: [
        { fishId: "f_a", name: "手动锁", rarity: "common", quantity: 10, isManuallyLocked: true },
        { fishId: "f_b", name: "专精锁", rarity: "common", quantity: 10, isMasteryLocked: true },
        { fishId: "f_c", name: "普通锁", rarity: "common", quantity: 10, isLocked: true },
        { fishId: "f_d", name: "可卖", rarity: "common", quantity: 10 },
      ],
    });
    const run = await start();

    await run();
    expect(sold).toEqual([[{ fishId: "f_d", quantity: 10 }]]);
    expect(log.info.some((m) => m.includes("普通×10"))).toBe(true);
  });

  it("★ 带泰坦倍率的鱼默认不卖；关掉保护才会卖", async () => {
    const fish = [
      { fishId: "f_t", name: "泰坦鱼", rarity: "common", quantity: 5, titanValueSummary: { multiplier: 3 } },
      { fishId: "f_n", name: "普通鱼", rarity: "common", quantity: 7 },
    ];

    const guarded = makeCtx({ fish });
    const runGuarded = await guarded.start();
    await runGuarded();
    expect(guarded.sold).toEqual([[{ fishId: "f_n", quantity: 7 }]]);

    const loose = makeCtx({ fish, config: { protectTitan: false } });
    const runLoose = await loose.start();
    await runLoose();
    expect(loose.sold.flat().map((i) => i.fishId).sort()).toEqual(["f_n", "f_t"]);
  });

  it("★ 背包条目没有 rarity 时用内容表补齐（否则会当成未知档，永远卖不掉）", async () => {
    const { sold, start } = makeCtx({
      fish: [{ fishId: "f_common", quantity: 42 }],
      content: { fish: [{ id: "f_common", rarity: "common", name: "小杂鱼", sellPrice: 5 }] },
    });
    const run = await start();

    await run();
    expect(sold).toEqual([[{ fishId: "f_common", quantity: 42 }]]);
  });

  it("稀有度不在勾选里 / 数量为 0 → 不卖", async () => {
    const { sold, log, start } = makeCtx({
      fish: [
        { fishId: "f_x", rarity: "rare", quantity: 3 },
        { fishId: "f_y", rarity: "common", quantity: 0 },
        { fishId: "f_z", quantity: 9 }, // 没有 rarity 且内容表也没有
      ],
      content: { fish: [] },
    });
    const run = await start();

    await run();
    expect(sold).toEqual([]);
    expect(log.debug.some((m) => m.includes("没有符合条件"))).toBe(true);
  });

  it("一条都没勾 → 不动作（不请求卖鱼）", async () => {
    const { sold, log, start } = makeCtx({ config: { sellRarities: [] } });
    const run = await start();

    await run();
    expect(sold).toEqual([]);
    expect(log.debug.some((m) => m.includes("没有勾选"))).toBe(true);
  });

  it("干跑只报告，不卖", async () => {
    const { sold, log, start } = makeCtx({ config: { dryRun: true } });
    const run = await start();

    await run();
    expect(sold).toEqual([]);
    expect(log.info.some((m) => m.includes("[干跑] 本该卖 100 条") && m.includes("约 500 金币"))).toBe(true);
  });

  it("★ 每轮按条数限流（maxPerRun）", async () => {
    const { sold, start } = makeCtx({
      fish: [{ fishId: "f_common", rarity: "common", quantity: 1000, sellPrice: 5 }],
      config: { maxPerRun: 300 },
    });
    const run = await start();

    await run();
    expect(sold).toEqual([[{ fishId: "f_common", quantity: 300 }]]);
  });

  it("空背包只写一条 debug，不报错", async () => {
    const { sold, log, start } = makeCtx({ fish: [] });
    const run = await start();

    await run();
    expect(sold).toEqual([]);
    expect(log.debug.some((m) => m.includes("没有鱼"))).toBe(true);
  });
});

describe("自动卖鱼 · 专精鱼保护（用游戏的自动锁定）", () => {
  const FISH = [
    { fishId: "f_common", name: "小杂鱼", rarity: "common", quantity: 100, sellPrice: 5 },
    {
      fishId: "f_target",
      name: "专精目标鱼",
      rarity: "common",
      quantity: 30,
      sellPrice: 5,
      isLocked: true,
      isMasteryLocked: true,
    },
    { fishId: "f_manual", name: "手动锁的鱼", rarity: "common", quantity: 5, sellPrice: 5, isLocked: true, isManuallyLocked: true },
  ];

  it("★ 被专精锁标记的鱼不卖，并单独计数（便于确认官方保护生效）", async () => {
    const { sold, log, start } = makeCtx({ fish: FISH });
    const run = await start();

    await run();
    expect(sold).toEqual([[{ fishId: "f_common", quantity: 100 }]]);
    expect(log.info.some((m) => m.includes("因专精献祭保护跳过"))).toBe(true);
  });

  it("★ 游戏的「自动锁定专精鱼」关着 → 自动开启，且本轮先不卖", async () => {
    const { sold, log, settingsCalls, start } = makeCtx({ fish: FISH, autoLockMasteryFish: false });
    const run = await start();

    await run();
    expect(settingsCalls).toEqual([{ autoLockMasteryFish: true }]);
    expect(sold).toEqual([]);
    expect(log.info.some((m) => m.includes("已开启游戏的「自动锁定专精鱼」"))).toBe(true);
  });

  it("开启失败时本轮不卖（宁可少卖一轮，也不能把要献祭的鱼卖掉）", async () => {
    const { sold, log, start } = makeCtx({ fish: FISH, autoLockMasteryFish: false, settingsError: true });
    const run = await start();

    await run();
    expect(sold).toEqual([]);
    expect(log.warn.some((m) => m.includes("本轮不卖"))).toBe(true);
  });

  it("响应里读不到这项设置 → 本轮不卖", async () => {
    const { sold, log, start } = makeCtx({ fish: FISH, autoLockMasteryFish: null });
    const run = await start();

    await run();
    expect(sold).toEqual([]);
    expect(log.warn.some((m) => m.includes("读不到"))).toBe(true);
  });

  it("关掉保护后不会去改游戏设置（但仍不碰被锁的鱼）", async () => {
    const { sold, settingsCalls, start } = makeCtx({
      fish: FISH,
      autoLockMasteryFish: false,
      config: { protectMastery: false },
    });
    const run = await start();

    await run();
    expect(settingsCalls).toEqual([]);
    expect(sold).toEqual([[{ fishId: "f_common", quantity: 100 }]]);
  });
});

describe("autoLockMasteryFishOf（读背包响应里的开关）", () => {
  it("认 true / false，其它一律 null（按读不到处理）", () => {
    expect(autoLockMasteryFishOf({ settings: { autoLockMasteryFish: true } })).toBe(true);
    expect(autoLockMasteryFishOf({ settings: { autoLockMasteryFish: false } })).toBe(false);
    expect(autoLockMasteryFishOf({ settings: {} })).toBeNull();
    expect(autoLockMasteryFishOf({})).toBeNull();
    expect(autoLockMasteryFishOf(null)).toBeNull();
    expect(autoLockMasteryFishOf({ settings: { autoLockMasteryFish: "true" } })).toBeNull();
  });
});
