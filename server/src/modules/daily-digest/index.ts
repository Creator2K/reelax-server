// 收益日报：每天在设定时间汇总一份「昨天到底赚了多少」
//
// 数据来源全是游戏自己的统计，不靠我们记账：
//  - fishing/state.dailyHarvest  当天竿数、按稀有度鱼获、装备/宝箱/遗物、神器等级、
//                                金币收入 / 鱼饵消耗 / 净收益
//  - statistics.totals           累计经验（两次日报之间差值 = 当天经验）
//  - */history                   个人赛、公会赛、围猎最近一场
//  - player/reincarnation        等级与距转生还差多少
//
// ★ 架构要点：
//  1) 日报产出的是**结构化事件**（digest），不是「打一条带 emoji 的日志让外部匹配」。
//     旧版靠 /📊/ 匹配日志决定要不要推微信，而日报早已不带 emoji，推送链路静默失效。
//  2) 正文由**用户可编辑的模板**渲染（见 template.ts）。变量清单、示例值、真实渲染
//     共用同一份定义，不会出现「界面上说有这么个变量、实际推不出来」。
//
// 触发方式：每分钟看一次本地时间；跨天时把「刚结束那天」的 dailyHarvest 暂存下来，
// 到设定时间再发 —— 所以日报说的是完整的一天，而不是「今天到 9 点」。
// 进程重启导致基线丢失时，经验一项明确显示「无基线」，不编数字。
import { type ModuleContext, type ModuleDefinition } from "../types.ts";
import { HIGH_RARITIES, RARITY_LABELS } from "../shared/rarity.ts";
import { localDay } from "../shared/format.ts";
import {
  DEFAULT_DIGEST_TEMPLATE,
  type DigestData,
  digestVarsByGroup,
  findUnknownVars,
  fmtInt,
  fmtNum,
  fmtSigned,
  renderDigestTemplate,
} from "./template.ts";

export { DEFAULT_DIGEST_TEMPLATE } from "./template.ts";

type DailyHarvest = {
  date?: string;
  goldIncome?: number;
  baitCost?: number;
  netGold?: number;
  fishByRarity?: Record<string, number>;
  gear?: number;
  chests?: number;
  relics?: number;
  artifactLevels?: number;
};

type DigestState = {
  today: DailyHarvest | null;
  ended: DailyHarvest | null;
  lastReport: string | null;
  prevXpTotal: number | null;
  prevLevel: number | null;
  busy: boolean;
};

