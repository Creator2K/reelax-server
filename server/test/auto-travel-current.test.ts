// Regression: newer game responses may omit per-map isCurrent and only return currentBiomeId.
import { beforeEach, describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoTravel from "../src/modules/auto-travel/index.ts";
import { clearTravelLocks } from "../src/modules/shared/travel-lock.ts";

const HOME = "b_001";
const STORM = "b_002";

function makeCtx() {
  const calls: string[] = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];
  const api = {
    biomes: async () => ({
      currentBiomeId: HOME,
      biomes: [
        { id: HOME, name: "home", isUnlocked: true, valueMultiplier: 1, weather: { weatherId: "clear" } },
        { id: STORM, name: "storm", isUnlocked: true, valueMultiplier: 1.1, weather: { weatherId: "tempest" } },
      ],
    }),
    tournamentsOverview: async () => ({ current: null, upcoming: [] }),
    guildTournamentsOverview: async () => ({ current: null, upcoming: [] }),
    fishingState: async () => ({ party: { isInParty: false } }),
    partyBoatsOverview: async () => ({ party: null, crew: null }),
    biomeTravel: async (id: string) => {
      calls.push(id);
      return { player: { currentBiomeId: id } };
    },
  };
  const ctx = {
    moduleId: "auto-travel",
    config: {
      priorities: "experience",
      surgeBiome: "auto",
      crewTravel: "off",
      checkEverySec: 120,
      minImprovePct: 0,
      travelCooldownSec: 600,
      competitionLeadSec: 180,
    },
    state: {},
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    api,
    account: { accountId: "acct-current", moduleInstances: ["auto-travel"] },
    on: () => () => {},
    every: () => ({}) as NodeJS.Timeout,
    schedule: (ms: number, fn: () => unknown) => {
      timers.push({ ms, fn });
      return {} as NodeJS.Timeout;
    },
    persistState: () => {},
  } as unknown as ModuleContext;
  return { ctx, calls, timers };
}

beforeEach(() => clearTravelLocks());

describe("auto-travel current map compatibility", () => {
  it("travels when /api/biomes only provides top-level currentBiomeId", async () => {
    const { ctx, calls, timers } = makeCtx();
    await autoTravel.onStart!(ctx);
    const run = timers.filter((t) => t.ms === 30_000).at(-1)!;
    await run.fn();
    expect(calls).toEqual([STORM]);
  });
});
