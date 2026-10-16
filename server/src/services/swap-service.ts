// 交换助手：扫描全市场交换单 → 找出能换到专精目标的链 → 按用户手动执行
//
// 移植自浏览器脚本《专精交换助手 v1.2.0》，但把三件事换成了服务端现成的能力：
//  · 认证/签名 → 账号运行时里的签名客户端（还自带每账号代理、自动重登）；
//  · 面板 UI   → 「交换助手」页（左侧菜单）；
//  · 浏览器内存 → 每个账号一份扫描状态（内存，可反复扫描覆盖）。
//
// 为什么扫描要异步：一张单 50 条、最多翻 40 页，串行走代理可能要几十秒 ——
// 挂在一个 HTTP 请求里既容易超时也不好显示进度。所以 start 立刻返回，
// 状态（进度 / 结果）由页面轮询读取。
import type { Repos } from "../db/repositories/index.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { Logger } from "../lib/logger.ts";
import { HttpError } from "../api/server.ts";
import { biomeCode, biomeName } from "../modules/shared/biomes.ts";
import { rarityLabel } from "../modules/shared/rarity.ts";
import { barterErrorMessage, barterNextCursor, normalizeBarterOrders, type BarterFish, type BarterOrder } from "./barter-orders.ts";
import {
  SWAP_MAX_LENGTH,
  buildSwapGraph,
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

export type SwapHopInput = { orderId: string; requestFishId: string; offerFishId: string };

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
  /** 稳定 key：目标 + 跳数 + 每一跳的单 id（前端列表用） */
  key: string;
  targetFishId: string;
  length: number;
  hops: SwapHopView[];
};

export type SwapTargetView = {
  fishId: string;
  name: string;
  rarity: string;
  rarityLabel: string;
  biomeCode: string | null;
  biomeName: string | null;
  /** 专精还差几条 */
  remaining: number;
  /** 背包里现在有几条 */
  available: number;
  /** 这个目标当前有几条可行链 */
  pathCount: number;
};

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
  targets: SwapTargetView[];
  paths: SwapPathView[];
};

