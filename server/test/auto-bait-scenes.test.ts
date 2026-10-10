// 自动换饵：5 个场景的判定与优先级（对着假游戏 API 跑真实 onStart）
//
// 场景与官方助手的「场景鱼饵」一一对应，优先级也照抄游戏：
//     个人赛 > 公会赛 > 金风 > 奥秘涌流 > 平时
// 这里给每个场景配一个**不同的饵**，用「最后装上了哪个」反推判定对不对 ——
// 场景判错的后果是「比赛时烧的是平时的饵」这类静默错误，看日志也未必发现。
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoBait from "../src/modules/auto-bait/index.ts";

/** 每个场景一个不同的饵，便于断言 */
const CONFIG = {
  personalCompetitionBait: "bait_supreme",
  guildCompetitionBait: "bait_high",
  goldenBait: "bait_medium",
  surgeBait: "bait_low",
  normalBait: "bait_basic",
  competitionLeadSec: 180,
  buyQuantity: 0, // 测试里不关心补货
  checkEverySec: 120,
};

type FakeOpts = {
  weather?: string;
  personal?: unknown;
  guild?: unknown;
  config?: Record<string, unknown>;
};

function makeCtx(opts: FakeOpts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const equipped: string[] = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];
  let selected = "";

  const baits = [
    { id: "bait_basic", name: "基础饵", unitPrice: 0, isUnlimited: true, isSelected: false },
    { id: "bait_low", name: "低级饵", unitPrice: 40, quantity: 50, isSelected: false },
    { id: "bait_medium", name: "中级饵", unitPrice: 100, quantity: 50, isSelected: false },
    { id: "bait_high", name: "高级饵", unitPrice: 200, quantity: 50, isSelected: false },
    { id: "bait_supreme", name: "顶级饵", unitPrice: 500, quantity: 50, isSelected: false },
  ];

  const api = {
    tournamentsOverview: async () => opts.personal ?? { current: null, upcoming: [] },
    guildTournamentsOverview: async () => opts.guild ?? { current: null, upcoming: [] },
    biomes: async () => ({
      biomes: [{ id: "b_009", name: "极昼冰湾", isCurrent: true, weather: { weatherId: opts.weather ?? "clear" } }],
    }),
    baits: async () => ({ baits: baits.map((b) => ({ ...b, isSelected: b.id === selected })) }),
    purchaseBait: async () => ({}),
    equipBait: async (id: string) => {
      equipped.push(id);
      selected = id;
      return {};
    },
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
    start: async () => {
      await autoBait.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 20_000).at(-1);
        await t?.fn();
      };
    },
  };
}

/** 已报名且正在进行中的个人赛 */
const personalActive = {
  current: { id: "t1", sequence: 7, status: "active", isRegistered: true, startAt: new Date().toISOString() },
  upcoming: [],
};
/** 已报名、还有 1 分钟开赛的公会赛 */
const guildSoon = {
  current: null,
  upcoming: [
    {
      id: "g1",
      sequence: 3,
      status: "scheduled",
      entryStatus: "registered",
      startAt: new Date(Date.now() + 60_000).toISOString(),
    },
  ],
};

