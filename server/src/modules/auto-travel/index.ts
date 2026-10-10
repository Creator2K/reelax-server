// 自动切图：按「优先级」在已解锁地图里挑一张待着（做法对齐官方航线助手）
//
// 协议：
//  - GET /api/biomes → { biomes: [{ id, name, isUnlocked, isCurrent, valueMultiplier,
//                                  weather: { weatherId, effect, name }, activeCompetitions }] }
//  - GET /api/tournaments/overview 与 /api/guild-tournaments/overview：比赛场次（进图依据）
//  - PUT /api/player/current-biome { biomeId }   换图（免费）
//
// ★ 优先级（与官方助手的「换图优先级」同构，可从高到低排序）：
//     比赛     我在打的比赛地图（个人赛 / 公会赛已报名，进行中或即将开赛）
//     金风     正在刮「金风」（gilded_current）的地图 —— 每杆直接金币区间提高
//     经验     天气经验加成最高的地图（**只看天气**，不含专精 / 公会增益）
//
//   判定方式是「按顺序找第一个有候选的优先级，它就是决定」——
//   也就是说：有比赛可去就不会因为别处天气好而跑掉；已经是金风了也不会被经验优先级拽走。
//
// ★ 经验口径（v3 起）：只看**天气**倍率（keep-online/xp-multiplier.ts 的表，9 种天气全覆盖）。
//   旧版把「地图专精 + 公会增益 + 天气」乘在一起当经验权重，于是「选了经验优先却不切过去」
//   （专精高的老图永远赢），而且金风 / 枯潮的文本里没有「经验」二字，靠解析文本会算成 0。
//
// 迟滞：经验优先级下，目标天气倍率要高出当前 minImprovePct% 才切；
//      比赛 / 金风命中则直接去（那两个是时段性的，犹豫就错过）。
import { type ModuleDefinition } from "../types.ts";
import { weatherMultiplier, weatherName } from "../keep-online/xp-multiplier.ts";

const GOLDEN_WEATHER_ID = "gilded_current";

/** 三个优先级（与官方航线助手一致） */
export type Priority = "competition" | "golden" | "experience";

export const PRIORITY_LABELS: Record<Priority, string> = {
  competition: "比赛",
  golden: "金风",
  experience: "经验",
};

/** 缺省顺序（也是官方助手的默认值） */
export const DEFAULT_PRIORITIES: Priority[] = ["competition", "golden", "experience"];

const ALL_PRIORITIES: Priority[] = ["competition", "golden", "experience"];
const isPriority = (v: unknown): v is Priority => ALL_PRIORITIES.includes(v as Priority);

/**
 * 解析「优先级」配置（值形如 "competition,golden,experience"）。
 * 无论怎么写，结果都一定是三项齐全且不重复 —— 顺序才是配置项本身。
 */