export type SwapStateView = {
  status: "idle" | "scanning" | "ready" | "error";
  progress: { phase: string; pages: number; orders: number };
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 执行过之后数据就旧了（剩余量变了）：面板提示重新扫描 */
  stale: boolean;
  result: SwapScanResult | null;
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

const pathView = (path: SwapPath): SwapPathView => ({
  key: `${path.target.fishId}|${path.length}|${path.hops.map((h) => h.orderId).join(",")}`,
  targetFishId: path.target.fishId,
  length: path.length,
  hops: path.hops.map(hopView),
});

const targetView = (target: SwapTarget, pathCount: number): SwapTargetView => ({
  fishId: target.fishId,
  name: target.name,
  rarity: target.rarity,
  rarityLabel: target.rarity ? rarityLabel(target.rarity) : "",
  biomeCode: target.biomeId ? biomeCode(target.biomeId) : null,
  biomeName: target.biomeId ? biomeName(target.biomeId) : null,
  remaining: target.remaining,
  available: target.available,
  pathCount,
});

type Entry = { state: SwapStateView; running: boolean };

const idleState = (): SwapStateView => ({
  status: "idle",
  progress: { phase: "", pages: 0, orders: 0 },
  error: null,
  startedAt: null,
  finishedAt: null,
  stale: false,
  result: null,
});

export class SwapService {
  private readonly deps: { repos: Repos; registry: RunnerRegistry; logger: Logger };
  /** 每个账号一份扫描状态（内存即可：结果随时可用新扫描覆盖） */
  private readonly entries = new Map<string, Entry>();

  constructor(deps: { repos: Repos; registry: RunnerRegistry; logger: Logger }) {
    this.deps = deps;
  }

  /** 当前状态（账号没扫过就是一个 idle） */
  state(userId: string, accountId: string): SwapStateView {
    this.requireOwnAccount(userId, accountId);
    return this.entry(accountId).state;
  }

  /** 开始一次扫描；已经在扫就直接返回当前状态（不重复起任务） */
  start(userId: string, accountId: string): SwapStateView {
    this.requireOwnAccount(userId, accountId);
    const entry = this.entry(accountId);
    if (entry.running) return entry.state;

    entry.state = {
      ...idleState(),
      status: "scanning",
      progress: { phase: "准备中", pages: 0, orders: 0 },
      startedAt: Date.now(),
      // 旧结果先留着：扫的时候面板还能看上一轮的数据
      result: entry.state.result,
    };
    entry.running = true;
    void this.scan(accountId, entry);
    return entry.state;
  }

  /**
   * 执行一条链（用户手动点的）。
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

    const rt = this.deps.registry.require(accountId);
    const log = this.deps.logger.child({ userId, accountId });
    const inventory = readSwapInventory(await rt.client.inventoryFish());
    const steps: SwapExecuteResult["steps"] = [];

    for (const [i, hop] of hops.entries()) {
      const have = inventory.get(hop.requestFishId) ?? 0;
      const fail = (text: string): SwapExecuteResult => {
        steps.push({ index: i + 1, orderId: hop.orderId, ok: false, error: text });
        this.markStale(accountId);
        log.warn("交换助手", `执行中断（第 ${i + 1}/${hops.length} 跳）：${text}`);
        return { ok: false, done: i, steps, error: `第 ${i + 1} 步：${text}` };
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

    this.markStale(accountId);
    log.info("交换助手", `✅ 手动走完一条 ${hops.length} 跳的交换链（共交出 ${hops.length} 条鱼）`);
    return { ok: true, done: hops.length, steps };
  }

  /* ---------------- 内部 ---------------- */

  private entry(accountId: string): Entry {
    const hit = this.entries.get(accountId);
    if (hit) return hit;
    const created: Entry = { state: idleState(), running: false };
    this.entries.set(accountId, created);
    return created;
  }

  /** 执行过之后把结果标成过期（面板据此提示"建议重新扫描"） */
  private markStale(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (entry?.state.result) entry.state.stale = true;
  }

  private async scan(accountId: string, entry: Entry): Promise<void> {
    const rt = this.deps.registry.require(accountId);
    const log = this.deps.logger.child({ accountId });
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
        entry.state.progress = { phase: "拉取交换单", pages, orders: orders.length };
        cursor = barterNextCursor(resp);
        if (!cursor) break;
        truncated = i === SWAP_MAX_PAGES - 1;
      }

      // 2) 专精目标 + 背包
      entry.state.progress = { phase: "读取专精进度与背包", pages, orders: orders.length };
      const [mastery, inv] = await Promise.all([
        rt.client.mastery().catch(() => null),
        rt.client.inventoryFish().catch(() => null),
      ]);
      if (!mastery || !inv) throw new Error("读不到专精进度或背包（账号可能还没连上游戏）");

      const inventory = readSwapInventory(inv);
      const targets = readSwapTargets(mastery, inventory);
      const graph = buildSwapGraph(orders);
      const paths = searchSwapPaths({ graph, inventory, targets });
      const byTarget = new Map<string, number>();
      for (const path of paths) byTarget.set(path.target.fishId, (byTarget.get(path.target.fishId) ?? 0) + 1);

      entry.state = {
        ...entry.state,
        status: "ready",
        progress: { phase: "完成", pages, orders: orders.length },
        error: null,
        finishedAt: Date.now(),
        stale: false,
        result: {
          stats: {
            orders: orders.length,
            edges: graph.edges,
            targets: targets.length,
            paths: paths.length,
            pages,
            truncated,
            scannedAt: Date.now(),
          },
          targets: targets.map((t) => targetView(t, byTarget.get(t.fishId) ?? 0)),
          paths: paths.map(pathView),
        },
      };
      log.info(
        "交换助手",
        `扫描完成：${orders.length} 张单 / ${graph.edges} 条边 / ${targets.length} 个专精目标 / ${paths.length} 条可行链` +
          (truncated ? `（已翻满 ${SWAP_MAX_PAGES} 页，可能还有没扫到的单）` : ""),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.state = { ...entry.state, status: "error", error: msg, finishedAt: Date.now() };
      log.warn("交换助手", `扫描失败：${msg}`);
    } finally {
      entry.running = false;
    }
  }

  private requireOwnAccount(userId: string, accountId: string): void {
    const row = this.deps.repos.accounts.findById(accountId);
    if (!row || row.user_id !== userId) {
      throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在或不属于你");
    }
  }
}
