// 自动切图：在所有已解锁地图里按优先级挑最合适的一张
//
// 协议：
//  - GET /api/biomes → { biomes: [{ id, name, isUnlocked, isCurrent, valueMultiplier,
//                                  masteryXpBonusBasisPoints, guildXpBonusBasisPoints,
//                                  guildBoostEndsAt, weather: { weatherId, effect, name },
//                                  activeCompetitions }] }
//  - GET /api/tournaments/overview 与 /api/guild-tournaments/overview：比赛场次（进图依据）
//  - PUT /api/player/current-biome { biomeId }   手动换图（免费）
//
// ★ 选图口径（这是修正过一版的重点）：
//     经验权重 = (1 + 专精经验 + 公会经验) × (1 + 天气经验%)
//     鱼价值   = valueMultiplier
//   旧版「经验优先」实际只看 鱼价值×天气，完全没算专精与公会经验加成，
//   于是出现「明明选了经验优先却不切过去」的问题。
//
//   ★ 不管哪个模式，「有比赛就去比赛地图」永远最高优先 ——
//     否则会把刚送进比赛图的号又拽走。
//
//   迟滞：目标收益需高出当前地图 minImprovePct 才切；每次切换有冷却，防止来回横跳。
//
// 与官方航线助手：**完全不看它**（不读它的开关、不接管、不提示）。
// 本项目自己负责换图；助手是跑在游戏页面里的循环，挂机时它本来就不动 ——
// 你只要在游戏里把它关掉即可（功能本项目全包了）。
import { type ModuleDefinition } from "../types.ts";
import { parsePercentFromText } from "../keep-online/xp-multiplier.ts";

const GOLDWIND_WEATHER_ID = "gilded_current";

type Mode = "experience" | "gold" | "balanced" | "competition" | "goldwind";
const MODES: Mode[] = ["experience", "gold", "balanced", "competition", "goldwind"];

const MODE_LABEL: Record<Mode, string> = {
  experience: "经验",
  gold: "鱼价值",
  balanced: "综合收益",
  competition: "比赛",
  goldwind: "金风",
};

/** 该地图的「经验权重」：专精经验 + 公会经验（万分比）再乘天气经验 */
export function xpWeight(biome: any): number {
  const mastery = Number(biome?.masteryXpBonusBasisPoints) || 0;
  const guild = Number(biome?.guildXpBonusBasisPoints) || 0;
  // 地图列表只给天气文本，没有结构化倍率 → 这里用文本里的百分比
  const weather = parsePercentFromText(biome?.weather?.effect);
  return (1 + mastery / 10_000 + guild / 10_000) * (1 + weather / 100);
}

/** 该地图的「鱼价值」倍率 */
export function valueWeight(biome: any): number {
  return Number(biome?.valueMultiplier) || 1;
}

/** 按模式返回主指标（用于迟滞比较） */
export function primaryScore(mode: Mode, biome: any): number {
  const xp = xpWeight(biome);
  const val = valueWeight(biome);
  if (mode === "experience" || mode === "competition" || mode === "goldwind") return xp;
  if (mode === "gold") return val;
  return val * xp; // balanced
}

/** 按模式挑最优（返回 best，排除当前地图） */
export function pickBest(mode: Mode, unlocked: any[], currentId: string): any | null {
  let cmp: (a: any, b: any) => number;
  if (mode === "gold") {
    cmp = (a, b) => valueWeight(b) - valueWeight(a) || xpWeight(b) - xpWeight(a);
  } else if (mode === "balanced") {
    cmp = (a, b) => valueWeight(b) * xpWeight(b) - valueWeight(a) * xpWeight(a) || xpWeight(b) - xpWeight(a);
  } else {
    // experience / competition / goldwind 的兜底都是「经验优先」
    cmp = (a, b) => xpWeight(b) - xpWeight(a) || valueWeight(b) - valueWeight(a);
  }

  let best: any = null;
  for (const b of unlocked) {
    if (b.id === currentId) continue;
    if (!best || cmp(b, best) < 0) best = b;
  }
  return best;
}

/** 把一张地图的加成说清楚，方便在日志里核对 */
export function describeBiome(b: any): string {
  const parts = [`鱼价值×${valueWeight(b).toFixed(2)}`];
  const xp = xpWeight(b);
  const mastery = (Number(b?.masteryXpBonusBasisPoints) || 0) / 100;
  const guild = (Number(b?.guildXpBonusBasisPoints) || 0) / 100;
  const weather = parsePercentFromText(b?.weather?.effect);
  const detail = [
    mastery ? `专精+${mastery}%` : "",
    guild ? `公会+${guild}%` : "",
    weather ? `天气+${weather}%` : "",
  ].filter(Boolean);
  parts.push(`经验×${xp.toFixed(2)}${detail.length ? `（${detail.join("，")}）` : ""}`);
  return `${b?.name ?? b?.id} ${parts.join(" ")}`;
}

