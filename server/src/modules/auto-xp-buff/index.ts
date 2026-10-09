// 自动 Buff：续买商店的经验 / 属性增益
//
// 协议：
//  - GET  /api/biomes            → 判断当前天气是否为「奥秘涌流」
//  - GET  /api/fishing/state     → activeBuffs 里查该增益是否还在、剩余多久
//  - GET  /api/me                → player.relics / player.fragments 余额
//  - POST /api/shop/purchases    { productId, quantity }（幂等）
//
// ★ 只在「奥秘涌流」期间续买（不再是开关，而是固定行为）：
//   两个经验 Buff 一天就要 7200 遗物，而遗物收入通常只有几百/天，常开几天就见底；
//   涌流期间经验 ×1.75 且提高遗物权重，把 Buff 集中在这里最划算。
//
// 三重保险：余额下限（minRelics / minFragments）、每日预算（0 = 不限）、
// 「剩余时间 > keepMinutes 就不补」避免无脑叠加。
import { type ModuleDefinition } from "../types.ts";

type Currency = "relics" | "fragments";

type Product = {
  productId: string;
  name: string;
  effect: string;
  buffType: string;
  bonusBasisPoints: number;
  durationSec: number;
  currency: Currency;
  price: number;
  /** 对应的配置开关键 */
  toggle: string;
};

/** 商品表（productId 与游戏内商店一致，勿改） */
const PRODUCTS: Product[] = [
  {
    productId: "relic-personal-xp",
    name: "潮痕研习 II",
    effect: "个人经验 +75%",
    buffType: "experience",
    bonusBasisPoints: 7500,
    durationSec: 1800,
    currency: "relics",
    price: 150,
    toggle: "buyXpRelic",
  },
  {
    productId: "fragment-personal-xp",
    name: "碎光顿悟",
    effect: "个人经验 +25%",
    buffType: "experience",
    bonusBasisPoints: 2500,
    durationSec: 7200,
    currency: "fragments",
    price: 20,
    toggle: "buyXpFragment",
  },
  {
    productId: "relic-strength-ii",
    name: "渊流臂力 II",
    effect: "有效力量 +25%",
    buffType: "strength",
    bonusBasisPoints: 2500,
    durationSec: 1800,
    currency: "relics",
    price: 150,
    toggle: "buyStrength",
  },
  {
    productId: "relic-luck-ii",
    name: "星鳞灵感 II",
    effect: "有效运气 +25%",
    buffType: "luck",
    bonusBasisPoints: 2500,
    durationSec: 1800,
    currency: "relics",
    price: 150,
    toggle: "buyLuck",
  },
];

const CURRENCY_LABEL: Record<Currency, string> = { relics: "遗物", fragments: "碎片" };
const ARCANE_SURGE = "arcane_surge";

