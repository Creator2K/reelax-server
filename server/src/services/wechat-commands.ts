// 微信机器人命令处理（服务端版）
//
// 从桌面端 desktop/src/wechat-commands.js 移植，差异：
//  - 依赖改为服务端对象（Repos / RunnerRegistry / AccountService），不再走本机 HTTP
//  - 数据来源是「当前用户自己的账号」，天然做了多用户隔离
//
// 设计原则（沿用桌面端）：**任何一块数据取不到都只跳过那一块**，
// 绝不让一条命令整体失败 —— 微信那头看到的应是「缺一项」，而不是「命令报错」。
import type { Repos } from "../db/repositories/index.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { AccountService } from "../services/account-service.ts";
import { RARITY_LABELS } from "../modules/shared/rarity.ts";

export const HELP_TEXT = [
  " Reelax 助手 · 可用命令",
  "",
  "日报 / 收益 / 今日 —— 今日净收益、鱼获、掉落、比赛与围猎",
  "状态 / 在线 —— 每个账号在不在线、在哪个图、等级、鱼饵、功能数",
  "经验 —— 经验加成明细 + 距转生还差多少（含按当前速率的天数）",
  "资源 / 预算 —— 遗物/碎片余额、自动Buff 每天消耗、还能撑几天",
  "地图 —— 当前地图与公会经验增益落在哪张图",
  "保底 —— 奇异 / 奥秘鱼的硬保底还要多少杆",
  "比赛 / 赛事 —— 最近个人赛与公会赛名次、即将开赛",
  "围猎 / boss —— 最近一次围猎：伤害、名次、奖励",
  "鱼 / 鱼获 / 图鉴 —— 今日鱼获分布与累计图鉴进度",
  "日志 —— 最近的关键事件与告警",
  "帮助 / 菜单 —— 这条",
].join("\n");

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

const fmt = (v: unknown): string => {
  const n = num(v);
  const a = Math.abs(n);
  const trim = (s: string) => s.replace(/\.0$/, "");
  if (a >= 1e8) return `${trim((n / 1e8).toFixed(2))} 亿`;
  if (a >= 1e4) return `${trim((n / 1e4).toFixed(1))} 万`;
  return String(Math.round(n));
};
const signed = (v: unknown): string => (num(v) >= 0 ? `+${fmt(v)}` : `-${fmt(Math.abs(num(v)))}`);
const pct = (bp: unknown): string => `${(num(bp) / 100).toFixed(num(bp) % 100 === 0 ? 0 : 1)}%`;
const clock = (ts: number): string => new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

/** 触发词 → 处理器 id（同一个命令允许多种说法） */
const ALIASES: [string[], string][] = [
  [["帮助", "菜单", "命令", "?", "？", "help", "h"], "help"],
  [["日报", "收益", "今日", "净收益", "report"], "digest"],
  [["状态", "在线", "status", "s"], "status"],
  [["经验", "等级", "升级", "xp"], "xp"],
  [["资源", "预算", "遗物", "碎片", "buff"], "resources"],
  [["地图", "图", "切图", "biome"], "biome"],
  [["保底", "保底进度", "pity"], "pity"],
  [["比赛", "赛事", "赛", "tournament"], "tournament"],
  [["围猎", "boss", "渊潮"], "boss"],
  [["鱼获", "鱼", "图鉴", "统计", "fish"], "fish"],
  [["日志", "log", "事件"], "logs"],
];

/**
 * 解析命令；返回 null 表示「不认识」。
 *
 * 注意：拉丁短别名（s / h / ?）必须整串相等才认，否则 "Boss打完了吗" 会因为包含 s
 * 被误判成「状态」；中文两字别名（状态 / 地图）是完整词，可以 includes。
 */
export function parseCommand(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/^[/!！]\s*/, "");
  for (const [words, handler] of ALIASES) {
    for (const w of words) {
      const asciiShort = w.length <= 2 && /^[a-z?!0-9]+$/i.test(w);
      if (asciiShort) {
        if (lower === w) return handler;
        continue;
      }
      if (lower === w || lower.startsWith(w) || lower.includes(w)) return handler;
    }
  }
  return null;
}

/** 命令处理器依赖 */
export type CommandDeps = {
  repos: Repos;
  registry: RunnerRegistry;
  accounts: AccountService;
};

