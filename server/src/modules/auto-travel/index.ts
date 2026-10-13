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
//     涌流     正在刮「奥秘涌流」（arcane_surge）时去指定的地图（默认：已解锁的最高地图）
//     经验     天气经验加成最高的地图（**只看天气**，不含专精 / 公会增益）
//
//   判定方式是「按顺序找第一个有候选的优先级，它就是决定」——
//   也就是说：有比赛可去就不会因为别处天气好而跑掉；已经是金风了也不会被经验优先级拽走。
//
// ★ 涌流为什么要单独一个优先级：涌流是**覆盖所有地图**的全局天气，于是「天气经验最高」
//   在所有图上都一样，经验优先级只能靠 id 兜底挑到最小 id 的新手图 —— 这正是用户报的现象。
//   而涌流期间经验 ×1.75，应该待在**收益最高的那张图**（默认取已解锁的最高地图，可指定）。
//
// ★ 船队：船长 / 舵手（`party.canChangeBoatBiome`）可以把整条船开过去，能跟的船员一起走。
//   开了「带队换图」就改用船队接口（POST /api/party-boats/current-biome）而不是个人换图；
//   没有权限、或连船队都没加入时，只提示一次然后按普通换图处理。
//   跟不过来的船员由游戏跳过（未解锁目标图 / 不在船上 / 在打别的公会赛），我们只如实报数，
//   绝不反复重试 —— 同一张图连续失败若干次后就不再尝试，直到目标变化。
//
// ★ 经验口径（v3 起）：只看**天气**倍率（keep-online/xp-multiplier.ts 的表，9 种天气全覆盖）。
//   旧版把「地图专精 + 公会增益 + 天气」乘在一起当经验权重，于是「选了经验优先却不切过去」
//   （专精高的老图永远赢），而且金风 / 枯潮的文本里没有「经验」二字，靠解析文本会算成 0。
//
// 迟滞：经验优先级下，目标天气倍率要高出当前 minImprovePct% 才切；
//      比赛 / 金风命中则直接去（那两个是时段性的，犹豫就错过）。
import { type ModuleDefinition } from "../types.ts";
import { weatherMultiplier, weatherName } from "../keep-online/xp-multiplier.ts";
import { BIOMES, BIOME_OPTIONS, biomeName } from "../shared/biomes.ts";

const GOLDEN_WEATHER_ID = "gilded_current";
const SURGE_WEATHER_ID = "arcane_surge";

/** 比赛的终态：这些状态下的场次不能再当成「该去的比赛图」 */
const TERMINAL_TOURNAMENT_STATUSES = new Set(["ended", "finished", "settled", "settling", "canceled", "cancelled", "closed"]);

/**
 * 已经开赛、但接口状态还没翻成 active 的宽限窗口。
 * 只用于 `upcoming` 里的场次：比这更早的（startAt 更久以前）一律当历史场次丢掉 ——
 * 否则打完之后它还会一直霸占最高优先级，人就永远不回天气图了。
 */
const STARTED_GRACE_MS = 10 * 60_000;

/** 四个优先级（比赛 / 金风 / 涌流与官方助手一致，涌流是本项目多加的一项） */
export type Priority = "competition" | "golden" | "surge" | "experience";

export const PRIORITY_LABELS: Record<Priority, string> = {
  competition: "比赛",
  golden: "金风",
  surge: "涌流",
  experience: "经验",
};

/** 缺省顺序（官方助手的三项，涌流插在金风之后 —— 它是时段性的，犹豫就错过） */
export const DEFAULT_PRIORITIES: Priority[] = ["competition", "golden", "surge", "experience"];

const ALL_PRIORITIES: Priority[] = ["competition", "golden", "surge", "experience"];
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

/** 是否正在刮奥秘涌流（全局天气，覆盖所有地图） */
export function isSurge(biome: any): boolean {
  return weatherIdOf(biome) === SURGE_WEATHER_ID;
}

/**
 * 「已解锁的最高地图」= 鱼价值倍率最高的那张（越高等级的图倍率越高）。
 *
 * 排序键依次是：接口给的 `valueMultiplier`（越靠后的图越大，游戏自己会给）→
 * `requiredLevel`（个别版本不给倍率时用它）→ 内置地图表的顺序（兜底，让同一份数据结果稳定）→ id。
 * 全部相同（例如所有图倍率都是 1）时取 id 最小的，保证可测。
 */
