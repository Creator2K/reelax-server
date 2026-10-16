// 以物易物面板数据组装（纯函数，便于单测）
//
// 数据来源：
//  · `/api/inventory/fish` —— 我手上有什么、剩几条、有没有被锁；
//  · `/api/content/bootstrap` —— 鱼定义（稀有度 / 所属地图），背包条目不一定带这些字段；
//  · `/api/mastery` —— 当前每条地图 × 稀有度的专精目标鱼（这些鱼不拿去换）；
//  · `barter_tasks` 表 —— 队列本身。
//
// 一条任务的两侧都是**地图规格列表**（「B2 上的任意神话鱼」），所以面板只需要两组选项：
//  · 起点 = 我在这张图这一档上现在能拿出几条；
//  · 目标 = 游戏里这张图这一档有鱼（能换到）。
// 指名鱼种只在 1.17.0 的老任务里存在，展示上照样能渲染（见 specView）。
import { rarityLabel, rarityRank } from "../modules/shared/rarity.ts";
import { biomeCode, biomeLabel, biomeName as biomeNameOf } from "../modules/shared/biomes.ts";
import {
  BARTER_RARITIES,
  isBarterRarity,
  specMatchesFish,
  specsMatcher,
  type BarterFish,
  type BarterHop,
  type BarterPlan,
  type BarterSpec,
} from "./barter-plan.ts";
import type { BarterTaskRow, BarterTaskStatus } from "../db/repositories/barter-tasks.ts";

/** 队列里最多同时存在几个未结束的任务 */
export const MAX_OPEN_TASKS = 5;
/** 单条任务的目标条数上限 */
export const MAX_TASK_QUANTITY = 99;

/** 一侧规格的展示形态（把 id 都翻成中文名与 B 几） */
export type BarterSpecView = {
  biomeId: string | null;
  /** `B2` 这种简称（玩家交流用的就是它） */
  biomeCode: string | null;
  biomeName: string | null;
  rarity: string;
  rarityLabel: string;
  /** 有值 = 指名鱼种（1.17.0 的老任务） */
  fishId: string | null;
  fishName: string | null;
  /** 一句话说法：「雾语湿地 B2 的任意神话鱼」 */
  text: string;
};

/** 起点候选：某张地图 × 某一档，现在能拿出几条 */
export type BarterStartMapOption = {
  biomeId: string;
  biomeCode: string | null;
  biomeName: string | null;
  rarity: string;
  rarityLabel: string;
  /** 这张图上这一档现有几条（已排除锁定与专精目标鱼） */
  quantity: number;
};

/** 目标候选：某张地图 × 某一档上有鱼可换 */
export type BarterTargetMapOption = {
  biomeId: string;
  biomeCode: string | null;
  biomeName: string | null;
  rarity: string;
  rarityLabel: string;
};

export type BarterTaskView = {
  id: string;
  quantity: number;
  doneQuantity: number;
  status: BarterTaskStatus;
  statusText: string;
  lastNote: string | null;
  lastError: string | null;
  fromSpecs: BarterSpecView[];
  targetSpecs: BarterSpecView[];
  /** 紧凑一句话：「B2 / B3 的任意神话鱼」 */
  fromText: string;
  targetText: string;
  createdAt: number;
  updatedAt: number;
};

export type BarterHopView = {
  orderId: string;
  owner: string | null;
  giveFishId: string;
  giveName: string;
  giveBiomeCode: string | null;
  giveBiomeName: string | null;
  getFishId: string;
  getName: string;
  getBiomeCode: string | null;
  getBiomeName: string | null;
  remaining: number;
};

export type BarterHeadView = {
  taskId: string;
  /** 这一轮实际会动用的起点鱼（多起点里挑出来的那条） */
  startFishId: string | null;
  startFishName: string | null;
  startBiomeCode: string | null;
  startBiomeName: string | null;
  reachable: boolean;
  hops: BarterHopView[];
  /** 走不通时的原因（面板原样展示） */
  reason: string | null;
};

export type BarterView = {
  /** 功能开关状态：没开的时侯队列只是「存着」，面板要说清楚 */
  module: { enabled: boolean; running: boolean };
  limits: { maxOpenTasks: number; maxQuantity: number; maxSpecs: number; rarities: { value: string; label: string }[] };
  /** 以物易物支持的稀有度说明（面板顶部一句提示） */
  rarityHint: string;
  tasks: BarterTaskView[];
  /** 起点候选（按地图 × 稀有度聚合，带现有数量） */
  startOptions: BarterStartMapOption[];
  /** 目标候选（按地图 × 稀有度聚合） */
  targetOptions: BarterTargetMapOption[];
  /** 队首任务当前能不能走通（打开面板时现算一次） */
  head: BarterHeadView | null;
};

