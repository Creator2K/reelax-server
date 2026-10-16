// 以物易物面板数据组装（纯函数，便于单测）
//
// 数据来源：
//  · `/api/inventory/fish` —— 我手上有什么、剩几条、有没有被锁；
//  · `/api/content/bootstrap` —— 鱼定义（稀有度 / 所属地图），背包条目不一定带这些字段；
//  · `/api/mastery` —— 当前每条地图 × 稀有度的专精目标鱼（这些鱼不拿去换）；
//  · `barter_tasks` 表 —— 队列本身。
//
// 与「地图与天气」「船队」两块面板保持一致：服务端把已经算好的、可以直接渲染的数据发下去，
// 前端不做业务判断（除了「选了哪种起点鱼 → 只看同稀有度的目标」这一处纯展示过滤）。
import { rarityLabel, rarityRank } from "../modules/shared/rarity.ts";
import { biomeName as biomeNameOf } from "../modules/shared/biomes.ts";
import { BARTER_RARITIES, isBarterRarity, type BarterFish, type BarterHop, type BarterPlan } from "./barter-plan.ts";
import type { BarterTaskRow, BarterTaskStatus } from "../db/repositories/barter-tasks.ts";

/** 队列里最多同时存在几个未结束的任务 */
export const MAX_OPEN_TASKS = 5;
/** 单条任务的目标条数上限 */
export const MAX_TASK_QUANTITY = 99;

export type BarterStartCandidate = {
  fishId: string;
  name: string;
  biomeId: string | null;
  biomeName: string | null;
  rarity: string;
  rarityLabel: string;
  quantity: number;
};

export type BarterFishOption = {
  id: string;
  name: string;
  biomeId: string;
  /** 地图中文名（服务端解析好，前端不用自己维护一份映射） */
  biomeName: string | null;
  rarity: string;
};

