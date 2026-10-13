// 自动切图：带队换图（船长 / 舵手把船员一起带走）
//
// ★ 规则来自用户的明确要求：
//   1. 换图时把船员带到自己的地图 —— 用船队换图接口（POST /api/party-boats/current-biome），
//      而不是个人换图（PUT /api/player/current-biome）；
//   2. 船员未解锁目标图 / 不在船上时由游戏跳过，我们只报数；
//   3. 拉不动时**不要一直重复拉**：失败有冷却，连续 3 次后长时间不再尝试；
//   4. 没有船长权限时不生效，按普通换图处理。
import { beforeEach, describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoTravel from "../src/modules/auto-travel/index.ts";
import { clearTravelLocks } from "../src/modules/shared/travel-lock.ts";

const HOME = "b_001"; // 当前所在地图（晴朗）
const STORM = "b_002"; // 天气最好（雷暴 ×1.5）→ 决策一定会去这张

type Opts = {
  crewTravel?: string;
  party?: unknown;
  /** 船队换图接口抛这个错误 */
  partyError?: Error;
  /** 船队换图接口的响应 */
  partyResult?: unknown;
};

function makeCtx(opts: Opts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const calls: string[] = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];
  const world = { currentBiome: HOME };

  const biomes = [
    { id: HOME, name: "月落溪谷", valueMultiplier: 1, weather: { weatherId: "clear" } },
    { id: STORM, name: "雾语湿地", valueMultiplier: 1.05, weather: { weatherId: "tempest" } },
  ];

  const api = {
    biomes: async () => ({
      biomes: biomes.map((b) => ({ ...b, isUnlocked: true, isCurrent: b.id === world.currentBiome })),
    }),
    tournamentsOverview: async () => ({ current: null, upcoming: [] }),
    guildTournamentsOverview: async () => ({ current: null, upcoming: [] }),
    fishingState: async () => ({ party: opts.party ?? { isInParty: false } }),
    biomeTravel: async (id: string) => {
      calls.push(`PERSONAL ${id}`);
      world.currentBiome = id;
      return { player: { currentBiomeId: id } };
    },
    partyBoatTravel: async (id: string) => {
      calls.push(`PARTY ${id}`);
      if (opts.partyError) throw opts.partyError;
      world.currentBiome = id;
      return opts.partyResult ?? { currentBoatBiomeId: id, changed: true, movedCount: 1 };
    },
  };

  const ctx = {
    moduleId: "auto-travel",
    config: {
      priorities: "experience,golden,competition",
      surgeBiome: "",
      crewTravel: opts.crewTravel ?? "off",
      fleetMode: "solo",
      checkEverySec: 120,
      minImprovePct: 0,
      travelCooldownSec: 600,
      competitionLeadSec: 180,
    },
    state: {},
    log: {
      debug: (_t: string, m: string) => log.debug.push(m),
      info: (_t: string, m: string) => log.info.push(m),
      warn: (_t: string, m: string) => log.warn.push(m),
      error: (_t: string, m: string) => log.warn.push(m),
    },
    api,
    account: { accountId: "acct-crew", moduleInstances: ["auto-travel"] },
    on: () => () => {},
    every: () => ({}) as NodeJS.Timeout,
    schedule: (ms: number, fn: () => unknown) => {
      timers.push({ ms, fn });
      return {} as NodeJS.Timeout;
    },
    persistState: () => {},
  } as unknown as ModuleContext;

  const start = async () => {
    await autoTravel.onStart!(ctx);
    return async () => {
      const t = timers.filter((x) => x.ms === 30_000).at(-1);
      await t?.fn();
    };
  };

  return { ctx, log, calls, world, start, state: ctx.state as Record<string, number | string | object> };
}

/** 船长（可改航线） */
const CAPTAIN = { isInParty: true, role: "captain", canChangeBoatBiome: true, boatName: "芦汐轻舟", boatBiomeId: HOME };
/** 普通船员（不可改航线） */
const CREW = { isInParty: true, role: "crew", canChangeBoatBiome: false, boatName: "芦汐轻舟", boatBiomeId: HOME };