export const BARTER_RARITY_HINT =
  `以物易物只支持 ${BARTER_RARITIES.map((r) => rarityLabel(r)).join(" / ")} 三档稀有度，` +
  "且同一张交换单里的鱼必须同稀有度，所以一条交换链全程留在同一个稀有度里；" +
  "同一条任务里的起点/目标可以是不同稀有度，助手会各自走各自的链。";

export function barterTaskStatusText(status: BarterTaskStatus): string {
  switch (status) {
    case "running":
      return "进行中";
    case "done":
      return "已完成";
    case "blocked":
      return "缺鱼（等背包补上起点鱼）";
    case "cancelled":
      return "已取消";
    default:
      return "等待中";
  }
}

/* ---------------- 背包 / 内容表 ---------------- */

export type InventoryFish = {
  fishId: string;
  quantity: number;
  /** 手动锁 / 系统锁 / 专精锁 —— 任意一种都不该拿去交换 */
  locked: boolean;
  masteryLocked: boolean;
};

/** `/api/inventory/fish` → 归一化的背包条目 */
export function readInventoryFish(payload: unknown): InventoryFish[] {
  const list = Array.isArray((payload as { fish?: unknown })?.fish) ? (payload as { fish: unknown[] }).fish : [];
  const out: InventoryFish[] = [];
  for (const raw of list as any[]) {
    const fishId = String(raw?.fishId ?? raw?.id ?? "");
    if (!fishId) continue;
    out.push({
      fishId,
      quantity: Math.max(0, Math.floor(Number(raw?.quantity) || 0)),
      locked: Boolean(raw?.isLocked || raw?.isManuallyLocked),
      masteryLocked: Boolean(raw?.isMasteryLocked),
    });
  }
  return out;
}

export type ContentFish = { id: string; name: string; rarity: string; biomeId: string | null };

/** `/api/content/bootstrap` → 鱼定义（只要用得到的字段） */
export function readContentFish(payload: unknown): ContentFish[] {
  const list = Array.isArray((payload as { fish?: unknown })?.fish) ? (payload as { fish: unknown[] }).fish : [];
  const out: ContentFish[] = [];
  for (const raw of list as any[]) {
    const id = String(raw?.id ?? raw?.fishId ?? "");
    if (!id) continue;
    out.push({
      id,
      name: String(raw?.name ?? id),
      rarity: String(raw?.rarity ?? ""),
      biomeId: raw?.biomeId ? String(raw.biomeId) : null,
    });
  }
  return out;
}

const contentMap = (fish: ContentFish[]): Map<string, ContentFish> => new Map(fish.map((f) => [f.id, f]));

/**
 * `/api/mastery` → 当前还被需要的专精目标鱼 id 集合。
 *
 * ★ 为什么要排除它们：这些鱼是「自动专精献祭」的素材，拿去换掉就等于把专精进度换掉了。
 *   只有还缺的（remainingQuantity > 0）才算数 —— 已经凑齐的目标鱼不再受这条限制。
 */
export function masteryTargetFishIds(overview: unknown): Set<string> {
  const out = new Set<string>();
  const biomes = Array.isArray((overview as { biomes?: unknown })?.biomes)
    ? (overview as { biomes: any[] }).biomes
    : [];
  for (const biome of biomes) {
    const rarities = Array.isArray(biome?.rarities) ? biome.rarities : [];
    for (const item of rarities as any[]) {
      const id = item?.fish?.id ?? item?.fish?.fishId ?? item?.fishId;
      if (!id) continue;
      const remaining = Number(item?.remainingQuantity);
      if (Number.isFinite(remaining) && remaining <= 0) continue;
      out.add(String(id));
    }
  }
  return out;
}

