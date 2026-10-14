// 自动切图：比赛目标判定（对着假游戏 API 跑真实 onStart）
//
// ★ 这里钉住的是一个真实踩过的坑：**比赛结束后人永远留在比赛图，天气再好也不切**。
//   根因是比赛目标的三处校验缺失：状态不看终态、开赛时间没有下界、公会赛只看 entryStatus。
//   修复后：历史场次 / 已结束场次一律不再当作「该去的比赛图」。
import { beforeEach, describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoTravel from "../src/modules/auto-travel/index.ts";
import { clearTravelLocks } from "../src/modules/shared/travel-lock.ts";

const HOME = "b_home"; // 月落溪谷（晴空 ×1.00）
const STORM = "b_storm"; // 熔潮环礁（雷暴 ×1.50）—— 天气最好的图
const GOLD = "b_gold"; // 星渊圣海（金风 ×0.75）
const COMP = "b_comp"; // 竞潮湾（比赛图）

type FakeOpts = {
  priorities?: string | string[];
  personal?: unknown;
  guild?: unknown;
  /** 所有地图的天气（默认各图自带） */
  weather?: string;
  /** 船队状态（默认没加入船队） */
  party?: unknown;
  /** 覆盖配置项（例如 surgeBiome / crewTravel） */
  config?: Record<string, unknown>;
};

function makeCtx(opts: FakeOpts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const calls: string[] = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];
  const world = { currentBiome: HOME };

  const biomes = [
    { id: HOME, name: "月落溪谷", valueMultiplier: 1.0, weather: { weatherId: "clear" } },
    { id: STORM, name: "熔潮环礁", valueMultiplier: 1.1, weather: { weatherId: "tempest" } },
    { id: GOLD, name: "星渊圣海", valueMultiplier: 1.2, weather: { weatherId: "gilded_current" } },
    { id: COMP, name: "竞潮湾", valueMultiplier: 1.0, weather: { weatherId: "clear" } },
  ];

  const api = {
    biomes: async () => ({
      biomes: biomes.map((b) => ({
        ...b,
        isUnlocked: true,
        isCurrent: b.id === world.currentBiome,
        ...(opts.weather ? { weather: { weatherId: opts.weather } } : {}),
      })),
    }),
    tournamentsOverview: async () => opts.personal ?? { current: null, upcoming: [] },
    guildTournamentsOverview: async () => opts.guild ?? { current: null, upcoming: [] },
    fishingState: async () => ({ party: opts.party ?? { isInParty: false } }),
    biomeTravel: async (id: string) => {
      calls.push(`TRAVEL ${id}`);
      world.currentBiome = id;
      return { player: { currentBiomeId: id } };
    },
  };

  const ctx = {
    moduleId: "auto-travel",
    config: {
      priorities: opts.priorities ?? "competition,golden,experience",
      fleetMode: "solo",
      checkEverySec: 120,
      minImprovePct: 3,
      travelCooldownSec: 600,
      competitionLeadSec: 180,
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
    account: { accountId: "acct-travel", moduleInstances: ["auto-travel"] },
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
      await autoTravel.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 30_000).at(-1);
        await t?.fn();
      };
    },
  };
}

const travels = (calls: string[]) => calls.filter((c) => c.startsWith("TRAVEL"));
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

