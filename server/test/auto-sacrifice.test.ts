// 奥秘献祭：该不该献、献多少
//
// 这个功能会**不可撤回地消耗资源**（即使本轮全服没达标也不返还），所以判定必须钉死：
// 数据读不到、额度为 0、单价为 0 —— 一律不献，只记原因。
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoSacrifice from "../src/modules/auto-sacrifice/index.ts";
import {
  availableOf,
  decideSacrifice,
  pointsPerUnit,
  readContributionResult,
  type SacrificeOverview,
} from "../src/modules/auto-sacrifice/decide.ts";

/** 一份「本轮要鱼」的正常快照 */
const fishRound = (over: Partial<SacrificeOverview> = {}): SacrificeOverview => ({
  status: "ready",
  currentRound: { roundNumber: 3, status: "open", resourceType: "fish", target: 1000, progress: 200 },
  currentPlayerRoundContribution: { contribution: 10, remaining: 100, limitBasisPoints: 5000 },
  availableAssets: { fish: { common: 500, rare: 3 }, gold: 50_000, relics: 800 },
  fishPoints: { common: 1, uncommon: 2, fine: 4, rare: 8, epic: 16 },
  ...over,
});

const decide = (over: {
  overview?: SacrificeOverview | null;
  resources?: string[];
  fishRarity?: string;
  selfSharePercent?: number;
}) =>
  decideSacrifice({
    overview: over.overview === undefined ? fishRound() : over.overview,
    resources: over.resources ?? ["fish"],
    fishRarity: over.fishRarity ?? "common",
    selfSharePercent: over.selfSharePercent ?? 100,
  });

describe("availableOf / pointsPerUnit", () => {
  it("按资源类型取值（鱼按稀有度）", () => {
    expect(availableOf(fishRound(), "fish", "common")).toBe(500);
    expect(availableOf(fishRound(), "fish", "rare")).toBe(3);
    expect(availableOf(fishRound(), "gold", "common")).toBe(50_000);
    expect(availableOf(fishRound(), "relic", "common")).toBe(800);
    expect(availableOf(null, "fish", "common")).toBe(0);
  });

  it("鱼按稀有度折点，金币 / 遗物 1:1，不认识的资源是 0", () => {
    expect(pointsPerUnit(fishRound(), "fish", "common")).toBe(1);
    expect(pointsPerUnit(fishRound(), "fish", "rare")).toBe(8);
    expect(pointsPerUnit(fishRound(), "gold", "common")).toBe(1);
    expect(pointsPerUnit(fishRound(), "relic", "common")).toBe(1);
    expect(pointsPerUnit(fishRound(), "gear", "common")).toBe(0);
  });

  it("鱼的档位没有点数换算时返回 0（避免拿 0 当除数）", () => {
    expect(pointsPerUnit({ fishPoints: {} }, "fish", "common")).toBe(0);
    expect(pointsPerUnit({ fishPoints: { common: 0 } }, "fish", "common")).toBe(0);
  });
});

describe("decideSacrifice", () => {
  it("★ 正常一轮要鱼：数量 = min(持有量, 额度/每份点数)", () => {
    // remaining 100 点、普通鱼 1 点/条、持有 500 条 → 100 条
    const d = decide({});
    expect(d.action).toBe("contribute");
    expect(d.action === "contribute" && d.body).toEqual({ resourceType: "fish", rarity: "common", quantity: 100 });
    expect(d.action === "contribute" && d.points).toBe(100);
  });

  it("★ 额度按点数折算（稀有鱼一份顶 8 点 → 数量只有 1/8）", () => {
    const d = decide({ fishRarity: "rare" }); // remaining 100 点、8 点/条 → 12 条（持有 3 条）
    expect(d.action === "contribute" && d.body.quantity).toBe(3); // 持有量更小
    const d2 = decide({
      fishRarity: "rare",
      overview: fishRound({ availableAssets: { fish: { rare: 999 }, gold: 0, relics: 0 } }),
    });
    expect(d2.action === "contribute" && d2.body.quantity).toBe(12);
  });

  it("金币 1:1 折算", () => {
    const d = decide({
      resources: ["gold"],
      overview: fishRound({
        currentRound: { roundNumber: 1, status: "open", resourceType: "gold", target: 1000, progress: 0 },
      }),
    });
    expect(d.action === "contribute" && d.body).toEqual({ resourceType: "gold", quantity: 100 });
  });

  it("遗物的字段名是 relics（不是 relic）", () => {
    const d = decide({
      resources: ["relic"],
      overview: fishRound({
        currentRound: { roundNumber: 1, status: "open", resourceType: "relic", target: 1000, progress: 0 },
      }),
    });
    expect(d.action === "contribute" && d.body.quantity).toBe(100);
  });

  it("没有轮次 / 不在开放期 → 不献", () => {
    expect(decide({ overview: null }).action).toBe("skip");
    expect(decide({ overview: fishRound({ currentRound: null }) }).action).toBe("skip");
    const closed = decide({
      overview: fishRound({
        currentRound: { roundNumber: 1, status: "settled", resourceType: "fish", target: 1, progress: 1 },
      }),
    });
    expect(closed.action === "skip" && closed.reason).toContain("不在开放期");
  });

  it("★ 本轮要的资源不在允许列表里 → 不献（并说明要的是什么）", () => {
    const d = decide({ resources: ["gold", "relic"] });
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.reason).toContain("本轮要的是「鱼」");
  });

  it("★ 单人额度用完了 → 不献", () => {
    const d = decide({
      overview: fishRound({ currentPlayerRoundContribution: { contribution: 500, remaining: 0, limitBasisPoints: 5000 } }),
    });
    expect(d.action === "skip" && d.reason).toContain("额度已用完");
  });

  it("拿不到点数换算 / 没有可献的鱼 → 不献（都不会拿 0 当除数）", () => {
    expect(decide({ overview: fishRound({ fishPoints: {} }) }).action).toBe("skip");
    expect(decide({ overview: fishRound({ availableAssets: { fish: {}, gold: 0, relics: 0 } }) }).action).toBe("skip");
  });

  it("本轮没给出目标时，自愿上限不生效（只用游戏自己的额度）", () => {
    const d = decide({
      selfSharePercent: 30,
      overview: fishRound({ currentRound: { roundNumber: 1, status: "open", resourceType: "fish" } }),
    });
    expect(d.action).toBe("contribute");
    expect(d.action === "contribute" && d.body.quantity).toBe(100);
  });

  it("★ 自愿上限：本轮目标 1000、我只要出到 30%，已出 10 点 → 只再献 290 点", () => {
    const d = decide({ selfSharePercent: 30 }); // 上限 300 点 - 已出 10 = 290
    expect(d.action === "contribute" && d.points).toBe(100); // 受额度 100 点限制
    const d2 = decide({
      selfSharePercent: 30,
      overview: fishRound({ currentPlayerRoundContribution: { contribution: 10, remaining: 5000 } }),
    });
    expect(d2.action === "contribute" && d2.points).toBe(290);
  });

  it("★ 已经达到自愿上限 → 不献（并说明是上限挡住的）", () => {
    const d = decide({
      selfSharePercent: 30,
      overview: fishRound({ currentPlayerRoundContribution: { contribution: 400, remaining: 5000 } }),
    });
    expect(d.action === "skip" && d.reason).toContain("贡献上限");
  });

  it("上限 100% 时不额外限制（只用游戏自己的额度）", () => {
    const d = decide({ selfSharePercent: 100 });
    expect(d.action === "contribute" && d.body.quantity).toBe(100);
  });
});

