// 自动 Buff：模块行为（对着假游戏 API 跑真实 onStart）
//
// 单测只覆盖了「该不该买」的判定，这里覆盖**循环行为**：
// 这是当初真正把功能打坏的地方 —— 第一个商品购买失败时，
// 异常把整个 for 循环带走，后面的商品一个都没试。
import { describe, expect, it } from "vitest";
import type { ModuleContext } from "../src/modules/types.ts";
import autoXpBuff from "../src/modules/auto-xp-buff/index.ts";
import { SHOP_PRODUCTS, type ActiveBuff } from "../src/modules/auto-xp-buff/decide.ts";

const SURGE = { weatherId: "arcane_surge", name: "奥秘涌流" };
const CLEAR = { weatherId: "clear", name: "晴空" };

type FakeOpts = {
  weather?: { weatherId: string; name: string };
  buffs?: ActiveBuff[];
  relics?: number;
  fragments?: number;
  /** 某个商品购买失败时抛错（模拟下架 / 被拒） */
  failProduct?: string;
  config?: Record<string, unknown>;
};

/** 造一个「够用」的 ctx：定时器只收集不执行，由测试手动触发 */
function makeCtx(opts: FakeOpts = {}) {
  const log = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const purchases: string[] = [];
  const scheduled: Array<() => unknown> = [];

  const api = {
    now: () => Date.now(),
    fishingState: async () => ({ activeBuffs: opts.buffs ?? [] }),
    me: async () => ({
      player: { relics: opts.relics ?? 1_000_000, fragments: opts.fragments ?? 1_000_000 },
    }),
    biomes: async () => ({
      biomes: [{ id: "b_009", name: "极昼冰湾", isCurrent: true, weather: opts.weather ?? SURGE }],
    }),
    buyProduct: async (productId: string) => {
      purchases.push(productId);
      if (opts.failProduct === productId) {
        const err = new Error(`SHOP_PRODUCT_NOT_FOUND: ${productId}`);
        throw err;
      }
      return {};
    },
  };

  const ctx = {
    moduleId: "auto-xp-buff",
    config: {
      buyXpRelic: true,
      buyXpFragment: true,
      buyGlobalXp: false,
      buyStrength: false,
      buyLuck: false,
      minRelics: 5000,
      minFragments: 200,
      keepMinutes: 20,
      dailyBudgetRelics: 0,
      dailyBudgetFragments: 0,
      checkEverySec: 300,
      ...(opts.config ?? {}),
    },
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

  /** 跑一次「启动检查」 */
  const once = async () => {
    await autoXpBuff.onStart!(ctx);
    await scheduled[scheduled.length - 1]!();
    return { log, purchases };
  };

  return { ctx, log, purchases, once };
}

describe("自动 Buff 模块循环", () => {
  it("★ 一个商品购买失败不会带走后面的商品（曾经整个模块因此静默失效）", async () => {
    // relic-xp-ii 排在商品表第一位，模拟它被游戏拒绝：
    // 修复前 for 循环会在这里中断，「碎光顿悟」根本不会被尝试。
    const { once } = makeCtx({ failProduct: "relic-xp-ii" });
    const { purchases, log } = await once();

    expect(purchases).toEqual(["relic-xp-ii", "fragment-personal-xp"]);
    expect(log.warn.some((m) => m.includes("购买失败") && m.includes("潮痕研习 II"))).toBe(true);
    expect(log.info.some((m) => m.includes("✅ 已购买 碎光顿悟"))).toBe(true);
  });

  it("涌流期间按商品表逐个购买（默认只买两个经验 Buff）", async () => {
    const { once } = makeCtx();
    const { purchases, log } = await once();

    expect(purchases).toEqual(["relic-xp-ii", "fragment-personal-xp"]);
    // 力量/运气/全服增益默认关闭，不该被买
    expect(purchases).not.toContain("relic-strength-ii");
    expect(purchases).not.toContain("relic-luck-ii");
    expect(purchases).not.toContain("fragment-global-xp");
    expect(log.info.some((m) => m.includes("✅ 已购买 潮痕研习 II"))).toBe(true);
  });

  it("★ 不是奥秘涌流就不买 —— 但要说出来（默认日志级别下 debug 看不到）", async () => {
    const { once } = makeCtx({ weather: CLEAR });
    const { purchases, log } = await once();

    expect(purchases).toEqual([]);
    const line = log.info.find((m) => m.includes("不是奥秘涌流"));
    expect(line).toBeTruthy();
    expect(line).toContain("晴空");
  });

  it("同类增益正生效时不撞（游戏会拒绝这种购买）", async () => {
    const { once } = makeCtx({
      buffs: [
        {
          source: "personal_shop",
          shop: "relic",
          buffType: "experience",
          bonusBasisPoints: 3000, // 「潮痕研习 I」占着位
          status: "active",
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
          displayTag: "潮痕研习 I",
        },
      ],
    });
    const { purchases, log } = await once();

    expect(purchases).toEqual(["fragment-personal-xp"]); // 只买碎片那条
    expect(log.debug.some((m) => m.includes("同类增益生效中"))).toBe(true);
  });

  it("余额低于下限时只提示、不发请求", async () => {
    const { once } = makeCtx({ relics: 0, fragments: 0 });
    const { purchases, log } = await once();

    expect(purchases).toEqual([]);
    expect(log.warn.filter((m) => m.includes("余额不足"))).toHaveLength(2);
  });

  it("开启「万流共鸣」后会买它（全服经验 +50%）", async () => {
    const { once } = makeCtx({ config: { buyGlobalXp: true } });
    const { purchases } = await once();

    expect(purchases).toEqual(["relic-xp-ii", "fragment-personal-xp", "fragment-global-xp"]);
  });

  it("商品表里每个 productId 都对应一个真实开关（避免又写错 id 静默失效）", () => {
    const toggles = SHOP_PRODUCTS.map((p) => p.toggle);
    const config = autoXpBuff.defaultConfig;
    for (const t of toggles) expect(config, t).toHaveProperty(t);
  });
});
