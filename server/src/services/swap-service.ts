// 交换助手：扫描全市场交换单 → 找出能换到专精目标的链 → 手动执行
//
// 移植自浏览器脚本《专精交换助手 v1.2.0》，但把三件事换成了服务端现成的能力：
//  · 认证/签名 → 账号运行时里的签名客户端（还自带每账号代理、自动重登）；
//  · 面板 UI   → 「交换助手」页（左侧菜单）；
//  · 浏览器内存 → 每个账号一份状态（内存：扫描结果 + 执行进度 + 日志）。
//
// 两种动手方式，都是用户主动点的：
//  · 单条：页面展开明细后「只执行这一条」（一次把这条链走完）；
//  · 批量：「换 N 条」= 按筛选反复挑能走通的链，直到换到 N 条或走不动为止。
//    批量放后台跑（一串链最多几十次请求，挂在页面请求里会超时），进度与日志由页面轮询。
import type { Repos } from "../db/repositories/index.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { Logger } from "../lib/logger.ts";
import { HttpError } from "../api/server.ts";
import { biomeCode, biomeName, biomeRank } from "../modules/shared/biomes.ts";
import { rarityLabel } from "../modules/shared/rarity.ts";
import { barterErrorMessage, barterNextCursor, normalizeBarterOrders, type BarterFish, type BarterOrder } from "./barter-orders.ts";
import {
  SWAP_MAX_LENGTH,
  buildSwapGraph,
  isSwapPathFeasible,
  readSwapInventory,
  readSwapTargets,
  searchSwapPaths,
  type SwapHop,
  type SwapPath,
  type SwapTarget,
} from "./swap-plan.ts";

/** 每页拉多少张交换单（游戏上限 100） */
const SWAP_PAGE_LIMIT = 50;
/** 最多翻几页（40 × 50 = 最多 2000 张单） */
const SWAP_MAX_PAGES = 40;
/** 一次执行最多几跳（与搜索上限一致） */
export const SWAP_EXECUTE_MAX_HOPS = SWAP_MAX_LENGTH;
/** 一次「换 N 条」最多换几条（防止一次点掉太多鱼） */
export const SWAP_MAX_QUANTITY = 10;
/** 面板日志保留条数 */
const SWAP_LOG_LIMIT = 200;

export type SwapHopInput = { orderId: string; requestFishId: string; offerFishId: string };

/** 筛选条件：稀有度 / 地图 / 具体目标鱼（都是可选，空 = 不限） */
export type SwapFilter = {
  rarity?: string | null;
  biomeId?: string | null;
  targetFishId?: string | null;
  /** true = 去掉「从高等级地图换到低等级地图」的链 */
  onlyUpgrade?: boolean;
};

export type SwapFishView = {
  fishId: string;
  name: string;
  /** `B2` 这种简称（面板与日志都按它显示地图） */
  biomeCode: string | null;
  biomeName: string | null;
  rarity: string;
  rarityLabel: string;
};

export type SwapHopView = {
  orderId: string;
  owner: string | null;
  capacity: number;
  give: SwapFishView;
  get: SwapFishView;
};

export type SwapPathView = {
  /** 稳定 key：目标 + 跳数 + 每一跳的单 id */
  key: string;
  targetFishId: string;
  length: number;
  /** 起点鱼所在地图（面板按它判断升 / 降级） */
  startBiomeId: string | null;
  startBiomeCode: string | null;
  /** 目标鱼完整信息：面板不再自己去 targets 里"按 fishId 找"（同一鱼种可能是多张图的专精目标，会找错） */
  target: {
    fishId: string;
    name: string;
    rarity: string;
    rarityLabel: string;
    biomeId: string | null;
    biomeCode: string | null;
    biomeName: string | null;
    /** 这个目标还差几条 */
    remaining: number;
  };
  /** 目标地图等级 ≥ 起点地图等级（false = 高换低） */
  upgrade: boolean;
  hops: SwapHopView[];
};

/** 目标下拉里的一项：名称 + 地图 + 还差几条 + 当前筛选下有几条链 */
export type SwapTargetView = {
  fishId: string;
  name: string;
  rarity: string;
  rarityLabel: string;
  biomeId: string | null;
  biomeCode: string | null;
  biomeName: string | null;
  /** 专精还差几条 */
  remaining: number;
  /** 背包里现在有几条 */
  available: number;
  /** 当前筛选下这个目标有几条可行链 */
  pathCount: number;
};