describe("自动切图：比赛目标", () => {
  beforeEach(() => clearTravelLocks());

  it("★ 个人赛进行中（status=active）→ 去比赛图", async () => {
    const { calls, world, start } = makeCtx({
      personal: {
        current: { id: "t1", sequence: 3, status: "active", isRegistered: true, assignedBiomeId: COMP },
        upcoming: [],
      },
    });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${COMP}`]);
    expect(world.currentBiome).toBe(COMP);
  });

  it("★ 比赛已结束（status=ended，但仍是 current 且 isRegistered）→ 不再把比赛图当目标", async () => {
    const { calls, world, start } = makeCtx({
      priorities: "experience,golden,competition",
      personal: {
        current: { id: "t1", sequence: 3, status: "ended", isRegistered: true, assignedBiomeId: COMP },
        upcoming: [],
      },
    });
    const run = await start();

    await run();
    // 旧版这里会一直往比赛图跑（而且已经在比赛图时永远不动）
    expect(travels(calls)).toEqual([`TRAVEL ${STORM}`]); // 按天气走
    expect(world.currentBiome).toBe(STORM);
  });

  it("★ upcoming 里的历史场次（开赛时间在过去）不再当目标", async () => {
    const { calls, world, start } = makeCtx({
      priorities: "experience,golden,competition",
      personal: {
        current: null,
        upcoming: [
          { id: "t0", sequence: 1, status: "scheduled", isRegistered: true, startAt: hoursAgo(2), assignedBiomeId: COMP },
        ],
      },
    });
    const run = await start();

    await run();
    // 旧版：`startAt - now <= lead` 对历史场次永远成立 → 永久粘在比赛图
    expect(travels(calls)).toEqual([`TRAVEL ${STORM}`]);
    expect(world.currentBiome).toBe(STORM);
  });

  it("upcoming 即将开赛（在提前量内）→ 去比赛图", async () => {
    const { calls, start } = makeCtx({
      personal: {
        current: null,
        upcoming: [
          { id: "t2", sequence: 4, status: "scheduled", isRegistered: true, startAt: inSeconds(60), assignedBiomeId: COMP },
        ],
      },
    });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${COMP}`]);
  });

  it("upcoming 还早（超出提前量）→ 不去，按优先级挑图", async () => {
    const { calls, start } = makeCtx({
      priorities: "experience,golden,competition",
      personal: {
        current: null,
        upcoming: [
          { id: "t3", sequence: 5, status: "scheduled", isRegistered: true, startAt: inSeconds(3600), assignedBiomeId: COMP },
        ],
      },
    });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${STORM}`]);
  });

  it("★ 公会赛已结束（entryStatus 还在）→ 不当目标", async () => {
    const { calls, start } = makeCtx({
      priorities: "experience,golden,competition",
      guild: {
        current: { id: "g1", sequence: 2, status: "ended", entryStatus: "approved", assignedBiomeId: COMP },
        upcoming: [],
      },
    });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${STORM}`]);
  });

  it("公会赛进行中（entryStatus + active）→ 去比赛图", async () => {
    const { calls, start } = makeCtx({
      guild: {
        current: { id: "g1", sequence: 2, status: "active", entryStatus: "approved", assignedBiomeId: COMP },
        upcoming: [],
      },
    });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${COMP}`]);
  });

  it("没有比赛时按优先级走：经验优先 → 去天气最好的图（不是金风图）", async () => {
    const { calls, start } = makeCtx({ priorities: "experience,golden,competition" });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${STORM}`]);
  });

  it("默认优先级（比赛 > 金风 > 经验）下没有比赛 → 去金风图（设计如此，可改配置）", async () => {
    const { calls, start } = makeCtx();
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${GOLD}`]);
  });
});

describe("自动切图：「跟船队走」作为优先级的一项（端到端接线）", () => {
  beforeEach(() => clearTravelLocks());

  const inFleet = { isInParty: true, canChangeBoatBiome: false, boatName: "芦汐轻舟", boatBiomeId: HOME };

  it("★ 列表里有「跟船队走」且在船队里 → 本模块完全不换图", async () => {
    const { calls, log, start } = makeCtx({ priorities: ["follow", "experience"], party: inFleet });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([]);
    expect(log.info.some((m) => m.includes("跟船队走") && m.includes("芦汐轻舟"))).toBe(true);
  });

  it("★ 旧键 fleetMode 在运行时被忽略（换算只做一次，见 config-upgrades）", async () => {
    // 旧版这里会「fleetMode=follow → 自动把跟船队走加进列表」，那是错的：
    // 旧键永远留在库里，用户把它从列表里删掉也会被加回来。现在换算由启动时的
    // config-upgrades 一次性完成并删除旧键，模块本身不再认它。
    const { calls, start } = makeCtx({
      priorities: "golden,experience",
      party: inFleet,
      config: { fleetMode: "follow" },
    });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${GOLD}`]);
  });

  it("★ 没加入船队 → 跳过这一项，照常按后面的优先级换图", async () => {
    const { calls, start } = makeCtx({ priorities: ["follow", "golden", "experience"] });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${GOLD}`]);
  });

  it("只保留「跟船队走」一项且没船队 → 不动（没有可去的地图）", async () => {
    const { calls, log, start } = makeCtx({ priorities: ["follow"] });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([]);
    expect(log.info.some((m) => m.includes("没有可去的地图"))).toBe(true);
  });
});

describe("自动切图：涌流期间的目标（端到端接线）", () => {
  beforeEach(() => clearTravelLocks());

  it("★ 涌流覆盖所有地图时，留空配置 → 去已解锁的最高地图（不是最小 id 的新手图）", async () => {
    const { calls, world, start } = makeCtx({
      priorities: "golden,experience",
      weather: "arcane_surge",
      config: { surgeBiome: "" },
    });
    const run = await start();

    await run();
    // 三张图倍率 1.0 / 1.1 / 1.2 → 最高的是 GOLD；而「经验」若按天气比大小只会挑到最小 id
    expect(travels(calls)).toEqual([`TRAVEL ${GOLD}`]);
    expect(world.currentBiome).toBe(GOLD);
  });

  it("配置了具体地图 → 就去那张", async () => {
    const { calls, start } = makeCtx({
      priorities: "golden,experience",
      weather: "arcane_surge",
      config: { surgeBiome: STORM },
    });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${STORM}`]);
  });

  it("没有涌流时不会因为配了涌流目标就跑过去（而是按「天气相同就看鱼价值」挑最高那张）", async () => {
    const { calls, start } = makeCtx({
      priorities: "golden,experience",
      weather: "clear",
      config: { surgeBiome: STORM }, // 配的是价值较低的图
    });
    const run = await start();

    await run();
    // 天气全是晴朗 ×1.0 → 涌流分支进不去；「经验」看到倍率全都一样，
    // 于是按鱼价值取最高（GOLD 1.2 > STORM 1.1）→ 去 GOLD，而不是配置的 STORM
    expect(travels(calls)).toEqual([`TRAVEL ${GOLD}`]);
  });
});
