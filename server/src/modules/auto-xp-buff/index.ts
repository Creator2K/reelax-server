// 自动 Buff：续买商店的经验 / 属性增益
//
// 协议：
//  - GET  /api/biomes            → 当前地图的 weather.weatherId，判断是否「奥秘涌流」
//  - GET  /api/fishing/state     → activeBuffs 里查该增益是否还在、剩余多久
//  - GET  /api/me                → player.relics / player.fragments 余额
//  - POST /api/shop/purchases    { productId, quantity }（幂等）
//
// ★ 只在「奥秘涌流」期间续买（固定行为，不是开关）：
//   两个经验 Buff 一天就要 7200 遗物，而遗物收入通常只有几百/天，常开几天就见底；
//   涌流期间经验 ×1.75 且遗物权重 ×1.5，把 Buff 集中在这里最划算。
//
// 三重保险：余额下限（minRelics / minFragments）、每日预算（0 = 不限）、
// 「剩余时间 > keepMinutes 就不补」避免无脑叠加。
//
// ★ 踩过的坑（都有回归测试，见 test/auto-xp-buff.test.ts）：
//  1) 「潮痕研习 II」的 productId 曾写成 `relic-personal-xp`，而游戏里没有这个商品。
//     它排在商品表第一位，于是每次检查的第一条购买请求必然失败，异常把 for 循环
//     一起带走 —— 后面的「碎光顿悟」等商品全被跳过，表现为「自动 Buff 完全没生效」。
//  2) 单个商品失败不该影响其他商品：现在逐个 try/catch，失败只记一条日志。
//  3) 同类增益生效中（例如手动买了「潮痕研习 I」）时购买会被游戏拒绝，
//     现在本地就能判出来，不必每分钟撞一次失败。
//  4) 「不是涌流所以没买」原先只写 debug 日志（默认 LOG_LEVEL=info，用户看不到），
//     看起来就像功能坏了。现在按天气变化各记一条 info。
import { type ModuleDefinition } from "../types.ts";
import { localDay } from "../shared/format.ts";
import {
  SHOP_LABEL,
  SHOP_PRODUCTS,
  decidePurchase,
  type ActiveBuff,
  type Shop,
  type ShopProduct,
} from "./decide.ts";

const ARCANE_SURGE = "arcane_surge";