/** 扫描结果（已按请求里的筛选条件收好：下拉候选、目标、链、计数都来自同一份数据） */
export type SwapScanResult = {
  stats: {
    orders: number;
    edges: number;
    targets: number;
    paths: number;
    pages: number;
    /** 达到翻页上限、可能还有没扫到的单 */
    truncated: boolean;
    scannedAt: number;
  };
  /** 下拉候选项（稀有度全列；地图跟着已选稀有度收窄） */
  options: {
    rarities: { value: string; label: string }[];
    biomes: { value: string; label: string }[];
  };
  /** 当前筛选下**真有链**的目标（没链的不列出来） */
  targets: SwapTargetView[];
  /** 当前筛选下的可行链（跳数少的在前） */
  paths: SwapPathView[];
  counts: {
    /** 本次扫描一共找到多少条链 */
    totalPaths: number;
    /** 当前筛选命中多少条链 */
    matchedPaths: number;
    /** 一共多少个专精目标 */
    totalTargets: number;
    /** 其中「有可行链」的目标数（不受稀有度/地图/升降级筛选影响） */
    chainTargets: number;
    /** 当前筛选命中的目标数 */
    matchedTargets: number;
    /** 完全没有可行链的目标数 */
    hopless: number;
    /** 有链、但被当前筛选挡住的目标数 */
    filteredTargets: number;
  };
};

export type SwapLogEntry = {
  t: number;
  level: "info" | "warn" | "error";
  text: string;
};

/** 批量「换 N 条」的进度 */
export type SwapRunView = {
  status: "idle" | "running" | "done" | "stopped";
  /** 本次打算换到几条 */
  targetCount: number;
  /** 已经换到几条 */
  doneCount: number;
  /** 当前正在走什么（人类可读；没在跑就是 null） */
  current: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 结束时的说明（换够 / 没得换了 / 被叫停） */
  note: string | null;
};

export type SwapStateView = {
  status: "idle" | "scanning" | "ready" | "error";
  progress: { phase: string; pages: number; orders: number };
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 执行过之后数据就旧了（单子剩余量与背包都变了）：面板提示重新扫描 */
  stale: boolean;
  result: SwapScanResult | null;
  run: SwapRunView;
  /** 面板下方的日志（最近的在前，最多 200 条） */
  log: SwapLogEntry[];
};

export type SwapExecuteResult = {
  ok: boolean;
  /** 成功走了几跳 */
  done: number;
  steps: { index: number; orderId: string; ok: boolean; error?: string }[];
  error?: string;
};

const fishView = (fish: BarterFish): SwapFishView => ({
  fishId: fish.fishId,
  name: fish.name,
  biomeCode: fish.biomeId ? biomeCode(fish.biomeId) : null,
  biomeName: fish.biomeId ? biomeName(fish.biomeId) : null,
  rarity: fish.rarity,
  rarityLabel: fish.rarity ? rarityLabel(fish.rarity) : "",
});

const hopView = (hop: SwapHop): SwapHopView => ({
  orderId: hop.orderId,
  owner: hop.ownerNickname,
  capacity: hop.capacity,
  give: fishView(hop.give),
  get: fishView(hop.get),
});

const pathView = (path: SwapPath): SwapPathView => {
  const startBiome = path.hops[0]?.give.biomeId ?? null;
  const targetBiome = path.target.biomeId;
  const startRank = biomeRank(startBiome);
  const targetRank = biomeRank(targetBiome);
  return {
    key: `${path.target.fishId}|${path.length}|${path.hops.map((h) => h.orderId).join(",")}`,
    targetFishId: path.target.fishId,
    length: path.length,
    startBiomeId: startBiome,
    startBiomeCode: startBiome ? biomeCode(startBiome) : null,
    target: {
      fishId: path.target.fishId,
      name: path.target.name,
      rarity: path.target.rarity,
      rarityLabel: path.target.rarity ? rarityLabel(path.target.rarity) : "",
      biomeId: targetBiome,
      biomeCode: targetBiome ? biomeCode(targetBiome) : null,
      biomeName: targetBiome ? biomeName(targetBiome) : null,
      remaining: path.target.remaining,
    },
    // 地图认不出来时不做升降级判断（宁可放行，也不要静默藏掉链）
    upgrade: startRank < 0 || targetRank < 0 ? true : targetRank >= startRank,
    hops: path.hops.map(hopView),
  };
};