describe("自动切图 · 带队换图", () => {
  beforeEach(() => clearTravelLocks());

  it("★ 船长开启「带走船员」→ 用船队接口整条船开过去", async () => {
    const { calls, log, start } = makeCtx({
      crewTravel: "carry",
      party: CAPTAIN,
      partyResult: {
        currentBoatBiomeId: STORM,
        changed: true,
        movedCount: 3,
        skippedLockedCount: 1,
        skippedAwayCount: 1,
        skippedGuildCompetitionCount: 0,
      },
    });
    const run = await start();

    await run();
    expect(calls).toEqual([`PARTY ${STORM}`]); // 不调用个人换图
    const line = log.info.find((m) => m.includes("带队："));
    expect(line).toContain("随船 3 人");
    expect(line).toContain("留在原地 2 人");
    expect(line).toContain("未解锁目标 1");
    expect(line).toContain("不在船上 1");
  });

  it("★ 不是船长（无改航线权限）→ 按普通换图，并说明原因", async () => {
    const { calls, log, start } = makeCtx({ crewTravel: "carry", party: CREW });
    const run = await start();

    await run();
    expect(calls).toEqual([`PERSONAL ${STORM}`]);
    expect(log.info.some((m) => m.includes("权限") && m.includes("普通换图"))).toBe(true);
  });

  it("没有加入船队 → 按普通换图（只提示一次）", async () => {
    const { calls, log, start } = makeCtx({ crewTravel: "carry", party: { isInParty: false } });
    const run = await start();

    await run();
    expect(calls).toEqual([`PERSONAL ${STORM}`]);
    expect(log.info.some((m) => m.includes("没有加入船队"))).toBe(true);
  });

  it("默认（不开启）→ 即使有船长权限也是个人换图", async () => {
    const { calls, start } = makeCtx({ crewTravel: "off", party: CAPTAIN });
    const run = await start();

    await run();
    expect(calls).toEqual([`PERSONAL ${STORM}`]);
  });

  it("★ 开船失败：不单独换图，并且不会连着重复拉船员", async () => {
    const { state, calls, log, start } = makeCtx({
      crewTravel: "carry",
      party: CAPTAIN,
      partyError: new Error("船队正在移动中（PARTY_BOAT_TRAVEL_IN_PROGRESS）"),
    });
    const run = await start();

    await run();
    expect(calls).toEqual([`PARTY ${STORM}`]); // 没有退化成个人换图
    expect(log.warn.some((m) => m.includes("带队前往") && m.includes("第 1 次"))).toBe(true);

    // 绕过换图冷却再试一次：这次连请求都不该发（仍在暂缓期内）
    state.lastTravelAt = 0;
    await run();
    expect(calls).toEqual([`PARTY ${STORM}`]);
    expect(log.debug.some((m) => m.includes("暂缓中"))).toBe(true);
  });

  it("★ 连续失败 3 次 → 长时间不再尝试（目标变化后才恢复）", async () => {
    const { state, calls, log, start } = makeCtx({
      crewTravel: "carry",
      party: CAPTAIN,
      partyError: new Error("地图尚未解锁"),
    });
    const run = await start();

    for (let i = 0; i < 3; i++) {
      // 每轮清掉「暂缓」以便重试，但保留连续失败计数
      (state.crewWaitUntil as Record<string, number>)[STORM] = 0;
      state.lastTravelAt = 0;
      await run();
    }
    expect(calls).toEqual([`PARTY ${STORM}`, `PARTY ${STORM}`, `PARTY ${STORM}`]);
    expect(log.warn.some((m) => m.includes("第 3 次") && m.includes("暂停尝试"))).toBe(true);

    const before = calls.length;
    state.lastTravelAt = 0;
    await run();
    expect(calls.length).toBe(before); // 真的一次都不再试
  });

  it("船本来就在目标图（changed=false）→ 如实记录，不当作换图成功", async () => {
    const { state, calls, log, start } = makeCtx({
      crewTravel: "carry",
      party: CAPTAIN,
      partyResult: { currentBoatBiomeId: STORM, changed: false, movedCount: 0, skippedLockedCount: 0 },
    });
    const run = await start();

    await run();
    expect(calls).toEqual([`PARTY ${STORM}`]);
    expect(log.info.some((m) => m.includes("本次未开船"))).toBe(true);

    // 这一轮之后暂缓，避免下一轮又来一次同样的开船请求
    state.lastTravelAt = 0;
    await run();
    expect(calls).toEqual([`PARTY ${STORM}`]);
  });
});
