// 收益日报：每天在设定时间汇总一份「昨天到底赚了多少」
//
// 数据来源全是游戏自己的统计，不靠我们记账：
//  - fishing/state.dailyHarvest  当天竿数、按稀有度鱼获、装备/宝箱/遗物、神器等级、
//                                金币收入 / 鱼饵消耗 / 净收益
//  - statistics.totals           累计经验（两次日报之间差值 = 当天经验）
//  - */history                   个人赛、公会赛、围猎最近一场
//  - player/reincarnation        等级与距转生还差多少
//
// ★ 架构改进（相对旧版）：日报产出的是**结构化事件**，而不是
//   「打一条带特定 emoji 的日志让外部按字符串匹配」。
//   旧版靠 /📊/ 匹配日志决定要不要推微信，而日报早已不带 emoji，推送链路静默失效。
//   类型化事件从根上消除了这类失败。
//
// 触发方式：每分钟看一次本地时间；跨天时把「刚结束那天」的 dailyHarvest 暂存下来，
// 到设定时间再发 —— 所以日报说的是完整的一天，而不是「今天到 9 点」。
// 进程重启导致基线丢失时，经验一项明确显示「无基线」，不编数字。
import { type ModuleContext, type ModuleDefinition } from "../types.ts";
import { RARITIES, RARITY_LABELS, HIGH_RARITIES } from "../shared/rarity.ts";
import { fmtNum, fmtSigned, localDay } from "../shared/format.ts";
import { applyDigestVars, defaultDigestSections, digestSectionOptions, normalizeDigestSections } from "./sections.ts";

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
  version: "2.0.0",
  description:
    "每天在设定时间汇总一份日报：净收益（收入 − 鱼饵消耗）、经验增量与等级、按稀有度鱼获、装备/宝箱/遗物掉落、比赛名次、围猎伤害与奖励，以及距转生还差多少。",
  defaultEnabled: false,
  /**
   * ★ 依赖推送通道：没有任何可用通道时不允许启用/配置。
   * 理由：日报的价值就是「推给你看」，没通道等于只写一条日志，用户会以为坏了。
   * 约束在模块清单（带 unavailable 原因）与 AccountService.updateModule 两处强制。
   */
  requiresNotification: true,
  defaultConfig: {
    reportAt: "09:00",
    sections: defaultDigestSections(),
    title: "",
    footer: "",
    checkEveryMin: 5,
  },
  configSchema: [
    {
      key: "reportAt",
      type: "string",
      label: "每天几点发日报（本地时间 HH:MM）",
      hint: "默认早上 9:00。日报内容是「刚结束的那一天」，跨天时会自动暂存前一日数据。",
      default: "09:00",
      placeholder: "09:00",
    },
    {
      key: "sections",
      type: "multi-select",
      label: "日报里要包含哪些内容",
      hint: "勾选你关心的项。顺序固定（按这里的排列），不必手动调整。",
      default: defaultDigestSections(),
      options: digestSectionOptions(),
    },
    {
      key: "title",
      type: "string",
      label: "日报标题（可选）",
      hint: "留空用默认标题。支持变量：{date} 日期、{label} 昨日/今日、{account} 账号名。",
      default: "",
      placeholder: "例如：{account} {date} 战报",
    },
    {
      key: "footer",
      type: "string",
      label: "结尾附言（可选）",
      hint: "加在日报最后一行。支持同样变量：{date} {label} {account} {net} 净收益。",
      default: "",
      placeholder: "例如：今天也辛苦了，净收益 {net}",
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

async function buildReport(ctx: ModuleContext, stamp: string, S: DigestState): Promise<void> {
  const harvest = S.ended ?? S.today;
  if (!harvest) {
    ctx.log.warn("收益日报", "还没有采集到当日数据（引擎刚启动？）明天会正常");
    return;
  }
  const label = S.ended ? "昨日" : "今日截至现在";

  /* ---------- 经验：优先累计差值；无基线时退化为「引擎本次运行累计」 ---------- */
  const stats = await ctx.api.statistics().catch(() => null);
  const xpTotal = Number(stats?.totals?.fishingExperience);
  let xpText: string;
  if (Number.isFinite(xpTotal) && S.prevXpTotal != null) {
    xpText = `经验 +${fmtNum(xpTotal - S.prevXpTotal)}`;
  } else {
    const sessionXp = ctx.account.runtimeStats().experience;
    xpText = sessionXp > 0 ? `经验 +${fmtNum(sessionXp)}（引擎本次运行累计）` : "经验 —（无基线）";
  }
  if (Number.isFinite(xpTotal)) S.prevXpTotal = xpTotal;

  /* ---------- 等级 / 转生 ---------- */
  const re = await ctx.api.reincarnation().catch(() => null);
  const pv = re?.preview;
  let levelText = "";
  if (pv) {
    const lv = Number(pv.levelBefore);
    const gained = S.prevLevel != null ? lv - S.prevLevel : 0;
    S.prevLevel = lv;
    levelText =
      `Lv ${fmtNum(lv)}${gained > 0 ? `（+${fmtNum(gained)}）` : ""}` +
      `，距转生还差 ${pv.levelShortfall > 0 ? `${fmtNum(pv.levelShortfall)} 级` : "0 级"}` +
      `${pv.goldShortfall > 0 ? ` / ${fmtNum(pv.goldShortfall)} 金币` : ""}`;
  } else {
    const me = await ctx.api.me().catch(() => null);
    if (me?.player?.level) levelText = `Lv ${fmtNum(me.player.level)}`;
  }

  /* ---------- 收支与掉落 ---------- */
  const income = Number(harvest.goldIncome) || 0;
  const bait = Number(harvest.baitCost) || 0;
  const net = Number(harvest.netGold) || income - bait;
  const fishTotal = Object.values(harvest.fishByRarity ?? {}).reduce<number>((a, b) => a + (Number(b) || 0), 0);

  /* ---------- 用户选中的分区（默认用模块默认值） ---------- */
  const chosen = normalizeDigestSections(ctx.config.sections);
  const on = (id: (typeof chosen)[number]) => chosen.includes(id);

  const lines: string[] = [];

  if (on("income")) {
    lines.push(
      `净收益 ${fmtSigned(net)}（收入 ${fmtNum(income)} − 鱼饵 ${fmtNum(bait)}${
        income > 0 ? `，鱼饵占 ${Math.round((bait / income) * 100)}%` : ""
      }）`,
    );
  }
  if (on("experience")) lines.push(xpText);
  if (on("level") && levelText) lines.push(`等级 ${levelText}`);
  if (on("fish")) lines.push(`鱼获 ${fmtNum(fishTotal)} 条`);

  // 高稀有度单独一行（这是最有价值的产出；9 档全列会显得很乱）
  if (on("rareFish")) {
    const rare = HIGH_RARITIES.map((r) => ({ r, n: Number(harvest.fishByRarity?.[r]) || 0 })).filter((x) => x.n > 0);
    if (rare.length) {
      lines.push(`高稀有度 ${rare.map((x) => `${RARITY_LABELS[x.r]} ${x.n}`).join(" · ")}`);
    }
  }

  if (on("drops")) {
    lines.push(
      `掉落 装备 ${harvest.gear ?? 0} · 宝箱 ${harvest.chests ?? 0} · 遗物 ${harvest.relics ?? 0} · 神器 +${
        harvest.artifactLevels ?? 0
      }`,
    );
  }

  if (on("allRarities")) {
    const all = RARITIES.map((r) => ({ r, n: Number(harvest.fishByRarity?.[r]) || 0 })).filter((x) => x.n > 0);
    if (all.length) lines.push(`全部稀有度 ${all.map((x) => `${RARITY_LABELS[x.r]} ${x.n}`).join(" / ")}`);
  }

  /* ---------- 比赛与围猎 ---------- */
  if (on("competitions")) {
    const [th, gh, wb] = await Promise.all([
      ctx.api.request("/api/tournaments/history").catch(() => null),
      ctx.api.request("/api/guild-tournaments/history").catch(() => null),
      ctx.api.request("/api/events/world-boss/history").catch(() => null),
    ]);

    const t = th?.items?.[0];
    if (t) lines.push(`个人赛 #${t.sequence} 第 ${t.rank} 名（${fmtNum(t.score)} 分）`);
    const g = gh?.items?.[0];
    if (g) lines.push(`公会赛 #${g.sequence} 第 ${g.rank} 名（${fmtNum(g.guildScore)} 分）`);
    const w = wb?.items?.[0];
    if (w) {
      const bits = [`围猎 ${w.boss?.name ?? ""} 伤害 ${fmtNum(w.finalDamage)}`];
      if (w.finalRank) bits.push(`第 ${w.finalRank} 名`);
      if (w.goldReward) bits.push(`奖励 ${fmtNum(w.goldReward)} 金币`);
      if (w.fragmentReward) bits.push(`${w.fragmentReward} 碎片`);
      lines.push(bits.join(" · "));
    }
  }

  /* ---------- 保底进度 ---------- */
  if (on("pity")) {
    const pity = stats?.pity;
    const bits: string[] = [];
    for (const [key, name] of [
      ["exotic", "奇异鱼"],
      ["arcane", "奥秘鱼"],
    ] as const) {
      const block = pity?.[key];
      const total = Number(block?.hardPityCasts);
      if (!Number.isFinite(total) || total <= 0) continue;
      const dry = Number(block?.currentDryCasts) || 0;
      bits.push(`${name} 还差 ${Math.max(0, total - dry)} 杆`);
    }
    if (bits.length) lines.push(`保底进度 ${bits.join(" · ")}`);
  }

  /* ---------- 自定义标题与结尾（支持变量） ---------- */
  const accountName = ctx.account.label ?? "账号";
  const vars = {
    date: harvest.date ?? stamp,
    label,
    account: accountName,
    net: fmtSigned(net),
    fish: fmtNum(fishTotal),
    xp: xpText,
  };
  const titleTpl = String(ctx.config.title ?? "").trim();
  const footerTpl = String(ctx.config.footer ?? "").trim();

  const head = titleTpl ? applyDigestVars(titleTpl, vars) : `${label} · ${vars.date}`;
  const body = [head, ...lines];
  if (footerTpl) body.push(applyDigestVars(footerTpl, vars));

  // 写日志（运行日志页可见，历史查询也能翻到）
  ctx.log.info("收益日报", body.join("\n"));

  // ★ 抛出结构化事件：消费方（通知推送等）读字段，不做字符串匹配
  ctx.account.emit("digest", {
    date: vars.date,
    label,
    lines: body,
    netGold: net,
    income,
    baitCost: bait,
    fishTotal,
    xpText,
    levelText,
  });
}

/** 日报变量：把这些占位符替换成实际值 */
export type DigestVars = {
  date: string;
  label: string;
  account: string;
  net: string;
  fish: string;
  xp: string;
};

export default definition;