/**
 * 执行命令。
 * @param deps 服务端依赖
 * @param userId 发起命令的用户（微信已绑定的那个人）
 * @param text 用户发来的文本
 */
export async function runCommand(deps: CommandDeps, userId: string, text: string): Promise<string | null> {
  const handler = parseCommand(text);
  if (!handler) return null;

  const views = deps.accounts.listForUser(userId);
  if (handler === "help") return HELP_TEXT;
  if (!views.length) return "还没有添加游戏账号，先在控制台里添加一个吧。";

  /** 需要直接请求游戏接口时，用该账号的运行时客户端 */
  const stateOf = async (accountId: string, path: string): Promise<any> => {
    const rt = deps.registry.get(accountId);
    if (!rt) return null;
    try {
      return await rt.client.request(path);
    } catch {
      return null;
    }
  };

  switch (handler) {
    case "digest":
      return digestText(deps.repos, views, stateOf);
    case "status":
      return statusText(views);
    case "xp":
      return xpText(views);
    case "resources":
      return resourcesText(views);
    case "biome":
      return biomeText(views);
    case "pity":
      return pityText(views, stateOf);
    case "tournament":
      return tournamentText(views, stateOf);
    case "boss":
      return bossText(views, stateOf);
    case "fish":
      return fishText(views, stateOf);
    case "logs":
      return logsText(deps.repos, userId);
    default:
      return HELP_TEXT;
  }
}

const head = (s: any): string => `【${s.label || "账号"}】`;

/** 从账号视图里取展示面板（AccountView.statusPanel） */
const panelOf = (s: any): any => s.statusPanel ?? {};

/* ---------- 日报 ---------- */