/** 这条链是不是「往更高（或同级）等级的地图换」；地图认不出来时不拦 */
function isUpgradePath(path: SwapPath): boolean {
  const startRank = biomeRank(path.hops[0]?.give.biomeId ?? null);
  const targetRank = biomeRank(path.target.biomeId);
  if (startRank < 0 || targetRank < 0) return true;
  return targetRank >= startRank;
}

const targetView = (target: SwapTarget, pathCount: number): SwapTargetView => ({
  fishId: target.fishId,
  name: target.name,
  rarity: target.rarity,
  rarityLabel: target.rarity ? rarityLabel(target.rarity) : "",
  biomeId: target.biomeId,
  biomeCode: target.biomeId ? biomeCode(target.biomeId) : null,
  biomeName: target.biomeId ? biomeName(target.biomeId) : null,
  remaining: target.remaining,
  available: target.available,
  pathCount,
});

/** 链里出现过的目标（按鱼种去重） */
function uniqueTargets(paths: SwapPath[]): SwapTarget[] {
  const map = new Map<string, SwapTarget>();
  for (const path of paths) {
    if (!map.has(path.target.fishId)) map.set(path.target.fishId, path.target);
  }
  return [...map.values()];
}

const idleRun = (): SwapRunView => ({  status: "idle",
  targetCount: 0,
  doneCount: 0,
  current: null,
  startedAt: null,
  finishedAt: null,
  note: null,
});

const idleState = (): SwapStateView => ({
  status: "idle",
  progress: { phase: "", pages: 0, orders: 0 },
  error: null,
  startedAt: null,
  finishedAt: null,
  stale: false,
  result: null,
  run: idleRun(),
  log: [],
});

type Entry = {
  accountId: string;
  /** 近期调用方的用户 id（日志要带上，用户才能在「运行日志」里看到自己的操作） */
  userId: string | null;
  state: SwapStateView;
  /** 扫描得到的原始链与目标（执行时要按它们判可行性；state 里存的是给页面看的视图） */
  rawPaths: SwapPath[];
  rawTargets: SwapTarget[];
  /** 扫描 / 批量执行是否正在跑（避免重复启动） */
  scanning: boolean;
  running: boolean;
  /** 用户点了「停止」：批量循环下一轮就退出 */
  stopRun: boolean;
  /** 本次批量执行里已经失败过的单（被抢走 / 过期），不再拿它组链 */
  deadOrders: Set<string>;
};

export class SwapService {
  private readonly deps: { repos: Repos; registry: RunnerRegistry; logger: Logger };
  /** 每个账号一份状态（内存即可：结果随时可用新扫描覆盖） */
  private readonly entries = new Map<string, Entry>();

  constructor(deps: { repos: Repos; registry: RunnerRegistry; logger: Logger }) {
    this.deps = deps;
  }

  /** 当前状态（账号没扫过就是一个 idle）；筛选条件在这里应用，列表 / 下拉 / 计数同源 */
  state(userId: string, accountId: string, filter: SwapFilter = {}): SwapStateView {
    this.requireOwnAccount(userId, accountId);
    const entry = this.entry(accountId);
    const base = entry.state.result;
    if (!base) return entry.state;
    return { ...entry.state, result: this.buildResult(entry, filter, base.stats) };
  }