export function parsePriorities(value: unknown): Priority[] {
  const list = String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<Priority>();
  const out: Priority[] = [];
  for (const item of list) {
    if (isPriority(item) && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  // 缺的补在后面：用户只写了一半也不会漏掉某个优先级
  for (const p of DEFAULT_PRIORITIES) if (!seen.has(p)) out.push(p);
  return out;
}

/** 该地图的天气 id（原始响应里是 weatherId；个别版本只给 id） */
export function weatherIdOf(biome: any): string | null {
  return biome?.weather?.weatherId ?? biome?.weather?.id ?? null;
}

/**
 * 该地图的「经验权重」——**只看天气加成**（用户明确要求）：
 * 专精等级、公会增益都不参与，避免专精高的老图永远赢。
 */
export function xpWeight(biome: any): number {
  return weatherMultiplier(weatherIdOf(biome));
}

/** 该地图的「鱼价值」倍率 */
export function valueWeight(biome: any): number {
  return Number(biome?.valueMultiplier) || 1;
}

/** 是否正在刮金风 */
export function isGolden(biome: any): boolean {
  return weatherIdOf(biome) === GOLDEN_WEATHER_ID;
}

export type TravelDecision =
  | { action: "travel"; biomeId: string; reason: Priority; why: string }
  | { action: "stay"; reason: Priority | null; why: string };

/** 比大小：先按主指标，再按 id 兜底，保证同一份数据每次选出同一张（可测） */
function bestBy<T>(list: T[], score: (b: T) => number, idOf: (b: T) => string): T | null {
  let best: T | null = null;
  for (const item of list) {
    if (!best) {
      best = item;
      continue;
    }
    const d = score(item) - score(best);
    if (d > 0 || (d === 0 && idOf(item) < idOf(best))) best = item;
  }
  return best;
}

/**
 * 选图决策（纯函数）。
 *
 * @param input.competition 外部算好的比赛目标（我在打的比赛地图）；没有则 null
 */
export function planTravel(input: {
  priorities: Priority[];
  /** 已解锁的地图（应包含当前地图） */
  unlocked: any[];
  currentBiomeId: string | null;
  competition: { biomeId: string; why: string } | null;
  minImprovePct: number;
}): TravelDecision {
  const { unlocked, currentBiomeId, competition } = input;
  const priorities = input.priorities.length ? input.priorities : DEFAULT_PRIORITIES;

  if (!unlocked.length) return { action: "stay", reason: null, why: "没有已解锁的地图" };
  const current = unlocked.find((b) => b?.id === currentBiomeId) ?? null;

  for (const p of priorities) {
    if (p === "competition") {
      if (!competition) continue; // 没比赛 → 看下一个优先级
      if (competition.biomeId === currentBiomeId) {
        return { action: "stay", reason: p, why: `已在比赛地图（${competition.why}）` };
      }
      return { action: "travel", biomeId: competition.biomeId, reason: p, why: `比赛地图：${competition.why}` };
    }

    if (p === "golden") {
      const cands = unlocked.filter(isGolden);
      if (!cands.length) continue;
      const best = bestBy(cands, valueWeight, (b) => String(b?.id ?? ""));
      if (!best) continue;
      if (best.id === currentBiomeId) {
        return { action: "stay", reason: p, why: `已在金风地图（鱼价值×${valueWeight(best).toFixed(2)}）` };
      }
      return {
        action: "travel",
        biomeId: best.id,
        reason: p,
        why: `金风天气：鱼价值×${valueWeight(best).toFixed(2)}（每杆直接金币区间提高）`,
      };
    }

    // experience：天气经验最高的地图（只看天气）
    const best = bestBy(unlocked, xpWeight, (b) => String(b?.id ?? ""));
    if (!best) continue;
    const bestXp = xpWeight(best);
    if (best.id === currentBiomeId) {
      return {
        action: "stay",
        reason: p,
        why: `当前地图的天气经验已是最优（${weatherLabel(best)}，×${bestXp.toFixed(2)}）`,
      };
    }
    const curXp = current ? xpWeight(current) : 1;
    const improve = curXp > 0 ? bestXp / curXp - 1 : 1;
    const threshold = Math.max(0, Number(input.minImprovePct) || 0);
    if (improve * 100 < threshold) {
      return {
        action: "stay",
        reason: p,
        why:
          `天气经验未达迟滞门槛：${best.name ?? best.id} ${weatherLabel(best)}×${bestXp.toFixed(2)}` +
          ` 比当前 ${weatherLabel(current)}×${curXp.toFixed(2)} 高 ${(improve * 100).toFixed(1)}%（门槛 ${threshold}%）`,
      };
    }
    return {
      action: "travel",
      biomeId: best.id,
      reason: p,
      why:
        `天气经验更优：${weatherLabel(best)}×${bestXp.toFixed(2)}` +
        `（当前 ${weatherLabel(current)}×${curXp.toFixed(2)}，高 ${(improve * 100).toFixed(1)}%）`,
    };
  }

  return { action: "stay", reason: null, why: "按当前优先级没有可去的地图" };
}

/** 「晴空 ×1.00」这样的一句话（日志里比 weatherId 好读得多） */
export function weatherLabel(biome: any): string {
  const id = weatherIdOf(biome);
  if (!id) return "天气未知";
  // 不认识的天气 id 原样显示，别显示成空白
  return weatherName(id) ?? id;
}

/** 把一张地图的加成说清楚，方便在日志里核对 */
export function describeBiome(b: any): string {
  return `${b?.name ?? b?.id} 鱼价值×${valueWeight(b).toFixed(2)} 天气${weatherLabel(b)}×${xpWeight(b).toFixed(2)}`;
}

/** 优先级 → 配置值（前端下拉框的选项用它生成） */
const PRIORITY_OPTIONS = (() => {
  const perms: Array<[Priority, Priority, Priority]> = [];
  for (const a of ALL_PRIORITIES) {
    for (const b of ALL_PRIORITIES) {
      for (const c of ALL_PRIORITIES) {
        if (a !== b && b !== c && a !== c) perms.push([a, b, c]);
      }
    }
  }
  return perms.map(([a, b, c]) => ({
    value: `${a},${b},${c}`,
    label: `${PRIORITY_LABELS[a]} > ${PRIORITY_LABELS[b]} > ${PRIORITY_LABELS[c]}`,
  }));
})();

const definition: ModuleDefinition = {
  id: "auto-travel",
  name: "自动切图",
  version: "3.0.0",
  description:
    "按你排的优先级在已解锁地图里挑一张待着（做法与官方航线助手的「换图优先级」一致）：比赛地图 > 金风地图 > 天气经验最高的地图，顺序可调。经验只看天气加成，不算地图专精与公会增益。",
  defaultEnabled: false,
  defaultConfig: {
    priorities: "competition,golden,experience",
    fleetMode: "solo",
    checkEverySec: 120,
    minImprovePct: 3,
    travelCooldownSec: 600,
    competitionLeadSec: 180,
  },
  configSchema: [
    {
      key: "priorities",
      type: "select",
      label: "换图优先级（从高到低）",
      hint:
        "按顺序找第一个有候选的优先级，它就是决定 —— 有比赛可去就不会因为别处天气好而跑掉。\n" +
        "比赛 = 我已报名的个人赛 / 公会赛地图（进行中或即将开赛）；" +
        "金风 = 正在刮金风的地图（每杆直接金币区间提高）；" +
        "经验 = 天气经验加成最高的地图。",
      default: "competition,golden,experience",
      options: PRIORITY_OPTIONS,
    },
    {
      key: "fleetMode",
      type: "select",
      label: "与船队的关系",
      hint: "跟船队走 = 完全不自己换图，船队开到哪你就在哪；自己切图 = 按上面的优先级自行换图（船队自己开走时游戏仍会把你带走）",
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
      hint: "只作用于「经验」：目标天气倍率要高出当前这么多才切，防止来回横跳。比赛 / 金风命中时直接去，不适用。",
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

    // 优先级只在启动时解析一次（改配置会重启模块，所以不必每轮重算）
    const priorities = parsePriorities(ctx.config.priorities);
    const minImprovePct = Math.max(0, Number(ctx.config.minImprovePct) || 0);

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
        const biomeId = cur.assignedBiomeId ?? cur.biomeId;
        if (biomeId) return { biomeId, why: `个人赛 #${cur.sequence} 进行中` };
      }
      for (const t of personal?.upcoming ?? []) {
        if (t?.isRegistered && soon(t, "isRegistered")) {
          const biomeId = t.assignedBiomeId ?? t.biomeId;
          if (biomeId) return { biomeId, why: `个人赛 #${t.sequence} 即将开赛` };
        }
      }
      const gcur = guild?.current;
      if (gcur?.entryStatus) {
        const biomeId = gcur.assignedBiomeId ?? gcur.biomeId;
        if (biomeId) return { biomeId, why: `公会赛 #${gcur.sequence} 进行中` };
      }
      for (const t of guild?.upcoming ?? []) {
        if (t?.entryStatus && soon(t, "entryStatus")) {
          const biomeId = t.assignedBiomeId ?? t.biomeId;
          if (biomeId) return { biomeId, why: `公会赛 #${t.sequence} 即将开赛` };
        }
      }
      return null;
    };

    const doTravel = async (biomeId: string, name: string, reason: string) => {
      S.lastTravelAt = Date.now();
      try {
        const r = await ctx.api.biomeTravel(biomeId);
        const cur = r?.player?.currentBiomeId;
        if (cur && cur !== biomeId) {
          ctx.log.warn("自动切图", `前往 ${name} 未生效（当前 ${cur}），稍后重试`);
          return;
        }
        ctx.log.info("自动切图", `⛵ ${reason} → ${name}`);
      } catch (err) {
        ctx.log.warn("自动切图", `前往 ${name} 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const decide = async (trigger: string) => {
      const data = await ctx.api.biomes();
      const biomes: any[] = (data?.biomes ?? []).filter(Boolean);
      const current = biomes.find((b) => b.isCurrent);
      const unlocked = biomes.filter((b) => b.isUnlocked !== false);
      if (!current || !unlocked.length) {
        idle("地图数据尚未就绪");
        return;
      }

      /* ---------- 「跟船队走」：完全不自己换图 ---------- */
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

      const competition = await competitionTarget(Date.now());
      const decision = planTravel({
        priorities,
        unlocked,
        currentBiomeId: current.id ?? null,
        competition,
        minImprovePct,
      });

      if (decision.action === "stay") {
        idle(`${trigger}：${decision.why}`);
        return;
      }

      const target = unlocked.find((b) => b.id === decision.biomeId) ?? { id: decision.biomeId, name: decision.biomeId };
      const name = String(target.name ?? decision.biomeId);
      await doTravel(decision.biomeId, name, `${PRIORITY_LABELS[decision.reason]}｜${decision.why}`);
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

    ctx.log.info(
      "自动切图",
      `已启动：优先级 ${priorities.map((p) => PRIORITY_LABELS[p]).join(" > ")}；` +
        `经验只看天气加成${minImprovePct ? `，迟滞 ${minImprovePct}%` : ""}`,
    );
  },
};

export default definition;