async function digestText(
  repos: Repos,
  sessions: any[],
  stateOf: (id: string, path: string) => Promise<any>,
): Promise<string> {
  // 优先用真实生成的日报（与每天推送的那条完全一致），没有再按今日渔获现算
  try {
    const userId = sessions[0]?.userId;
    if (userId) {
      const rows = repos.logs.query(userId, { limit: 400, search: "" });
      const digestRows = rows.filter((r) => /收益日报/.test(String(r.tag ?? ""))).slice(-sessions.length);
      if (digestRows.length) return digestRows.map((r) => r.msg).join("\n\n");
    }
  } catch {
    /* 读不到就现算 */
  }

  const parts: string[] = [];
  for (const s of sessions) {
    const h = (await stateOf(s.id, "/api/fishing/state"))?.dailyHarvest ?? null;
    if (!h) {
      parts.push(`${head(s)}今日数据还没采集到`);
      continue;
    }
    const fish = Object.values(h.fishByRarity ?? {}).reduce<number>((a, b) => a + num(b), 0);
    const rare = ["legendary", "mythic", "exotic", "arcane"]
      .map((r) => [r, num((h.fishByRarity ?? {})[r])] as const)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => `${RARITY_LABELS[r as never]} ${n}`)
      .join(" · ");
    parts.push(
      [
        `${head(s)} ${h.date ?? "今日"}`,
        ` 净收益 ${signed(h.netGold)}（收入 ${fmt(h.goldIncome)} − 鱼饵 ${fmt(h.baitCost)}）`,
        ` 鱼获 ${fmt(fish)} 条 ｜  装备 ${h.gear ?? 0} · 宝箱 ${h.chests ?? 0} · 遗物 ${h.relics ?? 0}`,
        rare ? ` ${rare}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return parts.join("\n\n");
}

/* ---------- 状态 ---------- */

function statusText(sessions: any[]): string {
  const lines = sessions.map((s) => {
    const p = panelOf(s);
    const running = Object.values(s.modules ?? {}).filter((x: any) => x?.running).length;
    const total = Object.keys(s.modules ?? {}).length;
    const state = s.status === "online" ? "在线" : s.status === "stopped" ? "已停止" : s.status;
    const bits = [
      `${head(s)}${state}${s.status !== "online" && s.lastError ? `（${s.lastError}）` : ""}`,
      ` ${p.biomeName ?? "未知地图"}${p.valueMultiplier ? ` ×${num(p.valueMultiplier).toFixed(2)}` : ""} ｜  ${p.baitName ?? "-"}`,
      ` 功能 ${running}/${total}${p.level ? ` ｜ Lv ${fmt(p.level)}` : ""}${p.xpTotal ? ` ｜ 经验 ≈${num(p.xpTotal).toFixed(2)}×` : ""}`,
    ];
    if (s.onlinePlayerCount) bits.push(` 游戏在线 ${fmt(s.onlinePlayerCount)} 人`);
    if (s.stats?.castsResolved) bits.push(` 累计结算 ${fmt(s.stats.castsResolved)} 杆 ｜ 金币 ${signed(s.stats.gold)}`);
    return bits.join("\n");
  });
  return [" 账号状态", "", ...lines].join("\n");
}

/* ---------- 经验 / 转生 ---------- */

function xpText(sessions: any[]): string {
  const blocks = sessions.map((s) => {
    const p = panelOf(s);
    if (!p.level) return `${head(s)}暂时没有等级数据`;
    const detail = [
      p.masteryBp ? `专精+${pct(p.masteryBp)}` : "",
      p.talentBp ? `天赋+${pct(p.talentBp)}` : "",
      p.artifactBp ? `神器+${pct(p.artifactBp)}` : "",
      p.guildBp ? `公会+${pct(p.guildBp)}` : "",
      p.guildBiomeBoostBp ? `本图公会+${pct(p.guildBiomeBoostBp)}` : "",
      p.buffXpBp ? `Buff+${pct(p.buffXpBp)}` : "",
      p.weatherXpPct ? `${p.weatherName ?? "天气"}+${p.weatherXpPct}%` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const re = p.reincarnation ?? {};
    const rate = ratePerHour(s);
    const target = num(re.requiredLevel) || 15000;
    const need = cumulativeXp(target) - cumulativeXp(num(p.level));
    const days = rate > 0 ? Math.ceil(need / (rate * 24)) : 0;
    return [
      `${head(s)}Lv ${p.level}${
        p.experienceToNextLevel
          ? `（${Math.round((num(p.experience) / num(p.experienceToNextLevel)) * 100)}%）`
          : ""
      }`,
      ` 经验 ≈${num(p.xpTotal).toFixed(2)}× ｜ ${detail || "无明细"}`,
      p.buffs?.length ? ` ${p.buffs.map((b: any) => `${b.tag}+${pct(b.bp)}`).join("、")}` : "",
      ` 转生：还差 ${target - num(p.level)} 级` +
        (num(re.goldShortfall) > 0 ? ` / ${fmt(re.goldShortfall)} 金币` : "（金币已够）") +
        (re.awardedPoints ? ` ｜ 现可拿 ${re.awardedPoints} 天赋点` : "") +
        (days ? ` ｜ 按当前速率约 ${days} 天` : ""),
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [" 经验与转生", "", ...blocks].join("\n");
}

/** 累计经验曲线（≈ 11.33 × L^2.5616，用真实账号数据校准过） */
function cumulativeXp(level: number): number {
  return 11.33 * Math.pow(num(level) || 1, 2.5616);
}

/** 用本次会话累计经验 / 运行时长估算每小时经验 */
function ratePerHour(s: any): number {
  const st = s.stats ?? {};
  if (!st.startedAt || !st.experience) return 0;
  const hours = (Date.now() - st.startedAt) / 3_600_000;
  return hours > 0.2 ? st.experience / hours : 0;
}

/* ---------- 资源预算 ---------- */

/** 自动Buff 的商品与**默认开关**（undefined 表示没配过，要按默认值算，否则消耗会被高估） */
const BUFF_PRODUCTS = [
  { key: "buyXpRelic", currency: "relics", price: 150, seconds: 1800, defaultOn: true },
  { key: "buyXpFragment", currency: "fragments", price: 20, seconds: 7200, defaultOn: true },
  { key: "buyStrength", currency: "relics", price: 150, seconds: 1800, defaultOn: false },
  { key: "buyLuck", currency: "relics", price: 150, seconds: 1800, defaultOn: false },
] as const;

function resourcesText(sessions: any[]): string {
  const blocks = sessions.map((s) => {
    const p = panelOf(s);
    const mod = (s.modules ?? {})["auto-xp-buff"];
    const burn = { relics: 0, fragments: 0 };
    if (mod?.enabled) {
      for (const prod of BUFF_PRODUCTS) {
        const on = mod.config?.[prod.key] ?? prod.defaultOn;
        if (!on) continue;
        burn[prod.currency] += (prod.price * 86400) / prod.seconds;
      }
    }
    const days = (bal: unknown, daily: number) => (daily > 0 ? Math.floor(num(bal) / daily) : null);
    const dRelic = days(p.relics, burn.relics);
    const dFrag = days(p.fragments, burn.fragments);
    return [
      `${head(s)} 遗物 ${fmt(p.relics)}${
        burn.relics ? `（自动Buff 上限 -${fmt(burn.relics)}/天${dRelic != null ? `  约 ${dRelic} 天` : ""}）` : ""
      }`,
      ` 碎片 ${fmt(p.fragments)}${burn.fragments ? `（-${fmt(burn.fragments)}/天${dFrag != null ? `  约 ${dFrag} 天` : ""}）` : ""}`,
      ` 金币 ${fmt(p.gold)}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [" 资源与预算", "", ...blocks].join("\n");
}

/* ---------- 地图 ---------- */

function biomeText(sessions: any[]): string {
  const blocks = sessions.map((s) => {
    const p = panelOf(s);
    const boosts = (p.guildBoosts ?? []).map((g: any) => {
      const left = g.endsAt ? Math.max(0, Math.round((Date.parse(g.endsAt) - Date.now()) / 60000)) : null;
      return `${g.name} +${pct(g.bp)}${left != null ? `（剩 ${left} 分）` : ""}`;
    });
    return [
      `${head(s)} ${p.biomeName ?? "未知"}${p.valueMultiplier ? ` ×${num(p.valueMultiplier).toFixed(2)}` : ""} ｜  ${p.baitName ?? "-"}`,
      p.fleet
        ? ` 船队 ${p.fleet.boatName ?? ""} 在 ${p.fleet.boatBiomeName ?? p.fleet.boatBiomeId ?? "?"}${
            p.fleet.sameAsCurrent ? "（与你一致）" : "（与你不同图）"
          }`
        : "",
      boosts.length ? ` 公会经验增益落点：${boosts.join(" / ")}` : " 当前没有公会经验增益",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [" 地图现状", "", ...blocks].join("\n");
}

/* ---------- 保底进度（新增） ---------- */

async function pityText(sessions: any[], stateOf: (id: string, path: string) => Promise<any>): Promise<string> {
  const blocks: string[] = [];
  for (const s of sessions) {
    const stats = await stateOf(s.id, "/api/statistics").catch(() => null);
    const pity = stats?.pity ?? null;
    if (!pity) {
      blocks.push(`${head(s)}暂时没有保底数据`);
      continue;
    }
    const line = (key: "exotic" | "arcane") => {
      const p = pity[key] ?? {};
      const total = num(p.hardPityCasts);
      const dry = num(p.currentDryCasts);
      if (!total) return null;
      const remain = Math.max(0, total - dry);
      const pctDone = total > 0 ? Math.round((dry / total) * 100) : 0;
      return `${RARITY_LABELS[key]} 已 ${dry}/${total} 杆（${pctDone}%），还差 ${remain} 杆`;
    };
    const bits = [line("exotic"), line("arcane")].filter(Boolean);
    blocks.push(
      [
        `${head(s)} 保底进度`,
        ...bits.map((b) => ` ${b}`),
        pity.effectiveLuck != null ? ` 有效幸运 ${fmt(pity.effectiveLuck)}（TIER ${pity.luckTier ?? "?"}）` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return [" 稀有鱼保底", "", ...blocks].join("\n");
}

/* ---------- 比赛 / 围猎 ---------- */

async function tournamentText(sessions: any[], stateOf: (id: string, path: string) => Promise<any>): Promise<string> {
  const blocks: string[] = [];
  for (const s of sessions) {
    const [personal, guild] = await Promise.all([
      stateOf(s.id, "/api/tournaments/overview").catch(() => null),
      stateOf(s.id, "/api/guild-tournaments/overview").catch(() => null),
    ]);
    const lines = [`${head(s)}`];
    const cur = personal?.current;
    if (cur) {
      lines.push(
        ` 个人赛 #${cur.sequence} ${cur.status === "active" ? "进行中" : cur.status}${
          cur.isRegistered ? "（已报名）" : "（未报名）"
        }`,
      );
    }
    const up = (personal?.upcoming ?? [])[0];
    if (up) {
      const at = up.startAt
        ? new Date(up.startAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : "?";
      lines.push(`   下一场 #${up.sequence} ${at} 开赛${up.isRegistered ? "（已报名）" : up.canRegister ? "（可报名）" : ""}`);
    }
    const gcur = guild?.current;
    if (gcur) {
      lines.push(` 公会赛 #${gcur.sequence} ${gcur.status === "active" ? "进行中" : gcur.status}${gcur.entryStatus ? "（公会已报名）" : ""}`);
    }
    if (lines.length === 1) lines.push("暂时没有比赛信息");
    blocks.push(lines.join("\n"));
  }
  return [" 比赛", "", ...blocks].join("\n");
}

async function bossText(sessions: any[], stateOf: (id: string, path: string) => Promise<any>): Promise<string> {
  const blocks: string[] = [];
  for (const s of sessions) {
    const h = await stateOf(s.id, "/api/events/world-boss/history").catch(() => null);
    const w = h?.items?.[0];
    if (!w) {
      blocks.push(`${head(s)}还没有围猎记录`);
      continue;
    }
    const bits = [
      `${head(s)} ${w.boss?.name ?? "围猎"}${w.boss?.epithet ? `（${w.boss.epithet}）` : ""}`,
      `状态 ${w.status} ｜ 伤害 ${fmt(w.finalDamage)}${w.finalRank ? ` ｜ 第 ${w.finalRank} 名` : ""}${
        w.participantCount ? ` / ${w.participantCount} 人` : ""
      }`,
      w.goldReward || w.fragmentReward
        ? `奖励 ${fmt(w.goldReward)} 金币${w.fragmentReward ? ` + ${w.fragmentReward} 碎片` : ""}`
        : "",
      w.collectibleDrop ? `收藏品：${w.collectibleDrop.name}` : "",
    ];
    blocks.push(bits.filter(Boolean).join("\n"));
  }
  return [" 渊潮围猎", "", ...blocks].join("\n");
}

/* ---------- 鱼获 / 图鉴 ---------- */

async function fishText(sessions: any[], stateOf: (id: string, path: string) => Promise<any>): Promise<string> {
  const blocks: string[] = [];
  for (const s of sessions) {
    const [stats, state] = await Promise.all([
      stateOf(s.id, "/api/statistics").catch(() => null),
      stateOf(s.id, "/api/fishing/state").catch(() => null),
    ]);
    const h = state?.dailyHarvest;
    const today = h
      ? Object.entries(h.fishByRarity ?? {})
          .filter(([, n]) => num(n) > 0)
          .map(([r, n]) => `${RARITY_LABELS[r as never] ?? r} ${n}`)
          .join(" / ")
      : "";
    const totals = stats?.totals;
    blocks.push(
      [
        `${head(s)} 今日 ${h ? `${fmt(Object.values(h.fishByRarity ?? {}).reduce<number>((a, b) => a + num(b), 0))} 条` : "暂无"}`,
        today ? `   ${today}` : "",
        totals
          ? ` 累计 ${fmt(totals.totalFishCaught)} 条 ｜ 图鉴 ${num(totals.fishpediaPercentage).toFixed(1)}%（${totals.discoveredFish}/${totals.totalFishDefinitions}）`
          : "",
        stats?.pity ? ` 有效幸运 ${fmt(stats.pity.effectiveLuck)}（TIER ${stats.pity.luckTier}）` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return [" 鱼获与图鉴", "", ...blocks].join("\n");
}

/* ---------- 日志 ---------- */

function logsText(repos: Repos, userId: string): string {
  try {
    const rows = repos.logs.query(userId, { limit: 200, minLevel: "info" });
    const list = rows.filter((e) => !/^\s*(结算|同步|暂无|已在用)/.test(String(e.msg ?? "")));
    const pick = list.slice(-12);
    if (!pick.length) return "最近没有值得提醒的日志。";
    return [" 最近日志", "", ...pick.map((e) => `${clock(Number(e.created_at))} [${e.tag ?? e.module_id ?? "?"}] ${String(e.msg).slice(0, 120)}`)].join(
      "\n",
    );
  } catch (err) {
    return `读日志失败：${err instanceof Error ? err.message : String(err)}`;
  }
}