export type BarterTaskView = {
  id: string;
  fromFishId: string;
  fromFishName: string;
  fromBiomeId: string | null;
  fromBiomeName: string | null;
  rarity: string;
  rarityLabel: string;
  quantity: number;
  doneQuantity: number;
  targetBiomeId: string;
  targetBiomeName: string | null;
  targetFishId: string | null;
  targetFishName: string | null;
  status: BarterTaskStatus;
  statusText: string;
  lastNote: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BarterHopView = {
  orderId: string;
  owner: string | null;
  giveFishId: string;
  giveName: string;
  giveBiomeName: string | null;
  getFishId: string;
  getName: string;
  getBiomeName: string | null;
  remaining: number;
};

export type BarterHeadView = {
  taskId: string;
  reachable: boolean;
  hops: BarterHopView[];
  /** 走不通时的原因（面板原样展示） */
  reason: string | null;
};

export type BarterView = {
  /** 功能开关状态：没开的时侯队列只是「存着」，面板要说清楚 */
  module: { enabled: boolean; running: boolean };
  limits: { maxOpenTasks: number; maxQuantity: number; rarities: string[] };
  /** 以物易物支持的稀有度说明（面板顶部一句提示） */
  rarityHint: string;
  tasks: BarterTaskView[];
  /** 可以作为起点交出去的鱼（已排除专精鱼 / 锁定鱼 / 非最高三档） */
  start: BarterStartCandidate[];
  /** 目标鱼候选（按地图 + 稀有度筛选用；只带必要字段，避免把整份内容表发下去） */
  fish: BarterFishOption[];
  /** 队首任务当前能不能走通（打开面板时现算一次） */
  head: BarterHeadView | null;
};

export const BARTER_RARITY_HINT =
  `以物易物只支持 ${BARTER_RARITIES.map((r) => rarityLabel(r)).join(" / ")} 三档稀有度，` +
  "且同一张交换单里的鱼必须同稀有度，所以整条交换链都留在起点鱼的稀有度里。";

export function barterTaskStatusText(status: BarterTaskStatus): string {  switch (status) {
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

/** 任务目标的中文说法（日志与面板共用） */
export function taskTargetText(task: Pick<BarterTaskRow, "target_biome_id" | "target_fish_id" | "target_fish_name">): string {
  const biome = biomeNameOf(task.target_biome_id) ?? task.target_biome_id;
  return task.target_fish_id ? task.target_fish_name || task.target_fish_id : `${biome}的任意同稀有度鱼`;
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

/** 可以作为起点的鱼：背包里有的、未锁定的、不是专精目标鱼、且属于最高三档稀有度 */
export function pickStartCandidates(input: {
  inventory: InventoryFish[];
  content?: unknown;
  masteryTargets?: Set<string>;
}): BarterStartCandidate[] {
  const defs = contentMap(readContentFish(input.content));
  const mastery = input.masteryTargets ?? new Set<string>();
  const out: BarterStartCandidate[] = [];
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
      biomeName: def?.biomeId ? biomeNameOf(def.biomeId) : null,
      rarity,
      rarityLabel: rarityLabel(rarity),
      quantity: item.quantity,
    });
  }
  // 按稀有度从低到高（神话 → 奇异 → 奥秘）、同档按名称排序：界面顺序稳定，
  // 也让「越值钱的越靠后」这件事看得出来
  out.sort(
    (a, b) =>
      rarityRank(a.rarity) - rarityRank(b.rarity) ||
      a.name.localeCompare(b.name, "zh-CN") ||
      a.fishId.localeCompare(b.fishId),
  );
  return out;
}

/** 目标鱼候选：只保留最高三档的鱼（前端再按「起点鱼稀有度 + 地图」过滤） */
export function pickFishCatalog(content: unknown): BarterFishOption[] {
  const out: BarterFishOption[] = [];
  for (const f of readContentFish(content)) {
    if (!f.biomeId) continue;
    if (!isBarterRarity(f.rarity)) continue;
    out.push({ id: f.id, name: f.name, biomeId: f.biomeId, biomeName: biomeNameOf(f.biomeId), rarity: f.rarity });
  }
  out.sort((a, b) => a.biomeId.localeCompare(b.biomeId) || a.name.localeCompare(b.name, "zh-CN"));
  return out;
}

/* ---------------- 任务与路径 ---------------- */

export function toTaskView(row: BarterTaskRow): BarterTaskView {
  return {
    id: row.id,
    fromFishId: row.from_fish_id,
    fromFishName: row.from_fish_name || row.from_fish_id,
    fromBiomeId: row.from_biome_id,
    fromBiomeName: row.from_biome_id ? biomeNameOf(row.from_biome_id) : null,
    rarity: row.rarity,
    rarityLabel: rarityLabel(row.rarity),
    quantity: row.quantity,
    doneQuantity: row.done_quantity,
    targetBiomeId: row.target_biome_id,
    targetBiomeName: biomeNameOf(row.target_biome_id),
    targetFishId: row.target_fish_id,
    targetFishName: row.target_fish_name || null,
    status: row.status,
    statusText: barterTaskStatusText(row.status),
    lastNote: row.last_note,
    lastError: row.last_error,
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
    giveBiomeName: h.give.biomeId ? biomeNameOf(h.give.biomeId) : null,
    getFishId: h.get.fishId,
    getName: h.get.name,
    getBiomeName: h.get.biomeId ? biomeNameOf(h.get.biomeId) : null,
    remaining: h.capacity,
  }));
}

export function toHeadView(taskId: string, plan: BarterPlan): BarterHeadView {
  return plan.ok
    ? { taskId, reachable: true, hops: toHopViews(plan.hops), reason: null }
    : { taskId, reachable: false, hops: [], reason: plan.reason };
}

/** 判断某个鱼种是否是某条任务的目标（地图 + 可选具体鱼种） */
export function taskTargetMatcher(task: Pick<BarterTaskRow, "target_biome_id" | "target_fish_id">) {
  const biome = task.target_biome_id;
  const fishId = task.target_fish_id;
  return (fish: BarterFish): boolean => {
    if (fishId) return fish.fishId === fishId;
    return fish.biomeId === biome;
  };
}

export function buildBarterView(input: {
  tasks: BarterTaskRow[];
  inventory: InventoryFish[];
  content: unknown;
  masteryOverview?: unknown;
  moduleEnabled: boolean;
  moduleRunning: boolean;
  head?: { taskId: string; plan: BarterPlan } | null;
}): BarterView {
  return {
    module: { enabled: input.moduleEnabled, running: input.moduleRunning },
    limits: { maxOpenTasks: MAX_OPEN_TASKS, maxQuantity: MAX_TASK_QUANTITY, rarities: [...BARTER_RARITIES] },
    rarityHint: BARTER_RARITY_HINT,
    tasks: input.tasks.map(toTaskView),
    start: pickStartCandidates({
      inventory: input.inventory,
      content: input.content,
      masteryTargets: masteryTargetFishIds(input.masteryOverview),
    }),
    fish: pickFishCatalog(input.content),
    head: input.head ? toHeadView(input.head.taskId, input.head.plan) : null,
  };
}