const definition: ModuleDefinition = {
  id: "auto-xp-buff",
  name: "自动 Buff",
  version: "2.0.0",
  description:
    "在「奥秘涌流」天气期间自动续买商店增益（潮痕研习 II / 碎光顿悟 / 渊流臂力 II / 星鳞灵感 II）。涌流时经验 ×1.75 且遗物权重更高，把 Buff 集中在这里性价比最好。受余额下限与每日预算约束。",
  defaultEnabled: false,
  defaultConfig: {
    buyXpRelic: true,
    buyXpFragment: true,
    buyStrength: false,
    buyLuck: false,
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
      label: "续买「潮痕研习 II」",
      hint: "150 遗物 / 个人经验 +75% / 30 分钟",
      default: true,
    },
    {
      key: "buyXpFragment",
      type: "boolean",
      label: "续买「碎光顿悟」",
      hint: "20 碎片 / 个人经验 +25% / 2 小时",
      default: true,
    },
    {
      key: "buyStrength",
      type: "boolean",
      label: "续买「渊流臂力 II」",
      hint: "150 遗物 / 有效力量 +25% / 30 分钟（影响每杆鱼数量上限）",
      default: false,
    },
    {
      key: "buyLuck",
      type: "boolean",
      label: "续买「星鳞灵感 II」",
      hint: "150 遗物 / 有效运气 +25% / 30 分钟（影响稀有度）",
      default: false,
    },
    {
      key: "minRelics",
      type: "number",
      label: "遗物余额下限",
      hint: "余额低于该值就不再花遗物买 Buff",
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
      hint: "避免刚买完又买一遍；设为 0 表示只要没生效就买",
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
      budgetDate: string;
      spent: Record<Currency, number>;
      warned: Set<string>;
    };
    S.busy = false;
    S.lastIdle = "";
    S.budgetDate = "";
    S.spent = { relics: 0, fragments: 0 };
    S.warned = new Set();

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.info("自动Buff", msg);
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
        const current = list.find((b) => b.isCurrent);
        const weatherId = current?.weather?.weatherId ?? list[0]?.weather?.weatherId ?? null;
        if (weatherId !== ARCANE_SURGE) {
          idle(`${trigger}：当前天气「${current?.weather?.name ?? weatherId ?? "未知"}」不是奥秘涌流，暂不续买`);
          return;
        }

        const buffs: any[] = (state?.activeBuffs ?? []).filter((b: any) => b && b.status !== "expired");
        const balance: Record<Currency, number> = {
          relics: Number(me?.player?.relics) || 0,
          fragments: Number(me?.player?.fragments) || 0,
        };
        const keepMs = Math.max(0, Number(ctx.config.keepMinutes) || 0) * 60_000;

        /* ---------- 每日预算（进程内累计，重启重新计数） ---------- */
        const today = new Date().toISOString().slice(0, 10);
        if (S.budgetDate !== today) {
          S.budgetDate = today;
          S.spent = { relics: 0, fragments: 0 };
          S.warned.clear();
        }

        const bought: Product[] = [];

        for (const p of PRODUCTS) {
          if (ctx.config[p.toggle] === false) continue;

          // 已经挂着同来源、同类型、同数值的增益
          const active = buffs.find(
            (b: any) =>
              b.source === "personal_shop" &&
              b.buffType === p.buffType &&
              Number(b.bonusBasisPoints) === p.bonusBasisPoints,
          );
          const remainMs = active?.endsAt ? Date.parse(String(active.endsAt)) - Date.now() : 0;
          if (active && remainMs > keepMs) continue;

          // 每日预算
          const budgetKey = p.currency === "relics" ? "dailyBudgetRelics" : "dailyBudgetFragments";
          const budget = Math.max(0, Number(ctx.config[budgetKey]) || 0);
          if (budget > 0 && (S.spent[p.currency] ?? 0) + p.price > budget) {
            warnOnce(
              `${p.productId}:budget`,
              `${p.name} 已超出今日预算（${S.spent[p.currency]}/${budget} ${CURRENCY_LABEL[p.currency]}），明天再续买`,
            );
            continue;
          }

          // 余额下限
          const reserveKey = p.currency === "relics" ? "minRelics" : "minFragments";
          const reserve = Math.max(0, Number(ctx.config[reserveKey]) || 0);
          if (balance[p.currency] < p.price + reserve) {
            warnOnce(
              `${p.productId}:balance`,
              `${p.name} 余额不足，跳过：需要 ${p.price} + 保留 ${reserve} = ${p.price + reserve}，` +
                `现有 ${balance[p.currency]} ${CURRENCY_LABEL[p.currency]}`,
            );
            continue;
          }

          await ctx.api.buyProduct(p.productId, 1);
          balance[p.currency] -= p.price;
          S.spent[p.currency] = (S.spent[p.currency] ?? 0) + p.price;
          bought.push(p);

          const before = active ? `原剩余 ${Math.max(0, Math.round(remainMs / 60_000))} 分钟` : "此前未生效";
          ctx.log.info(
            "自动Buff",
            `✅ 已购买 ${p.name}（${p.effect}）：${p.price} ${CURRENCY_LABEL[p.currency]}，` +
              `${Math.round(p.durationSec / 60)} 分钟（${before}，从结束时间顺延；` +
              `余额 ${balance[p.currency]}，今日已花 ${S.spent[p.currency]}）`,
          );
        }

        /* ---------- 汇总当前增益，让用户看得见 ---------- */
        const activeXp = buffs.filter((b: any) => b.buffType === "experience");
        const xpTotal =
          activeXp.reduce((a: number, b: any) => a + (Number(b.bonusBasisPoints) || 0), 0) +
          bought.filter((p) => p.buffType === "experience").reduce((a, p) => a + p.bonusBasisPoints, 0);

        if (bought.length) {
          S.lastIdle = "";
          const tagText = activeXp
            .map((b: any) => b.displayTag)
            .concat(bought.filter((p) => p.buffType === "experience").map((p) => p.name))
            .join("、");
          const statBuffs = buffs
            .filter((b: any) => b.source === "personal_shop" && (b.buffType === "strength" || b.buffType === "luck"))
            .map((b: any) => b.displayTag)
            .concat(bought.filter((p) => p.buffType !== "experience").map((p) => p.name));
          idle(
            `Buff 已更新：经验加成 +${(xpTotal / 100).toFixed(0)}%（${tagText || "无"}）` +
              (statBuffs.length ? `；属性增益 ${statBuffs.join("、")}` : ""),
          );
        } else {
          const xpTags = activeXp.map((b: any) => b.displayTag).join("、");
          idle(`${trigger}：无需续买（当前经验加成 +${(xpTotal / 100).toFixed(0)}%${xpTags ? `，${xpTags}` : ""}）`);
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