describe("readContributionResult", () => {
  it("能读出实际献了多少 / 推进多少", () => {
    expect(readContributionResult({ contribution: { inputQuantity: 100, contribution: 100 } })).toEqual({
      inputQuantity: 100,
      contribution: 100,
    });
    expect(readContributionResult({})).toBeNull();
    expect(readContributionResult(null)).toBeNull();
  });
});

/* ==================== 模块行为 ==================== */

function makeCtx(opts: { overview?: unknown; config?: Record<string, unknown>; error?: Error } = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const submits: Array<Record<string, unknown>> = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];

  const api = {
    arcaneSacrifice: async () => {
      if (opts.error) throw opts.error;
      return opts.overview ?? fishRound();
    },
    arcaneSacrificeContribute: async (body: { resourceType: string; rarity?: string; quantity: number }) => {
      submits.push(body);
      return { contribution: { inputQuantity: body.quantity, contribution: body.quantity, resourceType: body.resourceType } };
    },
  };

  const ctx = {
    moduleId: "auto-sacrifice",
    config: {
      resources: ["fish"],
      fishRarity: "common",
      selfSharePercent: 100,
      dryRun: false,
      checkEverySec: 90,
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
    submits,
    start: async () => {
      await autoSacrifice.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 25_000).at(-1);
        await t?.fn();
      };
    },
  };
}

describe("奥秘献祭模块", () => {
  it("★ 献一次，同一轮额度没变化就不再提交", async () => {
    const { submits, log, start } = makeCtx();
    const run = await start();

    await run();
    expect(submits).toEqual([{ resourceType: "fish", rarity: "common", quantity: 100 }]);
    expect(log.info.some((m) => m.includes("已献祭") && m.includes("推进 100 点"))).toBe(true);

    await run(); // 服务端额度没变（假接口每次都返回 remaining=100）
    expect(submits).toHaveLength(1);
    expect(log.debug.some((m) => m.includes("额度没有变化"))).toBe(true);
  });

  it("额度过期后又出现新额度（remaining 变了）→ 继续献", async () => {
    const overviews = [
      fishRound({ currentPlayerRoundContribution: { contribution: 0, remaining: 100 } }),
      fishRound({ currentPlayerRoundContribution: { contribution: 100, remaining: 40 } }),
    ];
    let i = 0;
    const { ctx, submits, start } = makeCtx();
    (ctx.api as unknown as { arcaneSacrifice: () => Promise<unknown> }).arcaneSacrifice = async () => overviews[Math.min(i++, 1)];
    const run = await start();

    await run();
    await run();
    expect(submits).toHaveLength(2);
  });

  it("演练模式只记录，不提交", async () => {
    const { submits, log, start } = makeCtx({ config: { dryRun: true } });
    const run = await start();

    await run();
    expect(submits).toEqual([]);
    expect(log.info.some((m) => m.includes("[演练]"))).toBe(true);
  });

  it("接口报错只警告一次，不崩", async () => {
    const { log, start } = makeCtx({ error: new Error("HTTP 500") });
    const run = await start();

    await run();
    await run();
    expect(log.warn.filter((m) => m.includes("献祭失败"))).toHaveLength(1);
  });

  it("默认配置：只献鱼、用普通鱼、不额外限制、非演练", () => {
    expect(autoSacrifice.defaultConfig).toMatchObject({
      resources: ["fish"],
      fishRarity: "common",
      selfSharePercent: 100,
      dryRun: false,
    });
  });
});