const definition: ModuleDefinition = {
  id: "auto-xp-buff",
  name: "自动 Buff",
  version: "2.1.0",
  description:
    "在「奥秘涌流」天气期间自动续买商店增益。官方航线助手的经验 Buff 自动化只买「潮痕研习 I/II」与「碎光顿悟」，所以「渊流臂力 II」「星鳞灵感 II」（以及全服增益「万流共鸣」）是这里独有的。受余额下限与每日预算约束。",
  defaultEnabled: false,
  defaultConfig: {
    buyXpRelic: true,
    buyXpFragment: true,
    buyGlobalXp: false,
    buyStrength: true,
    buyLuck: true,
    minRelics: 5000,
    minFragments: 200,
    keepMinutes: 20,
    dailyBudgetRelics: 0,
    dailyBudgetFragments: 0,
    checkEverySec: 300,
  },
  configSchema: [
    {
      key: "buyXpRelic",
      type: "boolean",
      label: "续买「潮痕研习 II」（个人经验 +75%）",
      hint: "150 遗物 / 30 分钟。这是遗物商店里经验收益最高的一档。",
      default: true,
    },
    {
      key: "buyXpFragment",
      type: "boolean",
      label: "续买「碎光顿悟」（个人经验 +25%）",
      hint: "20 碎片 / 2 小时",
      default: true,
    },
    {
      key: "buyGlobalXp",
      type: "boolean",
      label: "续买「万流共鸣」（全服经验 +50%）",
      hint: "50 碎片 / 2 小时。全服共享、按购买顺序生效，碎片够再开。",
      default: false,
    },
    {
      key: "buyStrength",
      type: "boolean",
      label: "续买「渊流臂力 II」（有效力量 +25%）",
      hint: "150 遗物 / 30 分钟（影响每杆鱼数量上限）。官方助手不管这个，只有本功能会买。",
      default: true,
    },
    {
      key: "buyLuck",
      type: "boolean",
      label: "续买「星鳞灵感 II」（有效运气 +25%）",
      hint: "150 遗物 / 30 分钟（影响稀有度）。官方助手不管这个，只有本功能会买。",
      default: true,
    },
    {
      key: "minRelics",
      type: "number",
      label: "遗物余额下限",
      hint:
        "余额低于该值就不再花遗物买 Buff —— 这是开销的硬底。" +
        "开着上面三个遗物 Buff 时，一小时最多要花约 2700 遗物，请按自己的收入设。",
      default: 5000,
      min: 0,
      max: 1_000_000,
      step: 100,
    },
    {
      key: "minFragments",
      type: "number",
      label: "碎片余额下限",
      default: 200,
      min: 0,
      max: 1_000_000,
      step: 10,
    },
    {
      key: "keepMinutes",
      type: "number",
      label: "剩余时间多于多少分钟就不补",
      hint: "Buff 剩余时间少于这个值才续买。设为 0 表示没生效就买。",
      default: 20,
      min: 0,
      max: 240,
      step: 5,
    },
    {
      key: "dailyBudgetRelics",
      type: "number",
      label: "每日遗物预算上限",
      hint: "0 = 不限。超出后当天不再花遗物。",
      default: 0,
      min: 0,
      max: 100_000_000,
      step: 1000,
    },
    {
      key: "dailyBudgetFragments",
      type: "number",
      label: "每日碎片预算上限",
      hint: "0 = 不限",
      default: 0,
      min: 0,
      max: 10_000_000,
      step: 100,
    },
    {
      key: "checkEverySec",
      type: "number",
      label: "检查间隔（秒）",
      default: 300,
      min: 60,
      max: 3600,
      step: 60,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      busy: boolean;
      lastIdle: string;
      /** 上次见到的天气 id：天气没变就不重复刷「不是涌流」的提示 */
      lastWeather: string | null;
      budgetDate: string;
      spent: Record<Shop, number>;
      warned: Set<string>;
    };
    S.busy = false;
    S.lastIdle = "";
    S.lastWeather = null;
    S.budgetDate = "";
    S.spent = { relic: 0, fragment: 0 };
    S.warned = new Set();

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("自动Buff", msg);
    };
    const warnOnce = (key: string, msg: string) => {
      if (S.warned.has(key)) return;
      S.warned.add(key);
      ctx.log.warn("自动Buff", msg);
    };

    const check = async (trigger: string) => {
      if (S.busy) return;
      S.busy = true;
      try {
        /* ---------- 只在奥秘涌流期间续买 ---------- */
        const [state, me, biomeData] = await Promise.all([
          ctx.api.fishingState(),
          ctx.api.me(),
          ctx.api.biomes(),
        ]);

        const list: any[] = biomeData?.biomes ?? [];
        const current = list.find((b) => b?.isCurrent) ?? null;
        // 原始响应里天气 id 在 weather.weatherId（模拟器与状态面板同样写法，个别版本只给 id）
        const weatherId: string | null =
          current?.weather?.weatherId ?? current?.weather?.id ?? list[0]?.weather?.weatherId ?? null;

        // ★ 不是涌流时不买 —— 但要说出来。
        //   这里刻意用 info：默认 LOG_LEVEL=info，debug 用户根本看不到，
        //   于是「什么都没发生」看起来就像功能坏了（这正是当初被当成 bug 的地方）。
        //   同一种天气只提示一次，天气变了才再记一条，不会刷屏。
        if (weatherId !== ARCANE_SURGE) {
          if (S.lastWeather !== weatherId) {
            S.lastWeather = weatherId;
            ctx.log.info(
              "自动Buff",
              `${trigger}：当前天气「${current?.weather?.name ?? weatherId ?? "未知"}」不是奥秘涌流，暂不续买`,
            );
          }
          return;
        }
        S.lastWeather = weatherId;

        const buffs = (state?.activeBuffs ?? []) as ActiveBuff[];
        const balance: Record<Shop, number> = {
          relic: Number(me?.player?.relics) || 0,
          fragment: Number(me?.player?.fragments) || 0,
        };
        const keepMs = Math.max(0, Number(ctx.config.keepMinutes) || 0) * 60_000;
        const now = ctx.api.now();

        /* ---------- 每日预算（进程内累计，重启重新计数） ---------- */
        const today = localDay();
        if (S.budgetDate !== today) {
          S.budgetDate = today;
          S.spent = { relic: 0, fragment: 0 };
          S.warned.clear();
        }

        const bought: ShopProduct[] = [];
        const failed: string[] = [];

        for (const p of SHOP_PRODUCTS) {
          if (ctx.config[p.toggle] === false) continue;

          const budgetKey = p.shop === "relic" ? "dailyBudgetRelics" : "dailyBudgetFragments";
          const reserveKey = p.shop === "relic" ? "minRelics" : "minFragments";

          const decision = decidePurchase({
            product: p,
            buffs,
            balance: balance[p.shop],
            reserve: Math.max(0, Number(ctx.config[reserveKey]) || 0),
            spentToday: S.spent[p.shop] ?? 0,
            dailyBudget: Math.max(0, Number(ctx.config[budgetKey]) || 0),
            keepMs,
            now,
          });

          if (decision.action === "skip") {
            idle(decision.reason);
            continue;
          }
          if (decision.action === "warn") {
            warnOnce(decision.key, decision.reason);
            continue;
          }

          // ★ 逐个商品 try/catch：一个商品被拒（下架 / 改版 / 同类增益占位）
          //   不能把后面的商品一起带走 —— 那正是「整个模块没生效」的成因。
          try {
            await ctx.api.buyProduct(p.productId, 1);
          } catch (err) {
            failed.push(`${p.name}：${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          balance[p.shop] -= p.price;
          S.spent[p.shop] = (S.spent[p.shop] ?? 0) + p.price;
          bought.push(p);

          const before =
            decision.remainingMs > 0
              ? `原剩余 ${Math.max(0, Math.round(decision.remainingMs / 60_000))} 分钟，续期顺延`
              : "此前未生效";
          ctx.log.info(
            "自动Buff",
            `✅ 已购买 ${p.name}（${p.effect}）：${p.price} ${SHOP_LABEL[p.shop]}，` +
              `${Math.round(p.durationSec / 60)} 分钟（${before}；` +
              `余额 ${balance[p.shop]}，今日已花 ${S.spent[p.shop]}）`,
          );
        }

        if (failed.length) ctx.log.warn("自动Buff", `购买失败：${failed.join("；")}`);

        /* ---------- 汇总当前增益，让用户看得见 ---------- */
        // 刚买到的商品会顶掉同店同类的旧增益，汇总时先去掉旧的，避免重复计算
        const boughtKeys = new Set(bought.map((p) => `${p.shop}:${p.category}`));
        const effective: ActiveBuff[] = buffs
          .filter(
            (b) =>
              b?.status !== "expired" &&
              !(b.source === "personal_shop" && boughtKeys.has(`${b.shop}:${b.buffType}`)),
          )
          .concat(
            bought.map((p) => ({
              source: "personal_shop",
              shop: p.shop,
              buffType: p.category,
              bonusBasisPoints: p.bonusBasisPoints,
              displayTag: p.name,
            })),
          );

        const xpBuffs = effective.filter((b) => b.buffType === "experience");
        const xpTotal = xpBuffs.reduce((a, b) => a + (Number(b.bonusBasisPoints) || 0), 0);
        const xpTags = xpBuffs.map((b) => String(b.displayTag ?? "增益"));
        const statTags = effective
          .filter((b) => b.buffType !== "experience")
          .map((b) => String(b.displayTag ?? "增益"));

        if (bought.length) {
          S.lastIdle = "";
          idle(
            `Buff 已更新：经验加成 +${(xpTotal / 100).toFixed(0)}%（${xpTags.join("、") || "无"}）` +
              (statTags.length ? `；属性增益 ${statTags.join("、")}` : ""),
          );
        } else {
          idle(
            `${trigger}：无需续买（当前经验加成 +${(xpTotal / 100).toFixed(0)}%` +
              `${xpTags.length ? `，${xpTags.join("、")}` : ""}）`,
          );
        }
      } catch (err) {
        ctx.log.warn("自动Buff", `${trigger} 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.busy = false;
      }
    };

    ctx.every(Math.max(60, Number(ctx.config.checkEverySec) || 300) * 1000, () => check("定时检查"));

    // 天气切换（涌流开始/结束）要尽快跟上，节流 2 分钟
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < 120_000) return;
      lastSync = now;
      void check("钓鱼同步");
    });

    ctx.schedule(12_000, () => check("启动检查"));
  },
};

export default definition;
