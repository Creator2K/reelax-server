// 自动以物易物：按队列里的交换任务，用现成的交换单把起点鱼多轮换到目标鱼
//
// 游戏机制（决定了这个模块能做什么、不能做什么）：
//  · 交换单 = 单主的「需求若干鱼种」×「提供若干鱼种」，响应一次是**一对一**（各 1 条）；
//  · **不能响应自己发布的单** —— 所以「自己挂中间产物、再接自己的单」这条闭环不存在，
//    每一跳都必须有人挂着正好接得上的现成单；
//  · 只支持最高三档稀有度，且同一张单里的鱼同稀有度 → 整条链留在起点鱼的稀有度里；
//  · 单子会被别人抢先响应或过期 → 每一跳前都重新读一次单子再决定下一步。
//
// 协议：
//  - GET  /api/barter/orders?canFulfill=true&offersMastery=false&limit=&cursor=
//  - POST /api/barter/orders/{id}/fill   { requestFishId（我交出）, offerFishId（我获得） }
//  - GET  /api/inventory/fish            → 手上有什么、剩几条、有没有被锁
//  - GET  /api/content/bootstrap         → 鱼定义（稀有度 / 所属地图）
//  - GET  /api/mastery                   → 专精目标鱼（这些鱼不拿去换）
//
// 安全设计：
//  · **只接现成单**：找不到完整路径就等下一轮，绝不自己挂单（挂了也等不到保证）；
//  · 起点鱼永远是「未锁定、且不是专精目标鱼」的（游戏也不允许交出被锁的鱼）；
//  · 每轮最多成交 maxFillsPerRound 次、每条链最多 maxHops 跳，请求量可控；
//  · 每次成交后都核对背包实际变化，对不上就停下本轮（不盲目继续下一跳）；
//  · 中途停下时换到的鱼留在背包里（不会被吞掉），可以把它当新的起点鱼再建一条任务。
import { type ModuleDefinition } from "../types.ts";
import { biomeCode, biomeName } from "../shared/biomes.ts";
import {
  barterErrorMessage,
  chooseBarterChain,
  fetchBarterOrders,
  planBarterChain,
  type BarterFish,
  type BarterHop,
  type BarterOrder,
  type BarterPlan,
} from "../../services/barter-plan.ts";
import {
  filterStartFish,
  masteryTargetFishIds,
  pickStartCandidates,
  readInventoryFish,
  taskTargetMatcher,
  taskTargetText,
  type InventoryFish,
} from "../../services/barter-view.ts";
import type { BarterTaskRow } from "../../db/repositories/barter-tasks.ts";

/** 鱼定义（内容表）几乎不变 —— 缓存 6 小时，别每轮都拉 */
const CONTENT_TTL_MS = 6 * 3600_000;
/** 交换单翻页：一次最多看这么多张单（每页 50，最多 4 页 = 200 张） */
const ORDERS_PAGE_LIMIT = 50;
const ORDERS_MAX_PAGES = 4;

const DEFAULT_CHECK_MIN = 3;
const DEFAULT_MAX_HOPS = 3;
const DEFAULT_MAX_FILLS = 6;

const clampInt = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

