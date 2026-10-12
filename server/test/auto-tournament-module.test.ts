// 自动报名赛事：模块行为（对着假游戏 API 跑真实 onStart）
//
// 重点钉住「报名」与「进图」是**两件独立的事**：
//   · 别人占着换图决策权（「保底切图」守保底中）时 → 只跳过进图，**报名照常**
//   · 别人放开之后 → 进图恢复
//   · 自己的 travelToBiome 开关关掉时 → 同样只影响进图，报名照常
import { beforeEach, describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoTournament from "../src/modules/auto-tournament/index.ts";
import { clearTravelLocks, holdTravel, releaseTravel } from "../src/modules/shared/travel-lock.ts";

const ACCOUNT = "acct-t";
const BIOME_HOME = "b_001";
const BIOME_COMP = "b_020";

type FakeOpts = { config?: Record<string, unknown> };

function makeCtx(opts: FakeOpts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const calls: string[] = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];

  const world = { currentBiome: BIOME_HOME };

  const api = {
    now: () => Date.now(),
    // 一场「进行中且已报名」的比赛（进图候选）+ 一场「可以报名」的个人赛（报名候选）
    tournamentsOverview: async () => ({
      current: {
        id: "t-running",
        sequence: 7,
        status: "active",
        canRegister: false,
        isRegistered: true,
        assignedBiomeId: BIOME_COMP,
      },
      upcoming: [{ id: "t-next", sequence: 8, status: "scheduled", canRegister: true, isRegistered: false }],
    }),
    guildTournamentsOverview: async () => ({ current: null, upcoming: [] }),
    guildsMe: async () => ({ membership: { role: "member" } }),
    tournamentRegister: async (id: string) => {
      calls.push(`REGISTER ${id}`);
      return {};
    },
    guildTournamentRegister: async (id: string) => {
      calls.push(`GUILD-REGISTER ${id}`);
      return {};
    },
    biomes: async () => ({
      biomes: [
        { id: BIOME_HOME, name: "月落溪谷", isCurrent: world.currentBiome === BIOME_HOME },
        { id: BIOME_COMP, name: "竞潮湾", isCurrent: world.currentBiome === BIOME_COMP },
      ],
    }),
    biomeTravel: async (id: string) => {
      calls.push(`TRAVEL ${id}`);
      world.currentBiome = id;
      return {};
    },
  };

  const ctx = {
    moduleId: "auto-tournament",
    config: {
      registerPersonal: true,
      registerGuild: false,
      travelToBiome: true,
      travelLeadSec: 180,
      checkEveryMin: 3,
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
    account: { accountId: ACCOUNT, moduleInstances: ["auto-tournament"] },
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
    /** 启动模块并拿到"时间到了"的执行函数（可重复调用，模拟定时检查） */
    start: async () => {
      await autoTournament.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 25_000).at(-1);
        await t?.fn();
      };
    },
  };
}

const travels = (calls: string[]) => calls.filter((c) => c.startsWith("TRAVEL"));

describe("自动报名赛事模块", () => {
  beforeEach(() => clearTravelLocks());

  it("★ 没人占着时：报名 + 进图都做", async () => {
    const { calls, world, start } = makeCtx();
    const run = await start();

    await run();
    expect(calls).toContain("REGISTER t-next");
    expect(travels(calls)).toEqual([`TRAVEL ${BIOME_COMP}`]);
    expect(world.currentBiome).toBe(BIOME_COMP);
  });

  it("★ 别人占着换图决策权时：报名照常，但不进比赛图", async () => {
    const { calls, log, world, start } = makeCtx();
    holdTravel(ACCOUNT, `auto-pity:${ACCOUNT}`, "保底切图（守保底中）");
    const run = await start();

    await run();
    expect(calls).toContain("REGISTER t-next"); // ★ 报名没被影响
    expect(travels(calls)).toEqual([]); // 进图让路
    expect(world.currentBiome).toBe(BIOME_HOME);
    const notice = log.info.find((m) => m.includes("正在占着换图决策权"));
    expect(notice).toBeTruthy();
    expect(notice).toContain("报名照常");
  });

  it("★ 占着的一方放开后，进图恢复（同一个实例，不必重启）", async () => {
    const { calls, world, start } = makeCtx();
    holdTravel(ACCOUNT, `auto-pity:${ACCOUNT}`, "保底切图（守保底中）");
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([]);

    releaseTravel(ACCOUNT, `auto-pity:${ACCOUNT}`);
    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${BIOME_COMP}`]);
    expect(world.currentBiome).toBe(BIOME_COMP);
  });

  it("自己的「自动前往比赛地图」关掉时：只跳过进图，报名照常", async () => {
    const { calls, world, start } = makeCtx({ config: { travelToBiome: false } });
    const run = await start();

    await run();
    expect(calls).toContain("REGISTER t-next");
    expect(travels(calls)).toEqual([]);
    expect(world.currentBiome).toBe(BIOME_HOME);
  });

  it("没有需要进图的比赛时什么也不做", async () => {
    const { ctx, calls, start } = makeCtx();
    (ctx.api as unknown as { tournamentsOverview: () => Promise<unknown> }).tournamentsOverview = async () => ({
      current: null,
      upcoming: [],
    });
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([]);
  });

  it("别的账号在守保底不影响本账号进图（锁按账号隔离）", async () => {
    const { calls, world, start } = makeCtx();
    holdTravel("别的账号", "auto-pity:别的账号", "保底切图（守保底中）");
    const run = await start();

    await run();
    expect(travels(calls)).toEqual([`TRAVEL ${BIOME_COMP}`]);
    expect(world.currentBiome).toBe(BIOME_COMP);
  });
});
