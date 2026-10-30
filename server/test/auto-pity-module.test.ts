// 保底切图：模块行为（对着假游戏 API 跑真实 onStart）
//
// 本项目**自己负责换图**，与官方助手零接触（不读它的开关、不接管、不提示）。
// 这里钉住的是完整链路与两个踩过的坑：
//   · 快触发保底 → 切到保底图；出货 → 切回原图
//   · ★ 出货后即使过了缓冲期也要切回（旧版因为下一轮 caught 变 false，永远不切回）
//   · ★ 保底期间暂停「自动切图」，出货切回后恢复（B1：不让它把人从保底图拽走）
//   · ★ 被别的东西挪走后抢回一次（自愈），再被挪走就不抢了
//   · 保底数据为 null（当前条件无保底）时给出能看懂的 info 提示
import { beforeEach, describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoPity from "../src/modules/auto-pity/index.ts";
import { clearTravelLocks, isTravelHeld } from "../src/modules/shared/travel-lock.ts";

const ACCOUNT = "acct-pity";
const BIOME_HOME = "b_001";
const BIOME_PITY = "b_015";
/** 第三方地图：模拟"被别的东西挪走"后的落点 */
const BIOME_OTHER = "b_009";

type FakeOpts = {
  config?: Record<string, unknown>;
  /** 假运行时的模块实例列表（不含 auto-travel 就等于它没开） */
  moduleInstances?: string[];
};

function makeCtx(opts: FakeOpts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const calls: string[] = [];
  const timers: Array<{ ms: number; fn: () => unknown }> = [];

  const world = {
    currentBiome: BIOME_HOME,
    dry: 1180, // hardPityCasts 1200 → 还差 20 杆（阈值 30 → 会切图）
  };

  const api = {
    now: () => Date.now(),
    biomes: async () => ({
      biomes: [
        { id: BIOME_HOME, name: "月落溪谷", isCurrent: world.currentBiome === BIOME_HOME },
        { id: "b_012", name: "熔潮环礁", isCurrent: world.currentBiome === "b_012" },
        { id: BIOME_OTHER, name: "极昼冰湾", isCurrent: world.currentBiome === BIOME_OTHER },
        { id: BIOME_PITY, name: "星渊圣海", isCurrent: world.currentBiome === BIOME_PITY },
      ],
    }),
    statistics: async () => ({ pity: { arcane: { hardPityCasts: 1200, currentDryCasts: world.dry } } }),
    biomeTravel: async (id: string) => {
      calls.push(`TRAVEL ${id}`);
      world.currentBiome = id;
      return {};
    },
    // 与助手解耦后这里不该有任何调用：留一个会抛错的桩当绊线
    request: async (path: string) => {
      calls.push(`REQUEST ${path}`);
      throw new Error(`不该调用 ${path}`);
    },
  };

  const ctx = {
    moduleId: "auto-pity",
    config: {
      // 多目标：默认测试只盯奥秘（与旧配置等价）；需要时用 opts.config 加奇异
      rarities: ["arcane"],
      arcaneBiome: BIOME_PITY,
      arcaneThreshold: 30,
      exoticBiome: BIOME_PITY,
      exoticThreshold: 30,
      checkEverySec: 60,
      returnDelaySec: 0,
      pauseAutoTravel: true,
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
    // 账号运行时：只用到「模块实例列表 + 停/重启某模块」（accountId 用于跨模块协作锁）
    account: {
      accountId: ACCOUNT,
      moduleInstances: opts.moduleInstances ?? ["keep-online", "auto-travel"],
      stopModule: async (id: string) => {
        calls.push(`STOP ${id}`);
      },
      restartModule: async (id: string) => {
        calls.push(`RESTART ${id}`);
        return { ok: true, enabled: true };
      },
    },
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
      await autoPity.onStart!(ctx);
      return async () => {
        const t = timers.filter((x) => x.ms === 20_000).at(-1);
        await t?.fn();
      };
    },
  };
}

const count = (calls: string[], needle: string) => calls.filter((c) => c === needle).length;
/** 把某个档位「出货后的缓冲截止时间」拨到过去，等价于等够了 returnDelaySec 秒 */
const passReturnBuffer = (ctx: ModuleContext, rarity: "exotic" | "arcane" = "arcane") => {
  const flows = (ctx.state as { flows?: Record<string, { returnAt?: number }> }).flows;
  if (flows?.[rarity]) flows[rarity].returnAt = Date.now() - 1;
};

describe("保底切图模块", () => {
  beforeEach(() => clearTravelLocks());

  it("★ 快触发保底 → 切进保底地图，出货 → 切回原图", async () => {
    const { calls, log, world, start } = makeCtx();
    const run = await start();

    await run();
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(1);
    expect(world.currentBiome).toBe(BIOME_PITY);
    expect(log.info.some((m) => m.includes("月落溪谷 → 星渊圣海"))).toBe(true);

    world.dry = 0; // 出货：dry 计数被重置
    await run();
    expect(count(calls, `TRAVEL ${BIOME_HOME}`)).toBe(1);
    expect(world.currentBiome).toBe(BIOME_HOME);
    expect(log.info.some((m) => m.includes("🎉"))).toBe(true);
  });

  it("★ 保底地图选择「自动」时选已解锁的最高地图，新地图无需改代码", async () => {
    const { ctx, calls, log, start } = makeCtx({ config: { arcaneBiome: "auto" } });
    (ctx.api as unknown as { biomes: () => Promise<unknown> }).biomes = async () => ({
      currentBiomeId: BIOME_HOME,
      biomes: [
        { id: BIOME_HOME, name: "月落溪谷" },
        { id: BIOME_PITY, name: "星渊圣海" },
        { id: "b_016", name: "新地图" },
      ],
    });
    const run = await start();

    await run();
    expect(count(calls, "TRAVEL b_016")).toBe(1);
    expect(log.info.some((m) => m.includes("自动选择 新地图"))).toBe(true);
  });

  it("★ 完全不碰助手：一次 /api/convenience 都不发（既不读也不写）", async () => {
    const { calls, log, start } = makeCtx();
    const run = await start();

    await run(); // 切图
    await run(); // 再检查一次
    expect(calls.filter((c) => c.includes("convenience"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("REQUEST"))).toEqual([]);
    // 只剩「换图」与「暂停/恢复自动切图」这类模块间协调
    expect(calls.every((c) => c.startsWith("TRAVEL") || c.startsWith("STOP ") || c.startsWith("RESTART "))).toBe(true);
    expect(log.warn).toEqual([]);
  });

  it("★ 中途用户自己切回原图并出货：流程能自己结束，之后还能再切图", async () => {
    const { calls, world, start } = makeCtx();
    const run = await start();

    await run(); // 进保底图，记住原图
    expect(world.currentBiome).toBe(BIOME_PITY);

    // 用户自己切回原图，然后出货 → 决策是 stay，但流程必须结束
    world.currentBiome = BIOME_HOME;
    world.dry = 0;
    await run();
    expect(count(calls, `TRAVEL ${BIOME_HOME}`)).toBe(0); // 没多此一举地切图

    // 再次接近保底 → 应该能重新切进保底图（旧版本会卡死在这里）
    world.dry = 1180;
    await run();
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(2);
  });

  it("不到阈值不切图", async () => {
    const { calls, start } = makeCtx({ config: { arcaneThreshold: 5 } });
    const run = await start();

    await run(); // 还差 20 杆 > 阈值 5
    expect(calls.filter((c) => c.startsWith("TRAVEL"))).toEqual([]);
  });

  it("读不到保底数据时不崩、也不换图", async () => {
    const { ctx, calls, start } = makeCtx();
    (ctx.api as unknown as { statistics: () => Promise<unknown> }).statistics = async () => ({ pity: {} });
    const run = await start();

    await run();
    expect(calls.filter((c) => c.startsWith("TRAVEL"))).toEqual([]);
  });

  it("★ 出货后即使过了缓冲期也照样切回原图（旧版这里永远不切回）", async () => {
    // 用真实默认值 returnDelaySec=5：出货那一轮因为要等缓冲什么都不做，
    // 而下一轮 caught 已经被重算成 false（dry 从 0 涨回去了）→ 旧版切回分支永远进不去。
    const { ctx, calls, world, log, start } = makeCtx({ config: { returnDelaySec: 5 } });
    const run = await start();

    await run(); // 进保底图
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(1);

    world.dry = 0; // 出货
    await run();
    expect(log.info.some((m) => m.includes("🎉"))).toBe(true);
    expect(count(calls, `TRAVEL ${BIOME_HOME}`)).toBe(0); // 还在缓冲期，不该立刻切

    passReturnBuffer(ctx); // 等价于等够了 5 秒
    await run();
    expect(count(calls, `TRAVEL ${BIOME_HOME}`)).toBe(1); // ★ 该切回了
    expect(world.currentBiome).toBe(BIOME_HOME);
  });

  it("★ 进保底图时暂停「自动切图」，出货切回原图后恢复（B1）", async () => {
    const { calls, world, start } = makeCtx();
    const run = await start();

    await run(); // 进保底图 → 让路
    expect(calls).toContain("STOP auto-travel");

    world.dry = 0; // 出货 → 切回原图（returnDelaySec=0）
    await run();
    expect(calls).toContain("RESTART auto-travel");
  });

  it("「自动切图」没开时不去动它", async () => {
    const { calls, start } = makeCtx({ moduleInstances: ["keep-online"] });
    const run = await start();

    await run();
    expect(calls).not.toContain("STOP auto-travel");
  });

  it("把「保底期间暂停自动切图」关掉就不暂停（老行为）", async () => {
    const { calls, start } = makeCtx({ config: { pauseAutoTravel: false } });
    const run = await start();

    await run();
    expect(calls).not.toContain("STOP auto-travel");
  });

  it("★ 被别的东西挪走后抢回保底图一次；再被挪走就不抢了", async () => {
    const { calls, log, world, start } = makeCtx();
    const run = await start();

    await run(); // 进保底图（returnBiome = 原图）
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(1);

    // 例如「自动报名赛事」把你带去比赛图 —— 旧版这里只会"等待出货"，永远不切回
    world.currentBiome = BIOME_OTHER;
    await run();
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(2); // 抢回来
    expect(world.currentBiome).toBe(BIOME_PITY);
    expect(log.info.some((m) => m.includes("被挪走"))).toBe(true);

    // 又被挪走 → 只提示，不再抢（可能你在手动操作）
    world.currentBiome = BIOME_OTHER;
    await run();
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(2);
    expect(log.info.some((m) => m.includes("不再抢"))).toBe(true);
  });

  it("★ 当前条件无保底（hardPityCasts 为 null）→ 用 info 讲清楚，而不是含糊的「接口可能变了」", async () => {
    const { ctx, calls, log, start } = makeCtx();
    (ctx.api as unknown as { statistics: () => Promise<unknown> }).statistics = async () => ({
      pity: { arcane: { hardPityCasts: null, currentDryCasts: 12 } },
    });
    const run = await start();

    await run();
    const line = log.info.find((m) => m.includes("没有硬保底"));
    expect(line).toBeTruthy();
    expect(line).not.toContain("改版");
    expect(calls.filter((c) => c.startsWith("TRAVEL"))).toEqual([]);
  });

  /* ---------- 与「自动报名赛事」的协调：占住换图决策权（报名照常，只让出进图） ---------- */

  it("★ 保底期间占住「换图决策权」，出货切回原图后放开", async () => {
    const { world, start } = makeCtx();
    const run = await start();

    expect(isTravelHeld(ACCOUNT)).toBe(false);
    await run(); // 进保底图
    expect(isTravelHeld(ACCOUNT)).toBe(true);

    world.dry = 0; // 出货 → 切回原图（returnDelaySec=0）
    await run();
    expect(isTravelHeld(ACCOUNT)).toBe(false);
  });

  it("把「暂停报名赛事的进图」关掉就不占锁（让赛事进图自由竞争）", async () => {
    const { start } = makeCtx({ config: { pauseTournamentTravel: false } });
    const run = await start();

    await run();
    expect(isTravelHeld(ACCOUNT)).toBe(false);
  });

  it("★ 模块停止时一定放开锁（否则别的模块永远进不了比赛图）", async () => {
    const { ctx, start } = makeCtx();
    const run = await start();

    await run();
    expect(isTravelHeld(ACCOUNT)).toBe(true);

    await autoPity.onStop!(ctx);
    expect(isTravelHeld(ACCOUNT)).toBe(false);
  });
});

describe("保底切图模块 · 多目标（同时监控奇异 + 奥秘）", () => {
  beforeEach(() => clearTravelLocks());

  const BIOME_EXOTIC = "b_012"; // 假设奇异鱼的保底图
  const both = {
    rarities: ["exotic", "arcane"],
    arcaneBiome: BIOME_PITY,
    arcaneThreshold: 30,
    exoticBiome: BIOME_EXOTIC,
    exoticThreshold: 30,
  };

  /** 同时给出两档进度（世界对象里的 dry 只控制奥秘；奇异用 dryExotic） */
  function makeBoth(opts: { dryExotic?: number; dryArcane?: number; config?: Record<string, unknown> } = {}) {
    const built = makeCtx({ config: { ...both, ...(opts.config ?? {}) } });
    const world = built.world as { dry: number; dryExotic?: number; currentBiome: string };
    world.dry = opts.dryArcane ?? 1200; // 1 → 已在保底（还差 0）
    world.dryExotic = opts.dryExotic ?? 1200;
    (built.ctx.api as unknown as { statistics: () => Promise<unknown> }).statistics = async () => ({
      pity: {
        arcane: { hardPityCasts: 1200, currentDryCasts: world.dry },
        exotic: { hardPityCasts: 500, currentDryCasts: world.dryExotic ?? 0 },
      },
    });
    return built;
  }

  it("★ 谁更接近保底就先守谁（奥秘还差 20 杆、奇异还差 5 杆 → 守奇异）", async () => {
    const { calls, world, start } = makeBoth({ dryArcane: 1180, dryExotic: 495 });
    const run = await start();

    await run();
    expect(count(calls, `TRAVEL ${BIOME_EXOTIC}`)).toBe(1);
    expect(world.currentBiome).toBe(BIOME_EXOTIC);
  });

  it("★ 一样近时优先奥秘", async () => {
    const { calls, start } = makeBoth({ dryArcane: 1180, dryExotic: 480 });
    const run = await start();

    await run();
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(1);
  });

  it("★ 各档位各自记住原图：守完奇异切回后，再守奥秘时记住的是当时所在的图", async () => {
    const { calls, world, start } = makeBoth({ dryArcane: 1180, dryExotic: 495 });
    const run = await start();

    await run(); // 奇异还差 5 杆、奥秘还差 20 杆 → 先守更接近的奇异
    expect(world.currentBiome).toBe(BIOME_EXOTIC);

    // 奇异出货 → 切回原图（月落溪谷）
    world.dryExotic = 0;
    await run();
    expect(count(calls, `TRAVEL ${BIOME_HOME}`)).toBe(1);
    expect(world.currentBiome).toBe(BIOME_HOME);

    // 现在轮到奥秘（还差 20 杆 ≤ 30）→ 切到奥秘的保底图，原图仍是月落溪谷
    await run();
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(1);
    expect(world.currentBiome).toBe(BIOME_PITY);
  });

  it("守着一个时，另一个的进度照常记录（前者出货后能接着守后者）", async () => {
    const { calls, world, start } = makeBoth({ dryArcane: 1180, dryExotic: 100 });
    const run = await start();

    await run(); // 奥秘还差 20 杆先守它；奇异还早（还差 400）
    expect(count(calls, `TRAVEL ${BIOME_PITY}`)).toBe(1);

    // 奇异也进入阈值（还差 5 杆）——但此刻正守着奥秘，不该被抢走
    world.dryExotic = 495;
    await run();
    expect(count(calls, `TRAVEL ${BIOME_EXOTIC}`)).toBe(0);

    // 奥秘出货并切回 → 下一轮才轮到奇异
    world.dry = 0;
    await run();
    expect(count(calls, `TRAVEL ${BIOME_HOME}`)).toBe(1);

    await run();
    expect(count(calls, `TRAVEL ${BIOME_EXOTIC}`)).toBe(1);
  });

  it("只勾选一档时另一档完全不参与", async () => {
    const { calls, world, start } = makeBoth({ dryArcane: 1200, dryExotic: 499, config: { rarities: ["exotic"] } });
    const run = await start();

    await run();
    // 只勾了奇异 → 切到奇异的图；另一档（奥秘）即便已到保底也不管
    expect(calls.filter((c) => c.startsWith("TRAVEL"))).toEqual([`TRAVEL ${BIOME_EXOTIC}`]);
    expect(world.currentBiome).toBe(BIOME_EXOTIC);
  });

  it("一个档位都没勾时不换图，并写清楚原因", async () => {
    const { calls, log, start } = makeBoth({ config: { rarities: [] } });
    const run = await start();

    await run();
    expect(calls.filter((c) => c.startsWith("TRAVEL"))).toEqual([]);
    expect(log.info.some((m) => m.includes("没有勾选"))).toBe(true);
  });
});