const definition: ModuleDefinition = {
  id: "auto-barter",
  name: "自动以物易物",
  version: "1.0.0",
  description:
    "在交易页的「以物易物」里，用现成的交换单把背包里的鱼**多轮换**成目标鱼（例：B2 的鱼 → B3 → B6 → B5）。" +
    "在账号详情页的「交换任务」面板里定好「拿什么换什么」并加入队列，功能会自动盯市场：能换就立刻换、换不了就排队等。" +
    "只响应别人挂的现成单（自己挂单要等人响应，无法自动闭环），所以某一跳市场上没人挂单时任务会一直等待。" +
    "只支持神话 / 奇异 / 奥秘三档稀有度，且整条链与起点鱼同稀有度。",
  defaultEnabled: false,
  defaultConfig: {
    checkEveryMin: DEFAULT_CHECK_MIN,
    maxHops: DEFAULT_MAX_HOPS,
    maxFillsPerRound: DEFAULT_MAX_FILLS,
  },
  configSchema: [
    {
      key: "checkEveryMin",
      type: "number",
      label: "检查间隔（分钟）",
      hint: "每隔多久看一次市场。最低 1 分钟（游戏接口很轻，但也别低于这个值）。",
      default: DEFAULT_CHECK_MIN,
      min: 1,
      max: 60,
      step: 1,
    },
    {
      key: "maxHops",
      type: "number",
      label: "一条链最多交换几次",
      hint: "例：B2 → B3 → B6 → B5 是 3 次。设得越大越可能绕远路换到，但中途被抢断的概率也越高。",
      default: DEFAULT_MAX_HOPS,
      min: 1,
      max: 6,
      step: 1,
    },
    {
      key: "maxFillsPerRound",
      type: "number",
      label: "每轮最多成交几次",
      hint:
        "限流用：一轮里最多开始几条链（一条 3 跳的链会消耗 3 次）。" +
        "已经开始的链一定会走完（最多「一条链最多交换几次」那么多），所以实际次数可能略高于这个值。",
      default: DEFAULT_MAX_FILLS,
      min: 1,
      max: 30,
      step: 1,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as { running: boolean; lastIdle: string };
    S.running = false;
    S.lastIdle = "";

    const everyMin = clampInt(ctx.config.checkEveryMin, DEFAULT_CHECK_MIN, 1, 60);
    const maxHops = clampInt(ctx.config.maxHops, DEFAULT_MAX_HOPS, 1, 6);
    const maxFills = clampInt(ctx.config.maxFillsPerRound, DEFAULT_MAX_FILLS, 1, 30);

    /** 同一句「这次没动」的说明只记一次：变化时 info、长期一样时 debug（避免刷屏） */
    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("以物易物", msg);
    };
    const noted = new Set<string>();
    const idleOnce = (key: string, msg: string) => {
      if (noted.has(key)) {
        idle(msg);
        return;
      }
      noted.add(key);
      S.lastIdle = msg;
      ctx.log.info("以物易物", msg);
    };

    /* ---------- 内容表（鱼定义）：缓存 ---------- */
    let content: unknown = null;
    let contentAt = 0;
    const contentBootstrap = async (): Promise<unknown> => {
      if (content && Date.now() - contentAt < CONTENT_TTL_MS) return content;
      try {
        content = await ctx.api.contentBootstrap();
        contentAt = Date.now();
      } catch {
        // 拿不到内容表也不致命：交换单自带鱼的稀有度与地图
      }
      return content;
    };

    const inventory = async (): Promise<InventoryFish[]> => readInventoryFish(await ctx.api.inventoryFish());

    const qtyOf = (inv: InventoryFish[], fishId: string): number =>
      inv.find((f) => f.fishId === fishId)?.quantity ?? 0;

    /** 当前能响应的交换单（翻页取全） */
    const fetchOrders = async (): Promise<BarterOrder[]> =>
      fetchBarterOrders(ctx.api, { limit: ORDERS_PAGE_LIMIT, pages: ORDERS_MAX_PAGES });

    const selfNickname = (): string | null => {
      const fromRuntime = (ctx.account as unknown as { me?: any })?.me?.player?.nickname;
      const fromClient = (ctx.api as unknown as { player?: any })?.player?.nickname;
      const v = fromRuntime ?? fromClient;
      return v ? String(v) : null;
    };
    const selfPublicId = (): string | null => {
      const v = (ctx.api as unknown as { publicIdentity?: { publicId?: string } })?.publicIdentity?.publicId;
      return v ? String(v) : null;
    };

    /** 一条链的起点（多起点任务里挑出来的那条鱼） */
    type StartFish = BarterFish & { quantity: number };

    /** 从指定的鱼出发规划（链的稀有度 = 这条鱼的稀有度） */
    const planFor = (task: BarterTaskRow, orders: BarterOrder[], from: BarterFish): BarterPlan =>
      planBarterChain({
        orders,
        fromFishId: from.fishId,
        fromFish: from,
        rarity: from.rarity,
        maxHops,
        isTarget: taskTargetMatcher(task),
        selfNickname: selfNickname(),
        selfPublicId: selfPublicId(),
      });

    /** 「B2 雾语湿地·雾语灯笼鱼」——玩家说的是 B 几，日志里就带上它 */
    const fishText = (fish: { biomeId: string | null; name: string }): string => {
      const place = fish.biomeId ? `${biomeCode(fish.biomeId) ?? ""}${biomeName(fish.biomeId) ?? fish.biomeId}` : "";
      return place ? `${place}·${fish.name}` : fish.name;
    };

    const hopText = (hop: BarterHop, index: number): string =>
      `第 ${index} 跳：交出 ${fishText(hop.give)}，获得 ${fishText(hop.get)}` +
      `（单主 ${hop.ownerNickname ?? "未知"}，这一对还能成交 ${hop.capacity} 次）`;

    const targetText = (task: BarterTaskRow): string => taskTargetText(task);

    /** 任务起点侧现在能用哪些鱼（按规格匹配，且排除锁定 / 专精目标鱼） */
    const startFishOf = (
      task: BarterTaskRow,
      inv: InventoryFish[],
      content: unknown,
      masteryTargets: Set<string>,
    ): StartFish[] =>
      filterStartFish(task.from_specs, pickStartCandidates({ inventory: inv, content, masteryTargets }));

    /**
     * 从某条鱼开始尽量往前走（一条链）。
     *
     * 每成交一跳都会重新读单子与背包再规划下一步 —— 单子会被别人抢走、剩余量会变，
     * 照着开局那份计划硬走只会在第二跳撞墙。
     *
     * 两个额外的刹车：
     *  · 响应失败的单**记进 dead**，本轮不再规划它（否则会拿着同一张坏单把配额耗光）；
     *  · 一旦开始走一条链，就**一定走完**（最多 maxHops 跳）—— 每轮成交次数的配额
     *    只在「要不要开始下一条链」时生效。否则「3 跳的链 + 每轮 2 次的配额」会永远
     *    停在第 2 跳，把起点鱼换成半路的中间产物。
     */
    const walk = async (
      task: BarterTaskRow,
      start: StartFish,
      budget: { fills: number; done: number },
      firstPlan: BarterPlan,
    ): Promise<{ fishId: string; fishName: string; hops: number; reached: boolean; note: string | null }> => {
      let current: BarterFish = { fishId: start.fishId, name: start.name, biomeId: start.biomeId, rarity: start.rarity };
      let hops = 0;

      const dead = new Set<string>();
      const refresh = async (): Promise<BarterOrder[]> =>
        (await fetchOrders()).filter((o) => !dead.has(o.id));

      let inv = await inventory();
      let plan = firstPlan;
      const done = (reached: boolean, note: string | null) => ({
        fishId: current.fishId,
        fishName: current.name,
        hops,
        reached,
        note,
      });

      if (!plan.ok) return done(false, plan.reason);
      if (plan.hops.length > 1) {
        ctx.log.info(
          "以物易物",
          `规划到一条 ${plan.hops.length} 跳的路：` +
            [start.name, ...plan.hops.map((h) => h.get.name)].join(" → ") +
            `（最紧的一跳还能成交 ${plan.capacity} 次）`,
        );
      }

      while (hops < maxHops && plan.ok) {
        const hop = plan.hops[0]!;
        // 这一跳要交出的鱼必须还在手上（可能刚被卖鱼 / 献祭 / 别的任务用掉了）
        if (qtyOf(inv, hop.give.fishId) <= 0) {
          return done(false, `手上没有「${hop.give.name}」了（可能被别的功能卖掉或用掉），先跳过这一跳`);
        }

        const beforeInv = inv;
        budget.fills -= 1;
        let fillError: string | null = null;
        let tradeOk = false;
        try {
          const resp = (await ctx.api.barterFill(hop.orderId, {
            requestFishId: hop.give.fishId,
            offerFishId: hop.get.fishId,
          })) as any;
          tradeOk = Boolean(resp?.trade);
        } catch (err) {
          fillError = barterErrorMessage(err);
        }

        if (fillError) {
          // 多半是被别人抢先换走了：如实记录，把这张单拉黑，然后**重新规划**换一条路走
          ctx.log.warn("以物易物", `${hopText(hop, hops + 1)} 失败：${fillError}`);
          dead.add(hop.orderId);
          inv = await inventory();
          plan = planFor(task, await refresh(), current);
          if (!plan.ok) return done(false, plan.reason);
          continue;
        }

        // 核对背包实际变化：不核对就可能"以为换到了、其实没有"，后面全乱
        const after = await inventory();
        const gave = qtyOf(beforeInv, hop.give.fishId) - qtyOf(after, hop.give.fishId);
        const got = qtyOf(after, hop.get.fishId) - qtyOf(beforeInv, hop.get.fishId);
        if (!tradeOk && (gave < 1 || got < 1)) {
          ctx.log.warn(
            "以物易物",
            `${hopText(hop, hops + 1)} 的结果无法确认（交出 ${gave} 条、获得 ${got} 条），本轮停下，下一轮重新检查`,
          );
          return done(false, "上一次成交结果无法确认，已停下等待下一轮");
        }

        current = { fishId: hop.get.fishId, name: hop.get.name, biomeId: hop.get.biomeId, rarity: hop.get.rarity };
        hops += 1;
        inv = after;
        S.lastIdle = "";
        ctx.log.info(
          "以物易物",
          `🔄 ${hopText(hop, hops)}` +
            (tradeOk ? "" : "（按背包变化确认）") +
            `｜任务：换到 ${targetText(task)} 进度 ${budget.done + 1}/${task.quantity}`,
        );

        if (taskTargetMatcher(task)(hop.get)) return done(true, null);

        // 下一跳：从**手上这条鱼**重新读单子与背包再规划
        inv = await inventory();
        plan = planFor(task, await refresh(), current);
      }

      if (!plan.ok) return done(false, plan.reason);
      return done(false, hops >= maxHops ? `已经走满 ${maxHops} 跳还没到目标` : null);
    };

    const run = async (trigger: string) => {
      if (S.running) return;
      S.running = true;
      try {
        const task = ctx.account.barterNextTask();
        if (!task) {
          idle(`${trigger}：队列里没有待执行的任务（在「交换任务」面板里添加即可）`);
          return;
        }

        if (!ctx.account.barterUpdateTask(task.id, { status: "running" })) {
          idle(`${trigger}：任务已经不在了`);
          return;
        }

        await contentBootstrap();
        const inv = await inventory();
        // 起点鱼必须还在手上、没被锁定、也不是当前专精目标鱼（专精鱼要留给献祭）
        const mastery = masteryTargetFishIds(await ctx.api.mastery().catch(() => null));
        const starts = startFishOf(task, inv, content, mastery);
        if (!starts.length) {
          const note = `起点侧（${task.from_specs.map((s) => biomeCode(s.biomeId) ?? s.biomeId ?? s.fishId).join(" / ")}）现在没有可用的鱼：可能已用完、被锁定，或成了专精目标鱼`;
          ctx.account.barterUpdateTask(task.id, { status: "blocked", lastNote: note, lastError: null });
          idleOnce(`no-start:${task.id}`, `${trigger}：${note}`);
          return;
        }

        const budget = { fills: maxFills, done: task.done_quantity };
        let note: string | null = null;

        // 一轮里可以连着换几条（受 maxFillsPerRound 限制）：一条链换到 1 条，再走下一条
        while (budget.fills > 0 && budget.done < task.quantity) {
          // ★ 每一轮都重新看一遍起点侧与市场：多起点任务要挑「能走通、跳数少、单子剩余多」的那条
          const freshInv = await inventory();
          const usable = startFishOf(task, freshInv, content, mastery);
          if (!usable.length) {
            note = "起点侧的鱼已经用完（或被锁定 / 成了专精目标鱼）";
            break;
          }
          const choice = chooseBarterChain({
            orders: await fetchOrders(),
            starts: usable,
            targets: task.target_specs,
            maxHops,
            selfNickname: selfNickname(),
            selfPublicId: selfPublicId(),
          });
          if (!choice.ok) {
            note = choice.reason;
            break;
          }
          if (usable.length > 1) {
            ctx.log.info(
              "以物易物",
              `起点侧有 ${usable.length} 种鱼可用，这次先走「${fishText(choice.start)}」（${choice.plan.hops.length} 跳，最紧的一跳还能成交 ${choice.plan.capacity} 次）`,
            );
          }

          const r = await walk(task, choice.start, budget, choice.plan);
          note = r.note ?? note;
          if (!r.reached) {
            if (r.hops > 0) {
              // 半路停下：换到的鱼留在背包里，提示可以把它当新的起点
              ctx.log.info(
                "以物易物",
                `半路停下：本次只走了 ${r.hops} 跳，手里留下「${r.fishName}」（留在背包里，可当作新的起点鱼再建一条任务）` +
                  (r.note ? `｜${r.note}` : ""),
              );
            }
            break;
          }
          budget.done += 1;
          ctx.account.barterUpdateTask(task.id, {
            status: budget.done >= task.quantity ? "done" : "running",
            doneQuantity: budget.done,
            lastNote: null,
            lastError: null,
          });
          if (budget.done >= task.quantity) {
            ctx.log.info(
              "以物易物",
              `✅ 任务完成：换到 ${targetText(task)} 共 ${budget.done} 条`,
            );
            break;
          }
          ctx.log.info(
            "以物易物",
            `换到 1 条，进度 ${budget.done}/${task.quantity}` +
              (budget.fills > 0 ? "，继续换下一条" : "，本轮成交次数用完，下一轮继续"),
          );
        }

        if (budget.done < task.quantity) {
          // 收尾时再看一眼起点侧还剩多少：够不够把目标数量凑齐，直接写进说明里
          const left = startFishOf(
            task,
            await inventory().catch(() => [] as InventoryFish[]),
            content,
            mastery,
          ).reduce((sum, c) => sum + c.quantity, 0);
          const needed = task.quantity - budget.done;
          const shortfall = left < needed ? `；起点侧还剩 ${left} 条可换，离目标还差 ${needed} 条` : "";
          const tail = budget.fills <= 0 ? "；本轮成交次数用完，下一轮继续" : "";
          ctx.account.barterUpdateTask(task.id, {
            status: "waiting",
            doneQuantity: budget.done,
            lastNote: `${note ?? "等待可走的交换路径"}${shortfall}${tail}`,
            lastError: null,
          });
          idleOnce(
            `no-path:${task.id}:${(note ?? "").slice(0, 24)}`,
            `${trigger}：${note ?? "当前没有可走的交换路径"}${shortfall}${tail}`,
          );
        }
      } catch (err) {
        ctx.log.warn("以物易物", `${trigger} 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.running = false;
      }
    };

    ctx.every(everyMin * 60_000, () => void run("定时检查"));
    // 启动后先看一眼（错开别的模块：不抢首轮登录）
    ctx.schedule(45_000, () => run("启动检查"));

    ctx.log.info(
      "以物易物",
      `已启动：每 ${everyMin} 分钟检查一次，一条链最多 ${maxHops} 跳、每轮最多成交 ${maxFills} 次（只接现成的交换单）`,
    );
  },
};

export default definition;