describe("自动换饵 · 5 个场景", () => {
  it("★ 个人赛进行中 → 用个人赛饵", async () => {
    const { equipped, log, start } = makeCtx({ personal: personalActive, weather: "clear" });
    const run = await start();
    await run();
    expect(equipped).toEqual(["bait_supreme"]);
    expect(log.info.some((m) => m.includes("个人赛 #7") && m.includes("顶级饵"))).toBe(true);
  });

  it("★ 公会赛即将开赛 → 用公会赛饵", async () => {
    const { equipped, log, start } = makeCtx({ guild: guildSoon, weather: "clear" });
    const run = await start();
    await run();
    expect(equipped).toEqual(["bait_high"]);
    expect(log.info.some((m) => m.includes("公会赛 #3"))).toBe(true);
  });

  it("★ 优先级：个人赛 > 公会赛 > 金风 > 涌流 > 平时", async () => {
    // 个人赛 + 公会赛同时在 → 取个人赛
    const both = makeCtx({ personal: personalActive, guild: guildSoon, weather: "gilded_current" });
    const runBoth = await both.start();
    await runBoth();
    expect(both.equipped).toEqual(["bait_supreme"]);

    // 只有公会赛 + 金风 → 取公会赛
    const guildGolden = makeCtx({ guild: guildSoon, weather: "gilded_current" });
    const runGuild = await guildGolden.start();
    await runGuild();
    expect(guildGolden.equipped).toEqual(["bait_high"]);

    // 金风 + 无比赛 → 取金风
    const golden = makeCtx({ weather: "gilded_current" });
    const runGolden = await golden.start();
    await runGolden();
    expect(golden.equipped).toEqual(["bait_medium"]);

    // 涌流
    const surge = makeCtx({ weather: "arcane_surge" });
    const runSurge = await surge.start();
    await runSurge();
    expect(surge.equipped).toEqual(["bait_low"]);

    // 其它天气 → 平时
    const normal = makeCtx({ weather: "rain" });
    const runNormal = await normal.start();
    await runNormal();
    expect(normal.equipped).toEqual(["bait_basic"]);
  });

  it("★ 报名了但比赛已结束 / 还没到提前量 → 不算比赛场景", async () => {
    const finished = makeCtx({
      personal: { current: { id: "t1", sequence: 9, status: "settled", isRegistered: true }, upcoming: [] },
      weather: "rain",
    });
    const runFinished = await finished.start();
    await runFinished();
    expect(finished.equipped).toEqual(["bait_basic"]); // 平时饵

    const farAway = makeCtx({
      personal: {
        current: null,
        upcoming: [
          {
            id: "t2",
            sequence: 11,
            status: "scheduled",
            isRegistered: true,
            startAt: new Date(Date.now() + 3600_000).toISOString(), // 1 小时后
          },
        ],
      },
      weather: "rain",
    });
    const runFar = await farAway.start();
    await runFar();
    expect(farAway.equipped).toEqual(["bait_basic"]);
  });

  it("★ 没报名就不算比赛场景（避免没参赛却烧高级饵）", async () => {
    const notRegistered = makeCtx({
      personal: { current: { id: "t1", sequence: 5, status: "active", isRegistered: false }, upcoming: [] },
      weather: "rain",
    });
    const run = await notRegistered.start();
    await run();
    expect(notRegistered.equipped).toEqual(["bait_basic"]);
  });

  it("场景没配饵（留空）→ 不切换", async () => {
    const { equipped, log, start } = makeCtx({ weather: "gilded_current", config: { goldenBait: "" } });
    const run = await start();
    await run();
    expect(equipped).toEqual([]);
    expect(log.debug.some((m) => m.includes("金风") && m.includes("未配置鱼饵"))).toBe(true);
  });

  it("已经在用该场景的饵 → 不重复装备", async () => {
    const { ctx, equipped, log, start } = makeCtx({ weather: "arcane_surge" });
    // 先手动把涌流饵设成已选中
    const api = ctx.api as unknown as { baits: () => Promise<{ baits: unknown[] }> };
    const original = api.baits;
    api.baits = async () => {
      const d = await original();
      return { baits: d.baits.map((b) => ({ ...(b as object), isSelected: (b as { id: string }).id === "bait_low" })) };
    };
    const run = await start();
    await run();
    expect(equipped).toEqual([]);
    expect(log.debug.some((m) => m.includes("已在用"))).toBe(true);
  });

  it("接口异常时不崩（比赛信息拿不到就按天气/平时判）", async () => {
    const { ctx, equipped, start } = makeCtx({ weather: "arcane_surge" });
    (ctx.api as unknown as { tournamentsOverview: () => Promise<unknown> }).tournamentsOverview = async () => {
      throw new Error("HTTP 500");
    };
    (ctx.api as unknown as { guildTournamentsOverview: () => Promise<unknown> }).guildTournamentsOverview = async () => {
      throw new Error("HTTP 500");
    };
    const run = await start();
    await run();
    expect(equipped).toEqual(["bait_low"]); // 仍然是涌流场景
  });

  it("配置项与 5 个场景一一对应", () => {
    const keys = autoBait.configSchema.map((f) => f.key);
    for (const k of [
      "personalCompetitionBait",
      "guildCompetitionBait",
      "goldenBait",
      "surgeBait",
      "normalBait",
    ]) {
      expect(keys).toContain(k);
    }
  });
});