const definition: ModuleDefinition = {
  id: "auto-travel",
  name: "自动切图",
  version: "2.0.0",
  description:
    "在已解锁的地图里自动挑最划算的一直待着。可选经验优先、鱼价值优先或兼顾；有比赛时先去比赛地图。",
  defaultEnabled: false,
  defaultConfig: {
    mode: "experience",
    fleetMode: "solo",
    checkEverySec: 120,
    minImprovePct: 3,
    travelCooldownSec: 600,
    competitionLeadSec: 180,
  },
  configSchema: [
    {
      key: "mode",
      type: "select",
      label: "优先模式",
      hint: "经验优先 = 综合「专精经验 + 公会经验增益 + 天气经验」挑最高的地图；兼顾 = 鱼价值 × 经验权重",
      default: "experience",
      options: [
        { value: "experience", label: "经验优先（专精 + 公会 + 天气）" },
        { value: "balanced", label: "兼顾（鱼价值 × 经验）" },
        { value: "gold", label: "鱼价值优先" },
        { value: "competition", label: "比赛优先" },
        { value: "goldwind", label: "金风优先" },
      ],
    },
    {
      key: "fleetMode",
      type: "select",
      label: "与船队的关系",
      hint: "跟船队走 = 完全不自己换图，船队开到哪你就在哪；自己切图 = 按上面的模式自行换图（船队自己开走时游戏仍会把你带走）",
      default: "solo",
      options: [
        { value: "solo", label: "自己切图（默认）" },
        { value: "follow", label: "跟船队走（自己不换图）" },
      ],
    },
    {
      key: "checkEverySec",
      type: "number",
      label: "检查间隔（秒）",
      default: 120,
      min: 60,
      max: 1800,
      step: 30,
    },
    {
      key: "minImprovePct",
      type: "number",
      label: "切换迟滞（%）",
      hint: "目标地图收益需比当前地图高出该百分比才切换，防止频繁横跳（比赛 / 金风命中时不适用）",
      default: 3,
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: "travelCooldownSec",
      type: "number",
      label: "换图冷却（秒）",
      default: 600,
      min: 120,
      max: 3600,
      step: 60,
    },
    {
      key: "competitionLeadSec",
      type: "number",
      label: "比赛提前多少秒进图",
      default: 180,
      min: 30,
      max: 1800,
      step: 30,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      busy: boolean;
      lastTravelAt: number;
      lastIdle: string;
    };
    S.busy = false;
    S.lastTravelAt = 0;
    S.lastIdle = "";

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      // 「本轮没动作」的说明：降到 debug。信息级日志会落库并占用每用户 2 万条的额度，
      // 这类每轮都变（带数量）的说明会把额度几小时就冲掉，让真正的事件无处留存。
      ctx.log.debug("自动切图", msg);
    };

    /** 比赛地图：个人赛要已报名，公会赛要公会已报名 */
    const competitionTarget = async (now: number): Promise<{ biomeId: string; why: string } | null> => {
      const leadMs = Math.max(30, Number(ctx.config.competitionLeadSec) || 180) * 1000;
      const [personal, guild] = await Promise.all([
        ctx.api.tournamentsOverview().catch(() => null),
        ctx.api.guildTournamentsOverview().catch(() => null),
      ]);

      const soon = (t: any, key: string) => {
        if (!t?.[key] || t.status !== "scheduled" || !t.startAt) return false;
        return Date.parse(String(t.startAt)) - now <= leadMs;
      };

      const cur = personal?.current;
      if (cur?.isRegistered) {
        return { biomeId: cur.assignedBiomeId ?? cur.biomeId, why: `个人赛 #${cur.sequence} 进行中` };
      }
      for (const t of personal?.upcoming ?? []) {
        if (t?.isRegistered && soon(t, "isRegistered")) {
          return { biomeId: t.assignedBiomeId ?? t.biomeId, why: `个人赛 #${t.sequence} 即将开赛` };
        }
      }
      const gcur = guild?.current;
      if (gcur?.entryStatus) {
        return { biomeId: gcur.assignedBiomeId ?? gcur.biomeId, why: `公会赛 #${gcur.sequence} 进行中` };
      }
      for (const t of guild?.upcoming ?? []) {
        if (soon(t, "entryStatus")) {
          return { biomeId: t.assignedBiomeId ?? t.biomeId, why: `公会赛 #${t.sequence} 即将开赛` };
        }
      }
      return null;
    };

    const doTravel = async (biome: any, reason: string) => {
      S.lastTravelAt = Date.now();
      try {
        const r = await ctx.api.biomeTravel(biome.id);
        const cur = r?.player?.currentBiomeId;
        if (cur && cur !== biome.id) {
          ctx.log.warn("自动切图", `前往 ${biome.name ?? biome.id} 未生效（当前 ${cur}），稍后重试`);
          return;
        }
        ctx.log.info("自动切图", `⛵ ${reason} → ${biome.name ?? biome.id}`);
      } catch (err) {
        ctx.log.warn("自动切图", `前往 ${biome.name ?? biome.id} 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const decide = async (trigger: string) => {
      const mode: Mode = MODES.includes(String(ctx.config.mode) as Mode)
        ? (ctx.config.mode as Mode)
        : "experience";

      const data = await ctx.api.biomes();
      const biomes: any[] = (data?.biomes ?? []).filter(Boolean);
      const current = biomes.find((b) => b.isCurrent);
      const unlocked = biomes.filter((b) => b.isUnlocked !== false);
      if (!current || !unlocked.length) {
        idle("地图数据尚未就绪");
        return;
      }

      const now = Date.now();

      /* ---------- 0. 「跟船队走」：完全不自己换图 ---------- */
      if (ctx.config.fleetMode === "follow") {
        const party = (await ctx.api.fishingState().catch(() => null))?.party;
        if (party?.isInParty) {
          const boat = unlocked.find((b) => b.id === party.boatBiomeId);
          const same = party.boatBiomeId === current.id;
          idle(
            `跟随船队：${party.boatName ?? "船队"} 在 ${boat?.name ?? party.boatBiomeId ?? "未知"}` +
              (same ? "（与你当前所在一致）" : `（你当前在 ${current.name}，船队开动后会把你带走）`) +
              "，本模块不自行换图",
          );
        } else {
          idle("未加入船队，但配置为「跟船队走」，因此不换图");
        }
        return;
      }

      /* ---------- 1. 比赛永远最高优先 ---------- */
      const comp = await competitionTarget(now);
      if (comp) {
        if (comp.biomeId && comp.biomeId !== current.id) {
          const target = unlocked.find((b) => b.id === comp.biomeId) ?? { id: comp.biomeId, name: comp.biomeId };
          await doTravel(target, comp.why);
        }
        return;
      }

      /* ---------- 2. 金风优先模式下，有金风天气就去那儿 ---------- */
      if (mode === "goldwind") {
        const goldwind = unlocked.find((b) => b.weather?.weatherId === GOLDWIND_WEATHER_ID);
        if (goldwind && goldwind.id !== current.id) {
          await doTravel(goldwind, "金风天气（每杆直接金币区间 +300~500）");
          return;
        }
      }

      /* ---------- 3. 按模式挑最优 ---------- */
      const best = pickBest(mode, unlocked, current.id);
      if (!best) {
        idle(`${trigger}：没有其他已解锁地图`);
        return;
      }

      const curScore = primaryScore(mode, current);
      const bestScore = primaryScore(mode, best);
      const improve = curScore > 0 ? bestScore / curScore - 1 : 1;
      const threshold = Number(ctx.config.minImprovePct) || 3;

      if (improve * 100 < threshold) {
        const pct = improve * 100;
        const cmpText =
          pct >= 0
            ? `${best.name} 仅高 ${pct.toFixed(1)}%`
            : `${best.name} 反而低 ${Math.abs(pct).toFixed(1)}%`;
        idle(`${trigger}：${describeBiome(current)} 已是较优选择（${cmpText}，未达迟滞门槛 ${threshold}%）`);
        return;
      }

      await doTravel(best, `${MODE_LABEL[mode]}更优 +${(improve * 100).toFixed(1)}%（${describeBiome(best)}）`);
    };

    const check = async (trigger: string) => {
      if (S.busy) return;

      // 每次真的决定前先看冷却：避免频繁换图被服务端限流
      const cooldownMs = Math.max(120, Number(ctx.config.travelCooldownSec) || 600) * 1000;
      if (Date.now() - S.lastTravelAt < cooldownMs) return;

      S.busy = true;
      try {
        await decide(trigger);
      } catch (err) {
        ctx.log.warn("自动切图", `${trigger}：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.busy = false;
      }
    };

    ctx.every(Math.max(60, Number(ctx.config.checkEverySec) || 120) * 1000, () => check("定时检查"));

    // 钓鱼结算时顺带检查（节流 1 分钟）
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < 60_000) return;
      lastSync = now;
      void check("钓鱼同步");
    });

    ctx.schedule(30_000, () => check("启动检查"));
  },
};

export default definition;