  /** 开始一次扫描；已经在扫就直接返回当前状态（不重复起任务） */
  start(userId: string, accountId: string): SwapStateView {
    this.requireOwnAccount(userId, accountId);
    const entry = this.entry(accountId);
    if (entry.scanning) return entry.state;

    entry.state = {
      ...entry.state,
      status: "scanning",
      progress: { phase: "准备中", pages: 0, orders: 0 },
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    entry.scanning = true;
    this.log(entry, "info", "开始扫描全市场交换单…");
    void this.scan(accountId, entry);
    return entry.state;
  }

  /**
   * 执行一条链（页面展开明细后「只执行这一条」）。
   *
   * 每一步都先确认「要交出的鱼还在背包里」，失败就停在那一步并如实报出来 ——
   * 半路停下时前面几跳已经成交，不能假装整体失败。
   */
  async execute(userId: string, accountId: string, hops: SwapHopInput[]): Promise<SwapExecuteResult> {
    this.requireOwnAccount(userId, accountId);
    if (!Array.isArray(hops) || hops.length === 0) {
      throw new HttpError(400, "SWAP_NO_HOPS", "没有要执行的交换步骤");
    }
    if (hops.length > SWAP_EXECUTE_MAX_HOPS) {
      throw new HttpError(400, "SWAP_TOO_MANY_HOPS", `一次最多走 ${SWAP_EXECUTE_MAX_HOPS} 跳`);
    }

    const entry = this.entry(accountId);
    const rt = this.deps.registry.require(accountId);
    const result = await this.walkChain(rt, entry, hops);
    return result.view;
  }

  /**
   * 批量「换 N 条」：按筛选反复挑能走通的链，直到换到 N 条或走不动为止。
   *
   * 立刻返回进度对象，真正的循环在后台跑（页面轮询状态里的 run 与 log）。
   */
  run(
    userId: string,
    accountId: string,
    opts: { quantity?: number } & SwapFilter,
  ): SwapStateView {
    this.requireOwnAccount(userId, accountId);
    const entry = this.entry(accountId);
    if (entry.running) return entry.state;

    const paths = this.filterPaths(entry, opts);
    if (!paths.length) {
      throw new HttpError(400, "SWAP_NO_PATH", "当前筛选下没有可走的交换链（换个筛选，或重新扫描）");
    }

    // 目标还差多少就换多少：免得换多了浪费（筛选里指定了目标时只算那一个）
    const wanted = Math.floor(Number(opts.quantity) || 1);
    const remainingTotal = this.remainingOf(entry, opts);
    const targetCount = Math.max(1, Math.min(wanted, remainingTotal, SWAP_MAX_QUANTITY));

    entry.stopRun = false;
    entry.deadOrders.clear();
    entry.state = {
      ...entry.state,
      run: {
        status: "running",
        targetCount,
        doneCount: 0,
        current: null,
        startedAt: Date.now(),
        finishedAt: null,
        note: null,
      },
    };
    entry.running = true;
    const filterText = this.filterText(opts);
    this.log(
      entry,
      "info",
      `开始换 ${targetCount} 条${filterText ? `（${filterText}）` : ""}${targetCount < wanted ? `：目标只差这么多，已按 ${targetCount} 条算` : ""}`,
    );
    void this.runBatch(accountId, entry, opts, targetCount);
    return entry.state;
  }

  /** 停止批量执行（循环会在下一跳之前退出） */
  stop(userId: string, accountId: string): SwapStateView {
    this.requireOwnAccount(userId, accountId);
    const entry = this.entry(accountId);
    if (entry.running) {
      entry.stopRun = true;
      this.log(entry, "warn", "已请求停止：当前这一跳走完就停");
    }
    return entry.state;
  }

  /* ---------------- 内部：扫描 ---------------- */

  private async scan(accountId: string, entry: Entry): Promise<void> {
    const rt = this.deps.registry.require(accountId);
    try {
      // 1) 拉全部交换单（不是只拉"我能响应的"：长链要靠中间环节的单串起来）
      const orders: BarterOrder[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      let truncated = false;
      for (let i = 0; i < SWAP_MAX_PAGES; i++) {
        const resp = await rt.client.barterOrders({
          limit: SWAP_PAGE_LIMIT,
          canFulfill: false,
          offersMastery: false,
          ...(cursor ? { cursor } : {}),
        });
        pages = i + 1;
        for (const order of normalizeBarterOrders(resp)) {
          if (order.status !== "active" || seen.has(order.id)) continue;
          seen.add(order.id);
          orders.push(order);
        }
        entry.state = { ...entry.state, progress: { phase: "拉取交换单", pages, orders: orders.length } };
        cursor = barterNextCursor(resp);
        if (!cursor) break;
        truncated = i === SWAP_MAX_PAGES - 1;
      }

      // 2) 专精目标 + 背包
      entry.state = { ...entry.state, progress: { phase: "读取专精进度与背包", pages, orders: orders.length } };
      const [mastery, inv] = await Promise.all([
        rt.client.mastery().catch(() => null),
        rt.client.inventoryFish().catch(() => null),
      ]);
      if (!mastery || !inv) throw new Error("读不到专精进度或背包（账号可能还没连上游戏）");

      const inventory = readSwapInventory(inv);
      const targets = readSwapTargets(mastery, inventory);
      const graph = buildSwapGraph(orders);
      const paths = searchSwapPaths({ graph, inventory, targets });
      entry.rawPaths = paths;
      entry.rawTargets = targets;

      const stats = {
        orders: orders.length,
        edges: graph.edges,
        targets: targets.length,
        paths: paths.length,
        pages,
        truncated,
        scannedAt: Date.now(),
      };
      entry.state = {
        ...entry.state,
        status: "ready",
        progress: { phase: "完成", pages, orders: orders.length },
        error: null,
        finishedAt: Date.now(),
        stale: false,
        // 先放一份「不带筛选」的结果（面板下一次拉取会按自己的筛选重算）
        result: this.buildResult(entry, {}, stats),
      };
      this.log(
        entry,
        "info",
        `扫描完成：${orders.length} 张单 / ${graph.edges} 条边 / ${targets.length} 个专精目标 / ${paths.length} 条可行链` +
          (truncated ? `（已翻满 ${SWAP_MAX_PAGES} 页，可能还有没扫到的单）` : ""),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.state = { ...entry.state, status: "error", error: msg, finishedAt: Date.now() };
      this.log(entry, "error", `扫描失败：${msg}`);
    } finally {
      entry.scanning = false;
    }
  }

  /* ---------------- 内部：执行 ---------------- */

  /** 走完一条链：每一跳前确认鱼还在背包里，失败即停 */
  private async walkChain(
    rt: { client: { inventoryFish(): Promise<unknown>; barterFill(orderId: string, body: { requestFishId: string; offerFishId: string }): Promise<unknown> } },
    entry: Entry,
    hops: SwapHopInput[],
  ): Promise<{ view: SwapExecuteResult; failedOrderId: string | null }> {
    const inventory = readSwapInventory(await rt.client.inventoryFish());
    const steps: SwapExecuteResult["steps"] = [];

    for (const [i, hop] of hops.entries()) {
      const have = inventory.get(hop.requestFishId) ?? 0;
      const fail = (text: string): { view: SwapExecuteResult; failedOrderId: string | null } => {
        steps.push({ index: i + 1, orderId: hop.orderId, ok: false, error: text });
        this.markStale(entry);
        return { view: { ok: false, done: i, steps, error: `第 ${i + 1} 步：${text}` }, failedOrderId: hop.orderId };
      };

      if (have < 1) return fail("这条鱼已经不在背包里了（可能被别的功能卖掉或用掉了）");

      try {
        await rt.client.barterFill(hop.orderId, {
          requestFishId: hop.requestFishId,
          offerFishId: hop.offerFishId,
        });
      } catch (err) {
        return fail(`${barterErrorMessage(err)}（这张单可能已被撤销、完成或被别人抢先）`);
      }

      inventory.set(hop.requestFishId, have - 1);
      inventory.set(hop.offerFishId, (inventory.get(hop.offerFishId) ?? 0) + 1);
      steps.push({ index: i + 1, orderId: hop.orderId, ok: true });
    }

    this.markStale(entry);
    this.log(entry, "info", `✅ 走完一条 ${hops.length} 跳的交换链`);
    return { view: { ok: true, done: hops.length, steps }, failedOrderId: null };
  }

  /** 批量循环：反复挑链、走链，直到换够 / 没得换 / 被停止 */
  private async runBatch(accountId: string, entry: Entry, opts: { quantity?: number } & SwapFilter, targetCount: number): Promise<void> {
    const rt = this.deps.registry.require(accountId);
    let done = 0;
    let note: string | null = null;

    try {
      while (done < targetCount) {
        if (entry.stopRun) {
          note = `已停止（换到 ${done}/${targetCount} 条）`;
          break;
        }

        const inventory = readSwapInventory(await rt.client.inventoryFish());
        const candidates = this.filterPaths(entry, opts).filter(
          (path) => !path.hops.some((h) => entry.deadOrders.has(h.orderId)) && isSwapPathFeasible(path.hops, inventory),
        );
        if (!candidates.length) {
          note = `没有可走的链了（换到 ${done}/${targetCount} 条）`;
          break;
        }

        const chain = candidates[0]!;
        const text = this.chainText(chain);
        entry.state = {
          ...entry.state,
          run: { ...entry.state.run, current: `第 ${done + 1}/${targetCount} 条：${text}` },
        };

        const hops: SwapHopInput[] = chain.hops.map((h) => ({
          orderId: h.orderId,
          requestFishId: h.give.fishId,
          offerFishId: h.get.fishId,
        }));
        const r = await this.walkChain(rt, entry, hops);
        if (!r.view.ok) {
          // 这一跳失败了：把那张单拉黑，换下一条候选链继续（不是整轮结束）
          if (r.failedOrderId) entry.deadOrders.add(r.failedOrderId);
          this.log(entry, "warn", `${text} 失败：${r.view.error ?? "未知原因"}（已换 ${r.view.done} 跳，换下一条链）`);
          entry.state = { ...entry.state, run: { ...entry.state.run, doneCount: done } };
          // 全部候选都被拉黑时上面那段 candidates 为空会自然收尾，这里防止死循环
          if (this.filterPaths(entry, opts).every((p) => p.hops.some((h) => entry.deadOrders.has(h.orderId)))) {
            note = `能走的链都被抢走了（换到 ${done}/${targetCount} 条）`;
            break;
          }
          continue;
        }

        done += 1;
        entry.state = {
          ...entry.state,
          run: { ...entry.state.run, doneCount: done, current: null },
        };
        this.log(entry, "info", `${text} ✅ 换到第 ${done}/${targetCount} 条`);
      }

      entry.state = {
        ...entry.state,
        run: {
          ...entry.state.run,
          status: entry.stopRun ? "stopped" : done >= targetCount ? "done" : "stopped",
          doneCount: done,
          current: null,
          finishedAt: Date.now(),
          note: note ?? (done >= targetCount ? `换够 ${targetCount} 条` : null),
        },
      };
      if (note) this.log(entry, "warn", note);
      else this.log(entry, "info", `批量执行结束：换到 ${done}/${targetCount} 条`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.state = {
        ...entry.state,
        run: { ...entry.state.run, status: "stopped", doneCount: done, current: null, finishedAt: Date.now(), note: msg },
      };
      this.log(entry, "error", `批量执行中断：${msg}`);
    } finally {
      entry.running = false;
    }
  }

  /* ---------------- 内部：筛选 / 文案 ---------------- */

  /** 按筛选条件挑出可行链（扫描时已经按「跳数 → 目标稀有度」排好序） */
  private filterPaths(entry: Entry, filter: SwapFilter): SwapPath[] {
    return entry.rawPaths.filter((p) => {
      if (filter.targetFishId && p.target.fishId !== filter.targetFishId) return false;
      if (filter.rarity && p.target.rarity !== filter.rarity) return false;
      if (filter.biomeId && p.target.biomeId !== filter.biomeId) return false;
      if (filter.onlyUpgrade && !isUpgradePath(p)) return false;
      return true;
    });
  }

  private filterText(filter: SwapFilter): string {
    const parts: string[] = [];
    if (filter.rarity) parts.push(`${rarityLabel(filter.rarity)}`);
    if (filter.biomeId) parts.push(`目标图 ${biomeCode(filter.biomeId) ?? filter.biomeId}`);
    if (filter.targetFishId) parts.push(`目标鱼 ${filter.targetFishId}`);
    if (filter.onlyUpgrade) parts.push("只要不降级的地图");
    return parts.join(" / ");
  }

  /** 筛选命中的目标「还差几条」之和（决定批量最多换几条） */
  private remainingOf(entry: Entry, filter: SwapFilter): number {
    const hit = new Set(this.filterPaths(entry, filter).map((p) => p.target.fishId));
    const sum = entry.rawTargets.filter((t) => hit.has(t.fishId)).reduce((acc, t) => acc + Math.max(1, t.remaining), 0);
    return sum || 1;
  }

  /**
   * 按筛选条件组装结果视图。
   *
   * ★ 列表、下拉候选、计数全部从**这一份**数据算出来 —— 面板不再自己过滤，
   *   否则「数字说 9 条、列表却列了一堆」这种不一致迟早会出现（已经踩过一次）。
   */
  private buildResult(entry: Entry, filter: SwapFilter, stats: SwapScanResult["stats"]): SwapScanResult {
    const all = entry.rawPaths;
    const matched = this.filterPaths(entry, filter);

    // 有链的目标（不看筛选）：稀有度候选项用它；地图候选项跟着已选稀有度收窄
    const chainTargets = uniqueTargets(all);
    const rarityMap = new Map<string, string>();
    for (const t of chainTargets) rarityMap.set(t.rarity, t.rarity ? rarityLabel(t.rarity) : t.rarity);
    const biomeMap = new Map<string, string>();
    for (const t of chainTargets) {
      if (filter.rarity && t.rarity !== filter.rarity) continue;
      if (!t.biomeId) continue;
      biomeMap.set(t.biomeId, `${biomeCode(t.biomeId) ?? ""} ${biomeName(t.biomeId) ?? ""}`.trim() || t.biomeId);
    }

    // 当前筛选命中的目标（下拉框只列这些，并带上条数）
    const count = new Map<string, number>();
    for (const path of matched) count.set(path.target.fishId, (count.get(path.target.fishId) ?? 0) + 1);
    const targets = uniqueTargets(matched).map((t) => targetView(t, count.get(t.fishId) ?? 0));

    return {
      stats,
      options: {
        rarities: [...rarityMap.entries()].map(([value, label]) => ({ value, label })),
        biomes: [...biomeMap.entries()].map(([value, label]) => ({ value, label })),
      },
      targets,
      paths: matched.map(pathView),
      counts: {
        totalPaths: all.length,
        matchedPaths: matched.length,
        totalTargets: entry.rawTargets.length,
        chainTargets: chainTargets.length,
        matchedTargets: targets.length,
        hopless: entry.rawTargets.length - chainTargets.length,
        filteredTargets: chainTargets.length - targets.length,
      },
    };
  }

  /** 一条链的人话：B2 雾语灯笼鱼 → B3 镜潮银鲷 → B5 星根盲鳗（2 跳） */
  private chainText(path: SwapPath): string {
    const text = (fish: BarterFish) => `${fish.biomeId ? (biomeCode(fish.biomeId) ?? "") : ""} ${fish.name}`.trim();
    const names = [text(path.hops[0]!.give), ...path.hops.map((h) => text(h.get))];
    return `${names.join(" → ")}（${path.length} 跳）`;
  }

  /** 写一条日志：面板下方那份 + 账号运行日志（带上 userId，用户自己能看到） */
  private log(entry: Entry, level: SwapLogEntry["level"], text: string): void {
    const list = [{ t: Date.now(), level, text }, ...entry.state.log];
    entry.state = { ...entry.state, log: list.slice(0, SWAP_LOG_LIMIT) };
    const child = this.deps.logger.child({ userId: entry.userId, accountId: entry.accountId });
    if (level === "error") child.error("交换助手", text);
    else if (level === "warn") child.warn("交换助手", text);
    else child.info("交换助手", text);
  }

  private entry(accountId: string): Entry {
    const hit = this.entries.get(accountId);
    if (hit) return hit;
    const created: Entry = {
      accountId,
      userId: null,
      state: idleState(),
      rawPaths: [],
      rawTargets: [],
      scanning: false,
      running: false,
      stopRun: false,
      deadOrders: new Set(),
    };
    this.entries.set(accountId, created);
    return created;
  }

  /** 执行过之后把结果标成过期（面板据此提示"建议重新扫描"） */
  private markStale(entry: Entry): void {
    if (entry.state.result) entry.state = { ...entry.state, stale: true };
  }

  private requireOwnAccount(userId: string, accountId: string): void {
    const row = this.deps.repos.accounts.findById(accountId);
    if (!row || row.user_id !== userId) {
      throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在或不属于你");
    }
    this.entry(accountId).userId = userId;
  }
}
