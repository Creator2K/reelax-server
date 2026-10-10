// 定时配装：模块行为（对着假游戏 API 跑真实 onStart）
//
// 单测覆盖时间表怎么解析，这里覆盖**真的会不会去切、切几次**：
//  · 到点切一次
//  · 同一目标不重复发请求（否则每分钟一次装备请求）
//  · 演练模式不碰装备
//  · 目标不存在 / 装载失败时只提示，并退避重试
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoLoadout from "../src/modules/auto-loadout/index.ts";

/** 三套配装：1 号有名字、2 号有名字、3 号是空槽 */
const LOADOUTS = {
  loadouts: [
    { slot: 1, name: "刷经验", gear: { head: { id: "g1" } }, stats: {} },
    { slot: 2, name: "比赛套", gear: { head: { id: "g2" }, chest: { id: "g3" } }, stats: {} },
    { slot: 3, name: null, gear: {}, stats: {} },
  ],
};

type FakeOpts = {
  plan?: string;
  dryRun?: boolean;
  loadouts?: unknown;
  loadoutsError?: Error;
  loadError?: Error;
};

function makeCtx(opts: FakeOpts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const calls: string[] = [];
  const scheduled: Array<() => unknown> = [];

  const api = {
    gearLoadouts: async () => {
      calls.push("GET /api/gear/loadouts");
      if (opts.loadoutsError) throw opts.loadoutsError;
      return opts.loadouts ?? LOADOUTS;
    },
    loadoutLoad: async (slot: number) => {
      calls.push(`POST /api/gear/loadouts/${slot}/load`);
      if (opts.loadError) throw opts.loadError;
      return {};
    },
  };

  const ctx = {
    moduleId: "auto-loadout",
    // 00:00 起生效 = 全天都用它，测试不依赖跑测试的钟点
    config: { plan: opts.plan ?? "00:00 2", checkEverySec: 30, dryRun: opts.dryRun === true },
    state: {},
    log: {
      debug: (_tag: string, msg: string) => log.debug.push(msg),
      info: (_tag: string, msg: string) => log.info.push(msg),
      warn: (_tag: string, msg: string) => log.warn.push(msg),
      error: (_tag: string, msg: string) => log.warn.push(msg),
    },
    api,
    account: {},
    on: () => () => {},
    every: () => ({}) as NodeJS.Timeout,
    schedule: (_ms: number, fn: () => unknown) => {
      scheduled.push(fn);
      return {} as NodeJS.Timeout;
    },
  } as unknown as ModuleContext;

  return {
    ctx,
    log,
    calls,
    /** 启动 + 跑一次检查 */
    start: async () => {
      await autoLoadout.onStart!(ctx);
      return async () => scheduled[scheduled.length - 1]!();
    },
  };
}

describe("定时配装模块", () => {
  it("启动时把时间表讲清楚（含写错的行）", async () => {
    const { log, start } = makeCtx({ plan: "00:00 1\n21:00 比赛套\n乱写一行" });
    await start();

    expect(log.info.some((m) => m.includes("时间表 2 条"))).toBe(true);
    expect(log.info.some((m) => m.includes("00:00→1 号配装"))).toBe(true);
    expect(log.warn.some((m) => m.includes("看不懂"))).toBe(true);
  });

  it("★ 到点切一次，且同一目标不重复发请求", async () => {
    const { calls, log, start } = makeCtx({ plan: "00:00 2" });
    const check = await start();

    await check();
    expect(calls).toEqual(["GET /api/gear/loadouts", "POST /api/gear/loadouts/2/load"]);
    expect(log.info.some((m) => m.includes("已切换到 2 号「比赛套」（2 件）"))).toBe(true);

    // 再检查两次：目标没变，不该再发任何请求（否则每分钟一次装备请求）
    await check();
    await check();
    expect(calls).toEqual(["GET /api/gear/loadouts", "POST /api/gear/loadouts/2/load"]);
  });

  it("按配装名匹配（游戏里显示的名字）", async () => {
    const { calls, start } = makeCtx({ plan: "00:00 = 比赛套" });
    const check = await start();
    await check();

    expect(calls).toContain("POST /api/gear/loadouts/2/load");
  });

  it("★ 演练模式只记录，不碰装备", async () => {
    const { calls, log, start } = makeCtx({ plan: "00:00 2", dryRun: true });
    const check = await start();

    await check();
    expect(calls).toEqual(["GET /api/gear/loadouts"]);
    expect(log.info.some((m) => m.includes("[演练]") && m.includes("未真的切换"))).toBe(true);
    expect(log.info.some((m) => m.includes("演练模式已开启"))).toBe(true);
  });

  it("配装号不存在 → 提示可用项，不发装载请求", async () => {
    const { calls, log, start } = makeCtx({ plan: "00:00 9" });
    const check = await start();

    await check();
    expect(calls).toEqual(["GET /api/gear/loadouts"]);
    expect(log.warn.some((m) => m.includes("没有 9 号配装") && m.includes("1 号「刷经验」"))).toBe(true);
  });

  it("★ 空配装槽被拒绝（切上去等于把装备全脱了）", async () => {
    const { calls, log, start } = makeCtx({ plan: "00:00 3" });
    const check = await start();

    await check();
    expect(calls).toEqual(["GET /api/gear/loadouts"]);
    expect(log.warn.some((m) => m.includes("3 号配装是空的"))).toBe(true);
  });

  it("配装名对不上 → 提示现有配装名", async () => {
    const { log, start } = makeCtx({ plan: "00:00 涌流套" });
    const check = await start();

    await check();
    expect(log.warn.some((m) => m.includes("没有叫「涌流套」的配装") && m.includes("比赛套"))).toBe(true);
  });

  it("读不到配装列表时不崩，只记一次警告", async () => {
    const { calls, log, start } = makeCtx({ loadoutsError: new Error("HTTP 500") });
    const check = await start();

    await check();
    await check();
    expect(calls).toEqual(["GET /api/gear/loadouts", "GET /api/gear/loadouts"]);
    expect(log.warn.filter((m) => m.includes("读不到配装列表"))).toHaveLength(1);
  });

  it("★ 装载失败会退避：5 分钟内不重复撞同一个目标", async () => {
    const { calls, log, start } = makeCtx({ loadError: new Error("GEAR_LOCKED") });
    const check = await start();

    await check();
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(log.warn.some((m) => m.includes("失败") && m.includes("分钟后重试"))).toBe(true);

    await check();
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("时间表为空 → 启动时明确警告，且什么都不做", async () => {
    const { calls, log, start } = makeCtx({ plan: "   \n# 还没想好\n" });
    const check = await start();

    await check();
    expect(calls).toEqual([]);
    expect(log.warn.some((m) => m.includes("时间表为空"))).toBe(true);
  });

  it("★ 里程碑切换：到了下一条才换（模拟一天两次）", async () => {
    // 23:59 起用 1 号：只要测试不是正好在 23:59 跑，当前时段就应该是「2 号」之外的另一条
    const { calls, start } = makeCtx({ plan: "00:00 2\n23:59 1" });
    const check = await start();
    await check();

    const now = new Date();
    const expectSlot = now.getHours() === 23 && now.getMinutes() === 59 ? 1 : 2;
    expect(calls).toContain(`POST /api/gear/loadouts/${expectSlot}/load`);
  });
});