/** 可以作为起点的鱼（鱼种粒度）：背包里有的、未锁定的、不是专精目标鱼、且属于最高三档 */
export function pickStartCandidates(input: {
  inventory: InventoryFish[];
  content?: unknown;
  masteryTargets?: Set<string>;
}): (BarterFish & { quantity: number })[] {
  const defs = contentMap(readContentFish(input.content));
  const mastery = input.masteryTargets ?? new Set<string>();
  const out: (BarterFish & { quantity: number })[] = [];
  for (const item of input.inventory) {
    if (item.quantity <= 0) continue;
    if (item.locked || item.masteryLocked) continue;
    if (mastery.has(item.fishId)) continue;
    const def = defs.get(item.fishId);
    const rarity = def?.rarity ?? "";
    if (!isBarterRarity(rarity)) continue;
    out.push({
      fishId: item.fishId,
      name: def?.name ?? item.fishId,
      biomeId: def?.biomeId ?? null,
      rarity,
      quantity: item.quantity,
    });
  }
  // 顺序稳定：稀有度从低到高（神话 → 奇异 → 奥秘）、同档按名称与 id
  out.sort(
    (a, b) =>
      rarityRank(a.rarity) - rarityRank(b.rarity) ||
      a.name.localeCompare(b.name, "zh-CN") ||
      a.fishId.localeCompare(b.fishId),
  );
  return out;
}

/** 起点候选（地图 × 稀有度粒度）：把同图同档的鱼的数量合起来 */
export function pickStartMapOptions(input: {
  inventory: InventoryFish[];
  content?: unknown;
  masteryTargets?: Set<string>;
}): BarterStartMapOption[] {
  const byKey = new Map<string, BarterStartMapOption>();
  for (const fish of pickStartCandidates(input)) {
    if (!fish.biomeId) continue;
    const key = `${fish.biomeId}|${fish.rarity}`;
    const hit = byKey.get(key);
    if (hit) hit.quantity += fish.quantity;
    else
      byKey.set(key, {
        biomeId: fish.biomeId,
        biomeCode: biomeCode(fish.biomeId),
        biomeName: biomeNameOf(fish.biomeId),
        rarity: fish.rarity,
        rarityLabel: rarityLabel(fish.rarity),
        quantity: fish.quantity,
      });
  }
  // 先按地图（B1 → B15），再按稀有度
  return [...byKey.values()].sort(
    (a, b) => a.biomeId.localeCompare(b.biomeId) || rarityRank(a.rarity) - rarityRank(b.rarity),
  );
}