export function pickHighestUnlocked(list: any[]): any | null {
  const score = (b: any) => ({
    value: Number(b?.valueMultiplier) || 0,
    level: Number(b?.requiredLevel) || 0,
    order: biomeOrder(b?.id),
  });
  let best: any = null;
  let bestScore: ReturnType<typeof score> | null = null;
  for (const item of list) {
    if (!item) continue;
    const cur = score(item);
    if (!best || !bestScore) {
      best = item;
      bestScore = cur;
      continue;
    }
    const better =
      cur.value - bestScore.value ||
      cur.level - bestScore.level ||
      cur.order - bestScore.order ||
      (String(best.id) > String(item.id) ? 1 : String(best.id) < String(item.id) ? -1 : 0);
    if (better > 0) {
      best = item;
      bestScore = cur;
    }
  }
  return best;
}

/** 内置地图表里的次序（b_001 = 0 …）；表里没有的返回 -1 */
function biomeOrder(id: unknown): number {
  return BIOMES.findIndex((b) => b.id === String(id ?? ""));
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
  /** 涌流期间指定去哪张图；空 / 未给 = 已解锁的最高地图 */
  surgeBiomeId?: string | null;
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

    if (p === "surge") {
      // 涌流是**全局**天气（覆盖所有地图），所以「有没有涌流」看的是有没有任一张图带着它
      const surged = unlocked.filter(isSurge);
      if (!surged.length) continue; // 没有涌流 → 看下一个优先级

      const wantId = String(input.surgeBiomeId ?? "").trim();
      const wanted = wantId ? (unlocked.find((b) => String(b?.id ?? "") === wantId) ?? null) : null;
      const target = wanted ?? pickHighestUnlocked(surged);
      if (!target) continue;
      if (String(target.id) === currentBiomeId) {
        return { action: "stay", reason: p, why: `已在涌流目标地图（${describeBiome(target)}）` };
      }
      return {
        action: "travel",
        biomeId: String(target.id),
        reason: p,
        why:
          `奥秘涌流 → ${describeBiome(target)}` +
          (wantId && !wanted ? `（配置的 ${wantId} 未解锁，改用已解锁的最高地图）` : ""),
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
  version: "4.0.0",
  description:
    "按你排的优先级在已解锁地图里挑一张待着（做法与官方航线助手的「换图优先级」一致）：比赛地图 > 金风地图 > 涌流地图 > 天气经验最高的地图，顺序可调。涌流是全局天气，可指定期间去哪张图（默认已解锁的最高地图）。船长 / 舵手还能在换图时把船员一起带走。",
  defaultEnabled: false,
  defaultConfig: {
    priorities: "competition,golden,surge,experience",
    surgeBiome: "",
    crewTravel: "off",
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
        "涌流 = 正在刮奥秘涌流时去下面指定的地图；" +
        "经验 = 天气经验加成最高的地图。",
      default: "competition,golden,surge,experience",
      options: PRIORITY_OPTIONS,
    },
    {
      key: "surgeBiome",
      type: "select",
      label: "奥秘涌流期间去哪张图",
      hint:
        "涌流是覆盖所有地图的全局天气，这时「天气经验最高」在所有图上都一样，所以需要单独指定去哪张。\n" +
        "留空 = 已解锁的最高地图（鱼价值倍率最高的那张）。",
      default: "",
      options: [{ value: "", label: "自动：已解锁的最高地图" }, ...BIOME_OPTIONS],
    },
    {
      key: "crewTravel",
      type: "select",
      label: "换图时带走船员",
      hint:
        "开启后换图会把整条船开过去，能跟的船员一起跟过来；目标图没解锁、人不在船上、正在打别的公会赛的船员会留在原地（游戏决定，日志里报数）。\n" +
        "只有船长 / 舵手（游戏里能改航线的人）生效，其他人开启也只是普通换图；「跟船队走」时本模块不换图，此项无效。",
      default: "off",
      options: [
        { value: "off", label: "只自己换图（默认）" },
        { value: "carry", label: "带船员一起走（船长 / 舵手）" },
      ],
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
      /** 带队换图暂缓到什么时候（按目标地图记）：失败过 / 已经开过去，就别反复召集船员 */
      crewWaitUntil: Record<string, number>;
      /** 同一张图连续带队失败次数（连续 3 次就长时间不再尝试） */
      crewFailStreak: Record<string, number>;
      /** 上次成功开船去过的地图 + 次数（自己没跟上时不再重复召集） */
      crewSailedTo: string;
      crewSailedTimes: number;
      /** 上次带队结果（同一条结果不重复写日志） */
      crewLastSummary: string;
    };
    S.busy = false;
    S.lastTravelAt = 0;
    S.lastIdle = "";
    S.crewWaitUntil = S.crewWaitUntil && typeof S.crewWaitUntil === "object" ? S.crewWaitUntil : {};
    S.crewFailStreak = S.crewFailStreak && typeof S.crewFailStreak === "object" ? S.crewFailStreak : {};
    S.crewSailedTo = typeof S.crewSailedTo === "string" ? S.crewSailedTo : "";
    S.crewSailedTimes = Number(S.crewSailedTimes) || 0;
    S.crewLastSummary = "";

    // 优先级只在启动时解析一次（改配置会重启模块，所以不必每轮重算）
    const priorities = parsePriorities(ctx.config.priorities);
    const minImprovePct = Math.max(0, Number(ctx.config.minImprovePct) || 0);
    const surgeBiomeId = String(ctx.config.surgeBiome ?? "").trim();
    const carryCrew = String(ctx.config.crewTravel ?? "off") === "carry";
    /** 船员拉不动的暂缓时长：失败 3 次后长时间不再试，避免反复召集 */
    const CREW_BACKOFF_MS = 10 * 60_000;
    const CREW_GIVE_UP_MS = 6 * 3600_000;

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

      /**
       * 这场值不值得为它换图（★ 三处校验缺一不可 —— 这里踩过坑：
       * 比赛结束后人永远留在比赛图，天气再好也不切）：
       *
       *  1. `status` 不能是终态（ended / settled / settling…）。旧版 `current` 只看
       *     `isRegistered`，于是「已结束但仍是 current」的场次会一直算「进行中」。
       *  2. 开赛时间必须**有下界**。只判 `startAt - now <= leadMs` 的话，**任何历史场次**
       *     都满足（过去越久差得越负），于是 `upcoming` 里残留的旧场次会永久霸占最高优先级。
       *  3. 公会赛看 `entryStatus` 只代表「我报了名」，同样得配状态与时间判断。
       */
      const worthy = (t: any, registeredKey: string): boolean => {
        if (!t?.[registeredKey]) return false;
        const status = String(t?.status ?? "").toLowerCase();
        if (TERMINAL_TOURNAMENT_STATUSES.has(status)) return false;
        if (status === "active") return true;
        if (status && status !== "scheduled") return false; // 不认识的中间状态不当目标
        const at = Date.parse(String(t?.startAt ?? ""));
        if (!Number.isFinite(at)) return false;
        const delta = at - now;
        return delta <= leadMs && delta > -STARTED_GRACE_MS;
      };
      /** 日志里说清是「进行中」还是「即将开赛」 */
      const phase = (t: any) => (String(t?.status ?? "").toLowerCase() === "active" ? "进行中" : "即将开赛");

      const cur = personal?.current;
      if (worthy(cur, "isRegistered")) {
        const biomeId = cur.assignedBiomeId ?? cur.biomeId;
        if (biomeId) return { biomeId, why: `个人赛 #${cur.sequence} ${phase(cur)}` };
      }
      for (const t of personal?.upcoming ?? []) {
        if (worthy(t, "isRegistered")) {
          const biomeId = t.assignedBiomeId ?? t.biomeId;
          if (biomeId) return { biomeId, why: `个人赛 #${t.sequence} ${phase(t)}` };
        }
      }
      const gcur = guild?.current;
      if (worthy(gcur, "entryStatus")) {
        const biomeId = gcur.assignedBiomeId ?? gcur.biomeId;
        if (biomeId) return { biomeId, why: `公会赛 #${gcur.sequence} ${phase(gcur)}` };
      }
      for (const t of guild?.upcoming ?? []) {
        if (worthy(t, "entryStatus")) {
          const biomeId = t.assignedBiomeId ?? t.biomeId;
          if (biomeId) return { biomeId, why: `公会赛 #${t.sequence} ${phase(t)}` };
        }
      }
      return null;
    };

    /** 个人换图：只把自己挪过去（免费）。在船队里时，船队开动仍会把船上的人一起带走 */
    const personalTravel = async (biomeId: string, name: string, reason: string) => {
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

    /**
     * 带队换图：把整条船开过去，能跟的船员一起走。
     *
     * 返回 true = 本次已经处理（无论成败），调用方不要再个人换图 ——
     * 船长自己单独跑掉、把船员留在原地，是这个选项最不该出现的结果。
     */
    const travelWithCrew = async (biomeId: string, name: string, reason: string): Promise<boolean> => {
      const now = Date.now();

      const waitUntil = Number(S.crewWaitUntil[biomeId]) || 0;
      if (waitUntil > now) {
        idle(
          `带队前往 ${name} 暂缓中（${Math.max(1, Math.ceil((waitUntil - now) / 60_000))} 分钟后重试），不重复召集船员`,
        );
        return true;
      }

      const party = (await ctx.api.fishingState().catch(() => null))?.party ?? null;
      if (!party?.isInParty) {
        // 没船队：按普通换图走（只提示一次，避免每轮刷）
        if (S.crewLastSummary !== "no-party") {
          S.crewLastSummary = "no-party";
          ctx.log.info("自动切图", "「换图时带走船员」已开启，但当前没有加入船队，按普通换图处理");
        }
        return false;
      }
      if (!party.canChangeBoatBiome) {
        // 不是船长 / 舵手：这项本来就不该生效 —— 说清楚一次，然后照常自己换图
        if (S.crewLastSummary !== "no-permission") {
          S.crewLastSummary = "no-permission";
          ctx.log.info(
            "自动切图",
            `「换图时带走船员」需要船长 / 舵手权限（船队 ${party.boatName ?? ""}），当前账号没有该权限，按普通换图处理`,
          );
        }
        return false;
      }

      // ★ 已经开过去、但自己还不在那张图上（例如人不在船上）→ 不反复召集
      if (S.crewSailedTo === biomeId && S.crewSailedTimes >= 2) {
        S.crewWaitUntil[biomeId] = now + CREW_GIVE_UP_MS;
        ctx.log.warn(
          "自动切图",
          `已 ${S.crewSailedTimes} 次把船队开到 ${name}，但你自己仍不在该图（可能不在船上），停止重复召集`,
        );
        return true;
      }

      try {
        const r = await ctx.api.partyBoatTravel(biomeId);
        if (biomeId === S.crewSailedTo) S.crewSailedTimes += 1;
        else {
          S.crewSailedTo = biomeId;
          S.crewSailedTimes = 1;
        }
        const moved = Number(r?.movedCount) || 0;
        const skippedLocked = Number(r?.skippedLockedCount) || 0;
        const skippedAway = Number(r?.skippedAwayCount) || 0;
        const skippedGuild = Number(r?.skippedGuildCompetitionCount) || 0;
        const skipped = skippedLocked + skippedAway + skippedGuild;
        const detail = skipped
          ? `，留在原地 ${skipped} 人` +
            `（未解锁目标 ${skippedLocked} / 不在船上 ${skippedAway} / 在打公会赛 ${skippedGuild}）`
          : "";
        const summary = `${biomeId}:${r?.changed === false ? "nochange" : "moved"}:${moved}:${skipped}`;
        if (S.crewLastSummary !== summary) {
          S.crewLastSummary = summary;
          if (r?.changed === false) {
            // 船本来就在目标图：不当作成功换图，避免下一轮又来一次
            ctx.log.info("自动切图", `船队已在 ${name}，本次未开船（随船 ${moved} 人${detail}）`);
            S.crewWaitUntil[biomeId] = now + CREW_BACKOFF_MS;
          } else {
            ctx.log.info("自动切图", `⛵ ${reason} → ${name}（带队：随船 ${moved} 人${detail}）`);
          }
        }
        S.crewFailStreak[biomeId] = 0;
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const streak = (Number(S.crewFailStreak[biomeId]) || 0) + 1;
        S.crewFailStreak[biomeId] = streak;
        const giveUp = streak >= 3;
        S.crewWaitUntil[biomeId] = now + (giveUp ? CREW_GIVE_UP_MS : CREW_BACKOFF_MS);
        ctx.log.warn(
          "自动切图",
          `带队前往 ${name} 失败（第 ${streak} 次）：${message}` +
            (giveUp
              ? `；连续 ${streak} 次失败，暂停尝试（目标图变化后会重新尝试）`
              : `；${Math.round(CREW_BACKOFF_MS / 60_000)} 分钟后重试，本次不单独换图`),
        );
        return true;
      }
    };

    const doTravel = async (biomeId: string, name: string, reason: string) => {
      S.lastTravelAt = Date.now();
      if (carryCrew && (await travelWithCrew(biomeId, name, reason))) return;
      await personalTravel(biomeId, name, reason);
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
        surgeBiomeId,
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
        `经验只看天气加成${minImprovePct ? `，迟滞 ${minImprovePct}%` : ""}；` +
        `涌流目标 ${surgeBiomeId ? biomeName(surgeBiomeId) ?? surgeBiomeId : "已解锁的最高地图"}；` +
        (carryCrew
          ? String(ctx.config.fleetMode) === "follow"
            ? "带队换图已开启，但配置为「跟船队走」（本模块不换图，因此不会开船）"
            : "带队换图已开启（需船长 / 舵手权限）"
          : "不带船员，仅自己换图"),
    );
  },
};

export default definition;
