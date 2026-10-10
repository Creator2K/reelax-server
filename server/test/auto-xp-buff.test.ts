// 自动 Buff 的商品表与购买判定
//
// ★ 这里钉住的是**游戏里真实的商品表**（抓前端 bundle 得到的 _k 数组），
//   而不是自造的期望值 —— 商品 id 写错时的表现是「整个模块静默不生效」，
//   界面上完全看不出来，只有测试能拦住。
import { describe, expect, it } from "vitest";
import {
  SHOP_PRODUCTS,
  activePersonalBuffs,
  decidePurchase,
  remainingMsOf,
  type ActiveBuff,
  type ShopProduct,
} from "../src/modules/auto-xp-buff/decide.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const product = (id: string): ShopProduct => {
  const p = SHOP_PRODUCTS.find((x) => x.productId === id);
  if (!p) throw new Error(`商品表里没有 ${id}`);
  return p;
};

/** 造一条「生效中」的个人增益 */
const buff = (over: Partial<ActiveBuff> = {}): ActiveBuff => ({
  source: "personal_shop",
  shop: "relic",
  buffType: "experience",
  bonusBasisPoints: 7500,
  status: "active",
  endsAt: new Date(NOW + HOUR).toISOString(),
  displayTag: "潮痕研习 II",
  ...over,
});

const decide = (over: {
  product: ShopProduct;
  buffs?: ActiveBuff[];
  balance?: number;
  reserve?: number;
  spentToday?: number;
  dailyBudget?: number;
  keepMs?: number;
}) =>
  decidePurchase({
    product: over.product,
    buffs: over.buffs ?? [],
    balance: over.balance ?? 100_000,
    reserve: over.reserve ?? 0,
    spentToday: over.spentToday ?? 0,
    dailyBudget: over.dailyBudget ?? 0,
    keepMs: over.keepMs ?? 20 * 60_000,
    now: NOW,
  });

describe("商品表与游戏一致（曾经把 id 写错导致整个模块没生效）", () => {
  it("★ 「潮痕研习 II」的 id 是 relic-xp-ii —— relic-personal-xp 在游戏里不存在", () => {
    // 这是本项目真实踩过的坑：id 写错 + 它排在商品表第一位，
    // 于是每次检查第一条请求就失败，异常把后面商品的购买一起带走。
    expect(SHOP_PRODUCTS.map((p) => p.productId)).not.toContain("relic-personal-xp");
    expect(product("relic-xp-ii").name).toBe("潮痕研习 II");
  });

  it("★ 商品表与游戏前端 bundle 的 _k 数组逐项对齐", () => {
    // 只列本模块支持的 5 项；字段：名称 / 商店 / 类别 / 万分比 / 时长 / 价格
    const expected: [string, string, string, string, number, number, number][] = [
      ["relic-xp-ii", "潮痕研习 II", "relic", "experience", 7500, 1800, 150],
      ["fragment-personal-xp", "碎光顿悟", "fragment", "experience", 2500, 7200, 20],
      ["fragment-global-xp", "万流共鸣", "fragment", "experience", 5000, 7200, 50],
      ["relic-strength-ii", "渊流臂力 II", "relic", "strength", 2500, 1800, 150],
      ["relic-luck-ii", "星鳞灵感 II", "relic", "luck", 2500, 1800, 150],
    ];
    expect(SHOP_PRODUCTS).toHaveLength(expected.length);
    for (const [id, name, shop, category, bp, dur, price] of expected) {
      const p = product(id);
      expect(p, id).toMatchObject({
        name,
        shop,
        category,
        bonusBasisPoints: bp,
        durationSec: dur,
        price,
      });
    }
  });

  it("每个商品都有对应的配置开关键，且不重复", () => {
    const toggles = SHOP_PRODUCTS.map((p) => p.toggle);
    expect(new Set(toggles).size).toBe(toggles.length);
    for (const t of toggles) expect(t).toMatch(/^buy/);
  });
});