/** 目标候选（地图 × 稀有度粒度）：游戏里这张图这一档有鱼就能作为目标 */
export function pickTargetMapOptions(content: unknown): BarterTargetMapOption[] {
  const byKey = new Map<string, BarterTargetMapOption>();
  for (const f of readContentFish(content)) {
    if (!f.biomeId) continue;
    if (!isBarterRarity(f.rarity)) continue;
    const key = `${f.biomeId}|${f.rarity}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      biomeId: f.biomeId,
      biomeCode: biomeCode(f.biomeId),
      biomeName: biomeNameOf(f.biomeId),
      rarity: f.rarity,
      rarityLabel: rarityLabel(f.rarity),
    });
  }
  return [...byKey.values()].sort(
    (a, b) => a.biomeId.localeCompare(b.biomeId) || rarityRank(a.rarity) - rarityRank(b.rarity),
  );
}

/* ---------------- 任务与路径 ---------------- */

/** 规格 → 展示形态（`B2` 编号 + 地图名 + 稀有度中文名） */
export function specView(spec: BarterSpec, content?: unknown): BarterSpecView {
  const defs = contentMap(readContentFish(content));
  const fish = spec.fishId ? (defs.get(spec.fishId) ?? null) : null;
  const biomeId = spec.biomeId ?? fish?.biomeId ?? null;
  const rarity = spec.rarity || fish?.rarity || "";
  const biome = biomeId ? `${biomeLabel(biomeId) ?? biomeId}` : "任意地图";
  const text = fish ? `${biome} 的${fish.name}` : `${biome} 的任意${rarity ? rarityLabel(rarity) : ""}鱼`;
  return {
    biomeId,
    biomeCode: biomeCode(biomeId),
    biomeName: biomeId ? biomeNameOf(biomeId) : null,
    rarity,
    rarityLabel: rarity ? rarityLabel(rarity) : "",
    fishId: spec.fishId,
    fishName: fish?.name ?? null,
    text,
  };
}

/** 一侧规格列表的紧凑说法：「B2 / B3 的任意神话鱼」 */
export function specsSummary(specs: BarterSpecView[]): string {
  if (!specs.length) return "（未设置）";
  const parts = specs.map((s) =>
    s.fishId ? (s.fishName ?? s.fishId) : (s.biomeCode ?? s.biomeName ?? "任意地图"),
  );
  const rarities = new Set(specs.map((s) => s.rarity));
  const rarity = rarities.size === 1 ? rarityLabel([...rarities][0]) : "";
  const anyFish = specs.every((s) => !s.fishId);
  return `${parts.join(" / ")}${anyFish ? `的任意${rarity || "同稀有度"}鱼` : ""}`;
}

/** 任务目标的中文说法（日志与面板共用） */
export function taskTargetText(task: Pick<BarterTaskRow, "from_specs" | "target_specs">): string {
  return specsSummary(task.target_specs.map((s) => specView(s)));
}

/** 任务起点侧的中文说法（日志共用） */
export function taskFromText(task: Pick<BarterTaskRow, "from_specs">): string {
  return specsSummary(task.from_specs.map((s) => specView(s)));
}

/** 从鱼种候选里挑出「符合起点规格」的那些（模块与面板预览共用同一套判定） */
export function filterStartFish<T extends BarterFish>(specs: BarterSpec[], candidates: T[]): T[] {
  return candidates.filter((c) => specs.some((s) => specMatchesFish(s, c)));
}

export function toTaskView(row: BarterTaskRow): BarterTaskView {
  const fromSpecs = row.from_specs.map((s) => specView(s));
  const targetSpecs = row.target_specs.map((s) => specView(s));
  return {
    id: row.id,
    quantity: row.quantity,
    doneQuantity: row.done_quantity,
    status: row.status,
    statusText: barterTaskStatusText(row.status),
    lastNote: row.last_note,
    lastError: row.last_error,
    fromSpecs,
    targetSpecs,
    fromText: specsSummary(fromSpecs),
    targetText: specsSummary(targetSpecs),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toHopViews(hops: BarterHop[]): BarterHopView[] {
  return hops.map((h) => ({
    orderId: h.orderId,
    owner: h.ownerNickname,
    giveFishId: h.give.fishId,
    giveName: h.give.name,
    giveBiomeCode: h.give.biomeId ? biomeCode(h.give.biomeId) : null,
    giveBiomeName: h.give.biomeId ? biomeNameOf(h.give.biomeId) : null,
    getFishId: h.get.fishId,
    getName: h.get.name,
    getBiomeCode: h.get.biomeId ? biomeCode(h.get.biomeId) : null,
    getBiomeName: h.get.biomeId ? biomeNameOf(h.get.biomeId) : null,
    remaining: h.capacity,
  }));
}

export function toHeadView(
  taskId: string,
  plan: BarterPlan,
  start?: { fishId: string; name: string; biomeId: string | null } | null,
): BarterHeadView {
  const base = {
    taskId,
    startFishId: start?.fishId ?? null,
    startFishName: start?.name ?? null,
    startBiomeCode: start?.biomeId ? biomeCode(start.biomeId) : null,
    startBiomeName: start?.biomeId ? biomeNameOf(start.biomeId) : null,
  };
  return plan.ok
    ? { ...base, reachable: true, hops: toHopViews(plan.hops), reason: null }
    : { ...base, reachable: false, hops: [], reason: plan.reason };
}

/** 目标判定：命中任意一个目标规格就算达成（老任务的单目标也走这里） */
export function taskTargetMatcher(task: Pick<BarterTaskRow, "target_specs">) {
  return specsMatcher(task.target_specs);
}

export function buildBarterView(input: {
  tasks: BarterTaskRow[];
  inventory: InventoryFish[];
  content: unknown;
  masteryOverview?: unknown;
  moduleEnabled: boolean;
  moduleRunning: boolean;
  head?: { taskId: string; plan: BarterPlan; start?: { fishId: string; name: string; biomeId: string | null } | null } | null;
  maxSpecs: number;
}): BarterView {
  const masteryTargets = masteryTargetFishIds(input.masteryOverview);
  return {
    module: { enabled: input.moduleEnabled, running: input.moduleRunning },
    limits: {
      maxOpenTasks: MAX_OPEN_TASKS,
      maxQuantity: MAX_TASK_QUANTITY,
      maxSpecs: input.maxSpecs,
      rarities: BARTER_RARITIES.map((r) => ({ value: r, label: rarityLabel(r) })),
    },
    rarityHint: BARTER_RARITY_HINT,
    tasks: input.tasks.map(toTaskView),
    startOptions: pickStartMapOptions({ inventory: input.inventory, content: input.content, masteryTargets }),
    targetOptions: pickTargetMapOptions(input.content),
    head: input.head ? toHeadView(input.head.taskId, input.head.plan, input.head.start ?? null) : null,
  };
}