const definition: ModuleDefinition = {
  id: "daily-digest",
  name: "收益日报",
  version: "3.0.0",
  description:
    "每天在设定时间把「刚结束的那一天」汇总成一条消息推给你。内容由模板决定：默认给你一份写好常用项的模板，想改哪项就改，变量用 {名字} 插。",
  defaultEnabled: false,
  /**
   * ★ 依赖推送通道：没有任何可用通道时不允许启用/配置。
   * 理由：日报的价值就是「推给你看」，没通道等于只写一条日志，用户会以为坏了。
   */
  requiresNotification: true,
  /** 模板变量清单：前端据此渲染「插入变量」按钮 */
  templateVars: digestVarsByGroup(),
  defaultTemplate: DEFAULT_DIGEST_TEMPLATE,
  defaultConfig: {
    reportAt: "09:00",
    template: DEFAULT_DIGEST_TEMPLATE,
    checkEveryMin: 5,
  },
  configSchema: [
    {
      key: "template",
      type: "template",
      label: "日报模板",
      hint: "下面这份是默认模板。想加内容就点变量按钮插入；某一行里的变量当天没数据（比如没打比赛），整行会自动消失。",
      default: DEFAULT_DIGEST_TEMPLATE,
      rows: 12,
    },
    {
      key: "reportAt",
      type: "string",
      label: "每天几点发日报（本地时间 HH:MM）",
      hint: "默认早上 9:00。日报内容是「刚结束的那一天」，跨天时会自动暂存前一日数据。",
      default: "09:00",
      placeholder: "09:00",
    },
    {
      key: "checkEveryMin",
      type: "number",
      label: "数据采集间隔（分钟）",
      hint: "隔多久抓一次游戏数据用于统计。默认 5 分钟足够。",
      default: 5,
      min: 1,
      max: 60,
      step: 1,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as DigestState;
    S.today = null;
    S.ended = null;
    S.lastReport = null;
    S.prevXpTotal = null;
    S.prevLevel = null;
    S.busy = false;

    // 模板写错了要立刻告诉用户，而不是等第二天早上发现推送内容不对
    const template = String(ctx.config.template ?? DEFAULT_DIGEST_TEMPLATE);
    const unknown = findUnknownVars(template);
    if (unknown.length) {
      ctx.log.warn("收益日报", `模板里有不认识的变量：${unknown.map((v) => `{${v}}`).join("、")}（会原样显示）`);
    }
    if (!template.trim()) {
      ctx.log.warn("收益日报", "模板是空的，日报会没有正文。请填写模板或点「恢复默认」");
    }

    /* ---------- 采集：跨天时把「刚结束那天」留下来 ---------- */
    const poll = async () => {
      try {
        const st = await ctx.api.fishingState();
        const h = st?.dailyHarvest as DailyHarvest | undefined;
        if (!h?.date) return;
        if (S.today && S.today.date !== h.date) {
          // 拿到新日期 → 上一天已完整结束
          S.ended = S.today;
        }
        S.today = h;
      } catch (err) {
        ctx.log.warn("收益日报", `采集当日数据失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const checkEveryMin = Math.max(1, Number(ctx.config.checkEveryMin) || 5);
    ctx.every(checkEveryMin * 60_000, () => poll());
    ctx.schedule(40_000, () => poll());

    /* ---------- 每天到点产出日报 ---------- */
    ctx.every(60_000, async () => {
      if (S.busy) return;
      const now = new Date();
      const [hh, mm] = String(ctx.config.reportAt ?? "09:00")
        .split(":")
        .map((x) => parseInt(x, 10) || 0);
      if (now.getHours() !== hh || now.getMinutes() !== mm) return;

      const stamp = localDay(now);
      if (S.lastReport === stamp) return;
      S.lastReport = stamp;

      S.busy = true;
      try {
        await buildReport(ctx, stamp, S);
      } catch (err) {
        ctx.log.warn("收益日报", `生成失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.busy = false;
      }
    });
  },
};

/** 收集一条日报需要的全部数据 */
async function collectDigestData(ctx: ModuleContext, stamp: string, S: DigestState): Promise<DigestData> {
  const harvest = S.ended ?? S.today!;
  const label = S.ended ? "昨日" : "今日截至现在";

  /* ---------- 经验：优先累计差值；无基线时退化为「引擎本次运行累计」 ---------- */
  const stats = await ctx.api.statistics().catch(() => null);
  const xpTotal = Number(stats?.totals?.fishingExperience);
  let xp: number | null = null;
  let xpText: string;
  if (Number.isFinite(xpTotal) && S.prevXpTotal != null) {
    xp = xpTotal - S.prevXpTotal;
    // ★ 用 fmtSigned 而不是硬编码「经验 +」：转生会重置经验总量，差值为负时
    //   旧写法会渲染成「经验 +-1,234」这种明显坏掉的文本。
    //   同时统一成与日报其它数字一致的格式（template.ts 的 fmtNum，无空格）。
    xpText = `经验 ${fmtSigned(xp)}`;
  } else {
    const sessionXp = ctx.account.runtimeStats().experience;
    if (sessionXp > 0) {
      xp = sessionXp;
      xpText = `经验 ${fmtSigned(sessionXp)}（引擎本次运行累计）`;
    } else {
      xpText = "经验 —（无基线）";
    }
  }
  if (Number.isFinite(xpTotal)) S.prevXpTotal = xpTotal;

  /* ---------- 等级 / 转生 ---------- */
  const re = await ctx.api.reincarnation().catch(() => null);
  const pv = re?.preview;
  let level: number | null = null;
  let levelGain: number | null = null;
  let levelShortfall: number | null = null;
  let goldShortfall: number | null = null;
  if (pv) {
    // ★ 必须挡 NaN：字段缺失时 Number(undefined) = NaN，会渲染成「等级 Lv 0（+NaN）」，
    //   而且 `NaN != null` 为真 → prevLevel 永久变成 NaN，之后每天都算不出升级数。
    const lv = Number(pv.levelBefore);
    if (Number.isFinite(lv)) {
      level = lv;
      levelGain = S.prevLevel != null ? lv - S.prevLevel : null;
      S.prevLevel = lv;
    }
    const ls = Number(pv.levelShortfall);
    const gs = Number(pv.goldShortfall);
    levelShortfall = Number.isFinite(ls) ? ls : null;
    goldShortfall = Number.isFinite(gs) ? gs : null;
  } else {
    const me = await ctx.api.me().catch(() => null);
    const lv = Number(me?.player?.level);
    level = Number.isFinite(lv) && lv > 0 ? lv : null;
  }

  /* ---------- 收支与掉落 ---------- */
  const income = Number(harvest.goldIncome) || 0;
  const baitCost = Number(harvest.baitCost) || 0;
  const net = Number(harvest.netGold) || income - baitCost;

  const rar = harvest.fishByRarity ?? {};
  const at = (k: string) => Number(rar[k]) || 0;
  const fishTotal = Object.values(rar).reduce<number>((a, b) => a + (Number(b) || 0), 0);

  /* ---------- 高稀有度明细 ---------- */
  const rare = HIGH_RARITIES.map((r) => ({ r, n: at(r) })).filter((x) => x.n > 0);
  const rareFish = rare.map((x) => `${RARITY_LABELS[x.r]} ${x.n}`).join(" · ");

  /* ---------- 比赛与围猎 ---------- */
  const [th, gh, wb] = await Promise.all([
    ctx.api.request("/api/tournaments/history").catch(() => null),
    ctx.api.request("/api/guild-tournaments/history").catch(() => null),
    ctx.api.request("/api/events/world-boss/history").catch(() => null),
  ]);
  const t = th?.items?.[0];
  const tournament = t ? `个人赛 #${t.sequence} 第 ${t.rank} 名（${fmtNum(t.score)} 分）` : "";
  const g = gh?.items?.[0];
  const guildTournament = g ? `公会赛 #${g.sequence} 第 ${g.rank} 名（${fmtNum(g.guildScore)} 分）` : "";
  const w = wb?.items?.[0];
  let worldBoss = "";
  if (w) {
    const bits = [`围猎 ${w.boss?.name ?? ""} 伤害 ${fmtNum(w.finalDamage)}`];
    if (w.finalRank) bits.push(`第 ${w.finalRank} 名`);
    if (w.goldReward) bits.push(`奖励 ${fmtNum(w.goldReward)} 金币`);
    if (w.fragmentReward) bits.push(`${w.fragmentReward} 碎片`);
    worldBoss = bits.join(" · ");
  }

  /* ---------- 保底 ---------- */
  const pityOf = (key: "exotic" | "arcane"): number | null => {
    const block = stats?.pity?.[key];
    const total = Number(block?.hardPityCasts);
    if (!Number.isFinite(total) || total <= 0) return null;
    const dry = Number(block?.currentDryCasts) || 0;
    return Math.max(0, total - dry);
  };

  return {
    date: harvest.date ?? stamp,
    label,
    account: ctx.account.label ?? "账号",

    net,
    income,
    baitCost,
    baitPct: income > 0 ? Math.round((baitCost / income) * 100) : null,

    fishTotal,
    fishCommon: at("common"),
    fishUncommon: at("uncommon"),
    fishFine: at("fine"),
    fishRare: at("rare"),
    fishEpic: at("epic"),
    fishLegendary: at("legendary"),
    fishMythic: at("mythic"),
    fishExotic: at("exotic"),
    fishArcane: at("arcane"),
    rareFish,

    gear: Number(harvest.gear) || 0,
    chests: Number(harvest.chests) || 0,
    relics: Number(harvest.relics) || 0,
    artifactLevels: Number(harvest.artifactLevels) || 0,

    xp,
    xpText,
    level,
    levelGain,
    levelShortfall,
    goldShortfall,

    tournament,
    guildTournament,
    worldBoss,

    pityExotic: pityOf("exotic"),
    pityArcane: pityOf("arcane"),
  };
}

async function buildReport(ctx: ModuleContext, stamp: string, S: DigestState): Promise<void> {
  if (!S.today && !S.ended) {
    ctx.log.warn("收益日报", "还没有采集到当日数据（引擎刚启动？）明天会正常");
    return;
  }

  const data = await collectDigestData(ctx, stamp, S);

  const template = String(ctx.config.template ?? "").trim() || DEFAULT_DIGEST_TEMPLATE;
  const lines = renderDigestTemplate(template, data);

  // 写日志（运行日志页可见，历史查询也能翻到）
  ctx.log.info("收益日报", lines.join("\n") || "（模板为空，没有正文）");

  // ★ 抛出结构化事件：消费方（通知推送等）读字段，不做字符串匹配
  ctx.account.emit("digest", {
    date: data.date,
    // label = 期间名（「昨日」/「今日截至现在」）；accountLabel = 账号名。
    // account-runtime.emit 会先塞账号名再被 payload 覆盖，所以推送标题必须读 accountLabel，
    // 否则显示成【昨日】收益日报（账号名丢失）。
    label: data.label,
    accountLabel: data.account,
    lines,
    netGold: data.net,
    income: data.income,
    baitCost: data.baitCost,
    fishTotal: data.fishTotal,
    xpText: data.xpText,
    levelText: data.level == null ? "" : `Lv ${fmtInt(data.level)}`,
  });
}

export default definition;