describe("remainingMsOf / activePersonalBuffs", () => {
  it("读不到结束时间按 0 算（等于已经没了）", () => {
    expect(remainingMsOf({ endsAt: null }, NOW)).toBe(0);
    expect(remainingMsOf({ endsAt: "not-a-date" }, NOW)).toBe(0);
    expect(remainingMsOf({ endsAt: new Date(NOW - HOUR).toISOString() }, NOW)).toBe(0);
    expect(remainingMsOf({ endsAt: new Date(NOW + HOUR).toISOString() }, NOW)).toBe(HOUR);
  });

  it("只认「同店 + 同类 + 未过期」的个人增益", () => {
    const list: ActiveBuff[] = [
      buff(),
      buff({ shop: "fragment" }), // 别的商店
      buff({ buffType: "luck" }), // 别的类别
      buff({ source: "player_shop" }), // 不是个人商店
      buff({ status: "expired" }), // 过期
    ];
    expect(activePersonalBuffs(list, "relic", "experience")).toHaveLength(1);
  });
});

describe("decidePurchase", () => {
  it("没有任何同类增益 → 买", () => {
    expect(decide({ product: product("relic-xp-ii") })).toEqual({ action: "buy", remainingMs: 0 });
  });

  it("自己还剩很久 → 不续买", () => {
    const d = decide({ product: product("relic-xp-ii"), buffs: [buff()] }); // 还剩 60 分钟
    expect(d.action).toBe("skip");
    expect("reason" in d && d.reason).toContain("还剩 60 分钟");
  });

  it("自己快到期了 → 续买，并把原剩余时间带出来（日志里要说明）", () => {
    const b = buff({ endsAt: new Date(NOW + 5 * 60_000).toISOString() });
    const d = decide({ product: product("relic-xp-ii"), buffs: [b] });
    expect(d.action).toBe("buy");
    expect("remainingMs" in d && d.remainingMs).toBe(5 * 60_000);
  });

  it("★ 同类别的**别的**商品正生效 → 不买（游戏会拒绝这种购买）", () => {
    // 例如手动买了「潮痕研习 I」，而本模块配的是 II
    const b = buff({ bonusBasisPoints: 3000, displayTag: "潮痕研习 I" });
    const d = decide({ product: product("relic-xp-ii"), buffs: [b] });
    expect(d.action).toBe("skip");
    expect("reason" in d && d.reason).toContain("同类增益生效中");
    expect("reason" in d && d.reason).toContain("潮痕研习 I");
  });

  it("同店但不同类别不冲突（力量 buff 不影响经验 buff）", () => {
    const b = buff({ buffType: "strength", bonusBasisPoints: 2500, displayTag: "渊流臂力 II" });
    expect(decide({ product: product("relic-xp-ii"), buffs: [b] }).action).toBe("buy");
  });

  it("别的商店不冲突（遗物经验 buff 不影响碎片经验 buff）", () => {
    const b = buff({ shop: "fragment", bonusBasisPoints: 2500, displayTag: "碎光顿悟" });
    expect(decide({ product: product("relic-xp-ii"), buffs: [b] }).action).toBe("buy");
  });

  it("过期的同类增益不算数", () => {
    const b = buff({ status: "expired" });
    expect(decide({ product: product("relic-xp-ii"), buffs: [b] }).action).toBe("buy");
  });

  it("余额低于 价格 + 保留额 → 警告（key 稳定，一天只提示一次）", () => {
    const d = decide({ product: product("relic-xp-ii"), balance: 5000, reserve: 5000 });
    expect(d.action).toBe("warn");
    expect("key" in d && d.key).toBe("relic-xp-ii:balance");
    expect("reason" in d && d.reason).toContain("需要 150 + 保留 5000");
  });

  it("余额刚好够（价格 + 保留）→ 买", () => {
    expect(decide({ product: product("relic-xp-ii"), balance: 5150, reserve: 5000 }).action).toBe("buy");
  });

  it("超出每日预算 → 警告", () => {
    const d = decide({
      product: product("relic-xp-ii"),
      spentToday: 1400,
      dailyBudget: 1500,
    });
    expect(d.action).toBe("warn");
    expect("key" in d && d.key).toBe("relic-xp-ii:budget");
  });

  it("预算为 0 表示不限", () => {
    const d = decide({ product: product("relic-xp-ii"), spentToday: 99_999, dailyBudget: 0 });
    expect(d.action).toBe("buy");
  });

  it("★ 同类增益占位优先于余额判断（余额不足时不该报「余额不足」误导排查）", () => {
    const b = buff({ bonusBasisPoints: 3000, displayTag: "潮痕研习 I" });
    const d = decide({ product: product("relic-xp-ii"), buffs: [b], balance: 0, reserve: 5000 });
    expect(d.action).toBe("skip");
  });
});
