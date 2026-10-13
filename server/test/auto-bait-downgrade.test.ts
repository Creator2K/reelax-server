// 自动换饵：金币不足 → 自动降级（对着假游戏 API 跑真实 onStart）
//
// ★ 来源是用户截图里的日志：一直刷「购买 中级饵 失败：金币不足。」，而人还在用
//   没有库存的高级饵钓。修法：按单价从高到低逐级往下试，选到买得起的那一档换上；
//   试过买不起的档位记 10 分钟冷却，不再重复打注定失败的购买请求。
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoBait from "../src/modules/auto-bait/index.ts";
import { GameClientError } from "../src/game/errors.ts";

const CONFIG = {
  personalCompetitionBait: "bait_supreme",
  guildCompetitionBait: "bait_supreme",
  goldenBait: "",
  surgeBait: "bait_high",
  normalBait: "bait_medium",
  autoDowngrade: true,
  competitionLeadSec: 180,
  buyQuantity: 200,
  checkEverySec: 120,
};

type Opts = {
  /** 哪些档位「买不起」（INSUFFICIENT_GOLD） */
  broke?: string[];
  /** 哪些档位有库存（默认全部为 0） */
  stock?: Record<string, number>;
  /** 购买接口一律抛这个错误（用于非余额类错误的场景） */
  purchaseError?: unknown;
  config?: Record<string, unknown>;
};

function makeCtx(opts: Opts = {}) {
  const broke = new Set(opts.broke ?? []);
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const equipped: string[] = [];
  const purchases: string[] = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];
  let selected = "";

  const baits = [
    { id: "bait_basic", name: "基础饵", unitPrice: 0, isUnlimited: true },
    { id: "bait_low", name: "低级饵", unitPrice: 40 },
    { id: "bait_medium", name: "中级饵", unitPrice: 100 },
    { id: "bait_high", name: "高级饵", unitPrice: 200 },
    { id: "bait_supreme", name: "顶级饵", unitPrice: 1000 },
  ].map((b) => ({ ...b, quantity: opts.stock?.[b.id] ?? 0 }));

  const api = {
    tournamentsOverview: async () => ({ current: null, upcoming: [] }),
    guildTournamentsOverview: async () => ({ current: null, upcoming: [] }),
    biomes: async () => ({
      biomes: [{ id: "b_009", name: "极昼冰湾", isCurrent: true, weather: { weatherId: "clear" } }],
    }),
    baits: async () => ({ baits: baits.map((b) => ({ ...b, isSelected: b.id === selected })) }),
    purchaseBait: async (id: string) => {
      purchases.push(id);
      if (opts.purchaseError) throw opts.purchaseError;
      if (broke.has(id)) {
        throw new GameClientError("金币不足。", { status: 400, code: "INSUFFICIENT_GOLD" });
      }
      return {};
    },
    equipBait: async (id: string) => {
      equipped.push(id);
      selected = id;
      return {};
    },
    me: async () => ({ player: { gold: 5_000 } }),
  };

  const ctx = {
    moduleId: "auto-bait",
    config: { ...CONFIG, ...(opts.config ?? {}) },
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
    equipped,
    purchases,
    start: async () => {
      await autoBait.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 20_000).at(-1);
        await t?.fn();
      };
    },
  };
}

describe("自动换饵 · 金币不足自动降级", () => {
  it("★ 中级饵买不起 → 降级买低级饵并换上", async () => {
    const { equipped, purchases, log, start } = makeCtx({ broke: ["bait_medium"] });
    const run = await start();

    await run();
    expect(purchases).toEqual(["bait_medium", "bait_low"]);
    expect(equipped).toEqual(["bait_low"]);
    expect(log.warn.some((m) => m.includes("中级饵") && m.includes("降级为 低级饵"))).toBe(true);
    // 金币余额要写进日志，否则用户不知道差多少
    expect(log.warn.some((m) => m.includes("当前 5,000 金币"))).toBe(true);
    expect(log.info.some((m) => m.includes("换成 低级饵") && m.includes("已降级"))).toBe(true);
  });

  it("★ 连着两档都买不起 → 一路降到基础饵（免费）", async () => {
    const { equipped, purchases, start } = makeCtx({ broke: ["bait_medium", "bait_low"] });
    const run = await start();

    await run();
    expect(purchases).toEqual(["bait_medium", "bait_low"]);
    expect(equipped).toEqual(["bait_basic"]);
  });

  it("★ 买不起的那一档 10 分钟内不再重复尝试购买（不刷失败日志）", async () => {
    const { purchases, log, start } = makeCtx({ broke: ["bait_medium"] });
    const run = await start();

    await run();
    expect(purchases).toEqual(["bait_medium", "bait_low"]);

    // 第二、第三轮：中级饵已在冷却里，直接走低级饵
    await run();
    await run();
    expect(purchases).toEqual(["bait_medium", "bait_low", "bait_low", "bait_low"]);
    expect(log.warn.filter((m) => m.includes("中级饵")).length).toBe(1);
  });

  it("有库存就不用买（价格再高也不降级）", async () => {
    const { equipped, purchases, start } = makeCtx({ stock: { bait_medium: 30 }, broke: ["bait_medium"] });
    const run = await start();

    await run();
    expect(purchases).toEqual([]);
    expect(equipped).toEqual(["bait_medium"]);
  });

  it("关掉「自动降级」时保持旧行为：买不起就只报一句失败", async () => {
    const { equipped, purchases, log, start } = makeCtx({
      broke: ["bait_medium"],
      config: { autoDowngrade: false },
    });
    const run = await start();

    await run();
    expect(purchases).toEqual(["bait_medium"]); // 不再往下试
    expect(equipped).toEqual(["bait_medium"]); // 仍然换上配置的那一档
    expect(log.warn.some((m) => m.includes("购买 中级饵 失败"))).toBe(true);
    expect(log.warn.some((m) => m.includes("降级"))).toBe(false);
  });

  it("非余额类错误不降级（限流只报错，不往下换饵）", async () => {
    const rateLimited = new GameClientError("请求过于频繁", { status: 429, code: "RATE_LIMITED" });
    const { equipped, purchases, log, start } = makeCtx({ purchaseError: rateLimited });
    const run = await start();

    await run();
    expect(purchases).toEqual(["bait_medium"]);
    expect(equipped).toEqual(["bait_medium"]);
    expect(log.warn.some((m) => m.includes("购买 中级饵 失败：请求过于频繁"))).toBe(true);
    expect(log.warn.some((m) => m.includes("降级"))).toBe(false);
  });
});
