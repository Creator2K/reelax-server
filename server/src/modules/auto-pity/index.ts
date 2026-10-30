// 稀有鱼保底监控：快触发保底时切到指定地图，钓到后切回原图
//
// 协议：
//  - GET /api/statistics → pity: {
//        exotic: { hardPityCasts, currentDryCasts },   // 奇异鱼（hardPityCasts 可能为 null = 当前条件无保底）
//        arcane: { hardPityCasts, currentDryCasts },   // 奥秘鱼
//      }
//  - GET /api/biomes → 地图列表（找目标地图的名字、判断当前在哪）
//  - PUT /api/player/current-biome { biomeId }   换图（免费）
//
// 为什么需要它：稀有鱼有**硬保底**（连空到 hardPityCasts 杆时必出），而不同地图对稀有度的
// 加成不同。把剩下最后几十杆放到"保底地图"里钓，出货时就能吃到那张图的加成。
//
// 设计要点：
//  - hardPityCasts 会随运气/鱼饵/天气变化，**每轮都要重新读**，不能缓存
//  - 「钓到了」用 dry 计数下降来判定（比解析鱼获列表更可靠）
//  - 只接管自己切过去的图：如果用户本来就在目标图，不去"接管"（避免误切回）
//  - ★ 保底流程期间**临时暂停「自动切图」**（可关）：两边都在决定"我在哪张图"，
//    而自动切图不认识本模块 —— 不暂停的话，切进保底图不到 10 分钟就会被它拽走，
//    剩下那几十杆全打在没有加成的地图上。出货切回后自动恢复。
//
// ★ 两个踩过的坑（都留了回归测试）：
//  1) 「出货后切回」原来永远不执行：出货那一轮因为要等 returnDelaySec 直接 return 了，
//     而下一轮 caught 会被重算成 false（dry 计数已经从 0 涨回去）→ 切回分支进不去。
//     现在用 pendingReturn 记住"欠一次切回"，缓冲期过后照样执行。
//  2) 被别的模块挪走后会一直"等待出货"，再也不会切回保底图（流程卡死）。
//     现在决策会给出 reenter（每次流程限一次），把它抢回来。
import { type ModuleDefinition } from "../types.ts";
import { BIOME_OPTIONS, pickHighestBiome } from "../shared/biomes.ts";
import { holdTravel, releaseTravel } from "../shared/travel-lock.ts";
import {
  PITY_LABELS,
  PITY_RARITIES,
  decidePityAction,
  didCatch,
  pickPityTarget,
  pityUnavailableReason,
  readPity,
  type PityProgress,
  type PityRarity,
} from "./decide.ts";

export {
  PITY_LABELS,
  PITY_RARITIES,
  decidePityAction,
  didCatch,
  pickPityTarget,
  readPity,
  pityUnavailableReason,
} from "./decide.ts";

/** 我们要让路的模块（它也会换图，且整个停掉是安全的） */
const AUTO_TRAVEL_ID = "auto-travel";
/** 地图配置里的「自动」哨兵：避开 Radix Select 的空字符串限制 */
const AUTO_BIOME = "auto";
/** 占「换图决策权」时显示给日志的名字 */
const TRAVEL_LOCK_LABEL = "保底切图（守保底中）";

/**
 * 每个档位自己的流程状态。
 *
 * ★ 两个档位各自独立：各自记住"切过去之前在哪张图"、各自是否已经抢回过一次。
 *   同一时刻只能待在一张图上，所以另有全局的 `active` 表示"现在守着谁"。
 */
type TargetFlow = {
  /** 上一次的保底进度（用于判定"钓到了"；不跨重启残留） */
  prev: PityProgress | null;
  /** 切到保底图之前所在的图（null = 该档位不在流程里） */
  returnBiome: string | null;
  /** 本次流程里已经抢回过一次目标图（避免和手动操作拉锯） */
  reenterUsed: boolean;
  /** ★ 有一笔"欠切回"还没执行（缓冲期过后仍然有效，见文件头说明） */
  pendingReturn: boolean;
  /** 出货后等待切回的截止时间戳 */
  returnAt: number;
};

const freshFlow = (): TargetFlow => ({
  prev: null,
  returnBiome: null,
  reenterUsed: false,
  pendingReturn: false,
  returnAt: 0,
});

const definition: ModuleDefinition = {
  id: "auto-pity",
  name: "保底切图",
  version: "3.1.0",
  description:
    "监控奇异鱼 / 奥秘鱼的硬保底进度（可同时监控两个，各自指定地图与阈值）：快触发保底时自动切到那张图，出货后自动切回原来的地图。两个都快到保底时先守更接近出货的那个（一样近时奥秘优先）。保底流程期间会临时暂停「自动切图」（出货后恢复），避免它把你从保底地图拽走。",
  defaultEnabled: false,
  defaultConfig: {
    rarities: ["exotic", "arcane"],
    exoticBiome: AUTO_BIOME,
    exoticThreshold: 30,
    arcaneBiome: AUTO_BIOME,
    arcaneThreshold: 30,
    checkEverySec: 60,
    returnDelaySec: 5,
    pauseAutoTravel: true,
    pauseTournamentTravel: true,
  },
  configSchema: [
    {
      key: "rarities",
      type: "multi-select",
      label: "监控哪些保底",
      hint:
        "两个都勾上 = 同时监控，下面的地图与阈值各自生效。\n" +
        "★ 同一时刻只能待在一张图上：两个都快到保底时先守更接近的那个（一样近时奥秘优先）；" +
        "守着一个时另一个的进度照常记录，前者出货切回后若后者也到了阈值就接着守它。",
      default: ["exotic", "arcane"],
      options: [
        { value: "exotic", label: "奇异鱼保底" },
        { value: "arcane", label: "奥秘鱼保底（最高档）" },
      ],
    },
    {
      key: "exoticBiome",
      type: "biome-select",
      label: "奇异鱼：保底地图（切到这里等出货）",
      hint:
        "默认「自动」：每次检查时选当前已解锁的最高地图，游戏新增地图后会自动跟上。\n" +
        "也可以固定一张地图；还没解锁的地图不会切换，日志里会提示。",
      default: AUTO_BIOME,
      options: [{ value: AUTO_BIOME, label: "自动：已解锁的最高地图" }, ...BIOME_OPTIONS],
    },
    {
      key: "exoticThreshold",
      type: "number",
      label: "奇异鱼：距保底还剩多少杆时切图",
      hint: "越接近保底，出货越确定。设太小可能来不及切；设太大则会在目标图待很久。",
      default: 30,
      min: 1,
      max: 500,
      step: 5,
    },
    {
      key: "arcaneBiome",
      type: "biome-select",
      label: "奥秘鱼：保底地图（切到这里等出货）",
      hint:
        "默认「自动」：每次检查时选当前已解锁的最高地图，游戏新增地图后会自动跟上。\n" +
        "可以和奇异鱼用同一张，也可以各用一张。",
      default: AUTO_BIOME,
      options: [{ value: AUTO_BIOME, label: "自动：已解锁的最高地图" }, ...BIOME_OPTIONS],
    },
    {
      key: "arcaneThreshold",
      type: "number",
      label: "奥秘鱼：距保底还剩多少杆时切图",
      default: 30,
      min: 1,
      max: 500,
      step: 5,
    },
    {
      key: "checkEverySec",
      type: "number",
      label: "检查间隔（秒）",
      hint: "保底进度只在钓鱼结算后推进，间隔不必太短。",
      default: 60,
      min: 20,
      max: 900,
      step: 10,
    },
    {
      key: "returnDelaySec",
      type: "number",
      label: "出货后延迟多少秒切回",
      hint: "留一点缓冲，避免刚好卡在结算边界上把出货那一杆算丢。",
      default: 5,
      min: 0,
      max: 300,
      step: 5,
    },
    {
      key: "pauseAutoTravel",
      type: "boolean",
      label: "保底期间暂停「自动切图」",
      hint:
        "两个功能都在决定去哪张图，而「自动切图」不知道你在保底。开着这项时：" +
        "切进保底地图后临时停掉「自动切图」，出货切回原图后恢复（它本来就没开则什么都不做）。",
      default: true,
    },
    {
      key: "pauseTournamentTravel",
      type: "boolean",
      label: "保底期间暂停「报名赛事」的进图",
      hint:
        "「自动报名赛事」的「报名」与「进图」是两件独立的事：这里只暂停它的「进比赛地图」，" +
        "报名照常进行（报名有时效，错过就没了；换图随时能补）。保底流程结束后自动恢复。",
      default: true,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      busy: boolean;
      /** 每个档位自己的流程状态（两个档位各自记原图 / 各自限一次抢回） */
      flows: Record<PityRarity, TargetFlow>;
      /** 当前正守着哪个档位（null = 没在守） */
      active: PityRarity | null;
      lastIdle: string;
      /** 我们临时停掉了「自动切图」，流程结束后要恢复（跨重启保留） */
      pausedAutoTravel: boolean;
      lastTravelAt: number;
      /** 已经用 info 提示过的"没动作"原因（按 key 去重） */
      notified: Set<string>;
    };
    S.busy = false;
    S.lastIdle = "";
    S.lastTravelAt = 0;
    S.notified = new Set();
    if (typeof S.pausedAutoTravel !== "boolean") S.pausedAutoTravel = false;

    // 每个档位的流程状态：保留 returnBiome 等（跨重启继续守），但 prev 必须清掉 ——
    // 重启后第一次读到进度不该被当成"刚出货"
    const prevFlows = (S.flows ?? {}) as Partial<Record<PityRarity, TargetFlow>>;
    S.flows = { exotic: freshFlow(), arcane: freshFlow() };
    for (const r of PITY_RARITIES) {
      const old = prevFlows[r];
      if (old && typeof old === "object") {
        S.flows[r] = {
          prev: null,
          returnBiome: typeof old.returnBiome === "string" ? old.returnBiome : null,
          reenterUsed: old.reenterUsed === true,
          pendingReturn: old.pendingReturn === true,
          returnAt: Number(old.returnAt) || 0,
        };
      }
    }
    S.active = S.active === "exotic" || S.active === "arcane" ? S.active : null;
    // 状态不一致（记着在守，但没有原图）→ 当作没在守，避免凭空"切回"
    if (S.active && !S.flows[S.active].returnBiome) S.active = null;

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("保底切图", msg);
    };
    /**
     * 同一类"没动作"的原因，用 **info** 讲一次。
     *
     * 这些说明原本都是 debug，而默认日志级别是 info —— 于是「为什么没切图」在界面上
     * 完全看不到，被当成功能坏了。按 key 去重后每个原因只多一行，不会刷屏。
     */
    const idleOnce = (key: string, msg: string) => {
      if (S.notified.has(key)) {
        idle(msg);
        return;
      }
      S.notified.add(key);
      S.lastIdle = msg;
      ctx.log.info("保底切图", msg);
    };

    /* ---------- 与「自动切图」的协调（B1：保底期间让它让路） ---------- */

    /**
     * 与「只换图、但有别的职责」的模块协调：占住「换图决策权」。
     *
     * 「自动报名赛事」的报名与进图是两件独立的事，整个停掉会把报名也停掉（报名有时效），
     * 所以改用共享锁：它每次进图前会问一句"现在有人占着吗"，占着就只跳过进图这一步。
     * 锁是纯内存 + 按账号隔离的（见 shared/travel-lock.ts）。
     */
    const travelLockTag = `auto-pity:${ctx.account.accountId}`;
    // 改配置重启时老实例不一定跑到 onStop → 先把自己上次可能留下的锁放掉
    releaseTravel(ctx.account.accountId, travelLockTag);

    const holdTravelLock = () => {
      if (ctx.config.pauseTournamentTravel === false) return;
      holdTravel(ctx.account.accountId, travelLockTag, TRAVEL_LOCK_LABEL);
    };
    const releaseTravelLock = () => {
      releaseTravel(ctx.account.accountId, travelLockTag);
    };

    const pauseAutoTravel = async () => {
      if (ctx.config.pauseAutoTravel === false) return;
      if (S.pausedAutoTravel) return; // 已经暂停了
      if (!ctx.account.moduleInstances.includes(AUTO_TRAVEL_ID)) return; // 没开就不用管
      try {
        await ctx.account.stopModule(AUTO_TRAVEL_ID);
        S.pausedAutoTravel = true;
        ctx.persistState?.();
        ctx.log.info(
          "保底切图",
          "保底流程期间已暂停「自动切图」（避免它把号从保底地图拽走）；出货切回原图后会自动恢复",
        );
      } catch (err) {
        ctx.log.warn("保底切图", `暂停「自动切图」失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const resumeAutoTravel = async (why: string) => {
      if (!S.pausedAutoTravel) return;
      try {
        // restartModule 内部会看「这个模块还是不是启用状态」，也处理账号已停止的情况（那时是 no-op）
        await ctx.account.restartModule(AUTO_TRAVEL_ID);
      } catch (err) {
        // ★ 失败时**保留标志**：下次模块启动 / 停止时会再恢复一次，不会把它永久关着
        ctx.log.warn(
          "保底切图",
          `恢复「自动切图」失败：${err instanceof Error ? err.message : String(err)}` +
            "（稍后会自动重试；也可在账号页把它关掉再打开）",
        );
        return;
      }
      S.pausedAutoTravel = false;
      ctx.persistState?.();
      ctx.log.info("保底切图", `已恢复「自动切图」（${why}）`);
    };

    // 上次流程没走完就被中断（改配置 / 容器重启）：把「自动切图」恢复回来，别让它一直关着
    if (S.pausedAutoTravel) await resumeAutoTravel("上次保底流程被中断");

    /* ---------- 配置：每个档位各自的地图与阈值 ---------- */
    const rarityCfg: Record<PityRarity, { biome: string; threshold: number }> = {
      exotic: {
        biome: String(ctx.config.exoticBiome ?? "").trim(),
        threshold: Math.max(1, Number(ctx.config.exoticThreshold) || 30),
      },
      arcane: {
        biome: String(ctx.config.arcaneBiome ?? "").trim(),
        threshold: Math.max(1, Number(ctx.config.arcaneThreshold) || 30),
      },
    };
    const monitoredRaw = Array.isArray(ctx.config.rarities) ? ctx.config.rarities.map((x) => String(x)) : PITY_RARITIES;
    const targets = PITY_RARITIES.filter((r) => monitoredRaw.includes(r)).map((rarity) => ({
      rarity,
      ...rarityCfg[rarity],
    }));
    const returnDelayMs = Math.max(0, Number(ctx.config.returnDelaySec) || 0) * 1000;

    /** 结束某个档位的保底流程（回到原图 / 放弃）：清干净并恢复「自动切图」和进图权 */
    const endFlow = async (rarity: PityRarity, why: string) => {
      const flow = S.flows[rarity];
      flow.returnBiome = null;
      flow.pendingReturn = false;
      flow.reenterUsed = false;
      flow.returnAt = 0;
      if (S.active === rarity) S.active = null;
      releaseTravelLock();
      await resumeAutoTravel(why);
    };

    const run = async (trigger: string) => {
      if (S.busy) return;
      S.busy = true;
      try {
        if (!targets.length) {
          idleOnce("no-target", `${trigger}：没有勾选任何要监控的保底（奇异鱼 / 奥秘鱼），本功能不做任何事`);
          return;
        }

        /* ---------- 读当前地图 + 所有档位的保底进度 ---------- */
        const [biomesData, stats] = await Promise.all([ctx.api.biomes(), ctx.api.statistics()]);
        const biomes: any[] = (biomesData?.biomes ?? []).filter(Boolean);
        const unlocked = biomes.filter((b) => b.isUnlocked !== false);
        const currentBiomeId: string | null = String(
          biomesData?.currentBiomeId ?? biomesData?.player?.currentBiomeId ?? biomes.find((b) => b.isCurrent)?.id ?? "",
        ).trim() || null;
        const currentName = biomes.find((b) => b.id === currentBiomeId)?.name ?? currentBiomeId ?? "未知";

        // 选择「自动」= 每次重新选择当前已解锁的最高地图。每次检查都重新算，
        // 因此游戏新增 b_016、或者账号刚解锁一张新图时都不需要改配置/重启。
        const autoTarget = pickHighestBiome(unlocked);
        const roundTargets = targets.flatMap((t) => {
          if (!t.biome || t.biome === AUTO_BIOME) {
            const id = String(autoTarget?.id ?? "");
            if (!id) {
              idleOnce(`no-biome:${t.rarity}`, `${trigger}：${PITY_LABELS[t.rarity]} 没有可用的已解锁地图`);
              return [];
            }
            idleOnce(
              `auto-biome:${t.rarity}:${id}`,
              `${trigger}：${PITY_LABELS[t.rarity]} 保底地图自动选择 ${String(autoTarget?.name ?? id)}`,
            );
            return [{ ...t, biome: id }];
          }
          const target = biomes.find((b) => String(b.id) === t.biome);
          if (!target) {
            idleOnce(`missing-biome:${t.rarity}:${t.biome}`, `${trigger}：${PITY_LABELS[t.rarity]} 的保底地图 ${t.biome} 不在游戏地图列表中`);
            return [];
          }
          if (target.isUnlocked === false) {
            idleOnce(`locked-biome:${t.rarity}:${t.biome}`, `${trigger}：${PITY_LABELS[t.rarity]} 的保底地图 ${String(target.name ?? t.biome)} 尚未解锁`);
            return [];
          }
          return [t];
        });
        if (!roundTargets.length) {
          idleOnce("no-usable-biome", `${trigger}：没有可用的保底地图，本功能暂不动作`);
          return;
        }

        const progress = new Map<PityRarity, PityProgress | null>();
        const caughtNow = new Set<PityRarity>();

        for (const t of roundTargets) {
          const flow = S.flows[t.rarity];
          const cur = readPity(stats?.pity, t.rarity);
          if (!cur) {
            // 说清楚是"当前条件无保底"还是"接口变了"（两种都见过，别混在一句话里）
            idleOnce(`no-pity:${t.rarity}`, `${trigger}：${pityUnavailableReason(stats?.pity, t.rarity)}`);
            flow.prev = null;
            progress.set(t.rarity, null);
            continue;
          }

          const caught = didCatch(flow.prev, cur);
          flow.prev = cur;
          progress.set(t.rarity, cur);
          if (!caught) continue;
          caughtNow.add(t.rarity);

          /* ---------- 出货：记一笔"欠切回" ---------- */
          if (flow.returnBiome) {
            flow.pendingReturn = true;
            flow.returnAt = Date.now() + returnDelayMs;
            ctx.log.info(
              "保底切图",
              `🎉 ${PITY_LABELS[t.rarity]}保底出货了（连空 ${cur.dryCasts} 杆后重置）` +
                (returnDelayMs > 0 ? `，${Math.round(returnDelayMs / 1000)} 秒后切回` : "，立即切回原地图"),
            );
          }
        }

        /** 日志里把两个档位的进度都摊开（排查时不用来回翻） */
        const describeAll = () =>
          roundTargets
            .map((t) => {
              const p = progress.get(t.rarity) ?? null;
              const label = PITY_LABELS[t.rarity];
              return p
                ? `${label} 已连空 ${p.dryCasts}/${p.totalCasts}（还差 ${p.remaining}，阈值 ${t.threshold}）`
                : `${label}：读不到进度`;
            })
            .join("｜");

        /* ---------- 选出这一轮要处理的档位 ---------- */
        // 优先处理"正守着的"；否则挑一个到了阈值、且更接近出货的（一样近时奥秘优先）
        let handle: { rarity: PityRarity; biome: string; threshold: number } | null = null;
        if (S.active) {
          handle = roundTargets.find((t) => t.rarity === S.active) ?? null;
          if (!handle) await endFlow(S.active, "该档位已不再监控或地图不可用");
        }
        if (!handle) {
          const picked = pickPityTarget(
            roundTargets.map((t) => ({
              rarity: t.rarity,
              remaining: progress.get(t.rarity)?.remaining ?? null,
              threshold: t.threshold,
              targetBiome: t.biome,
            })),
          );
          if (picked) handle = { rarity: picked.rarity, biome: picked.targetBiome, threshold: rarityCfg[picked.rarity].threshold };
        }

        if (!handle) {
          idleOnce("waiting", `${trigger}：${describeAll()}`);
          return;
        }

        const rarity = handle.rarity;
        const rarityLabel = PITY_LABELS[rarity];
        const flow = S.flows[rarity];
        const cur = progress.get(rarity) ?? null;
        if (!cur) {
          idle(`${trigger}：${rarityLabel} 的保底数据读不到，本轮不动作`);
          return;
        }
        // 刚出货、正在缓冲期：先别动（马上要切回原图）
        if (S.active === rarity && flow.returnAt && Date.now() < flow.returnAt) return;

        /* ---------- 决策 ---------- */
        // ★ 缓冲期过后，这笔"欠切回"依然算数：不能只看本轮的 caught ——
        //   出货后 dry 计数已经从 0 涨回去了，下一轮 caught 必然是 false，
        //   旧版正是因此永远走不到"切回原图"。
        const caughtOrPending = caughtNow.has(rarity) || flow.pendingReturn;
        const decision = decidePityAction({
          remaining: cur.remaining,
          threshold: handle.threshold,
          currentBiome: currentBiomeId,
          targetBiome: handle.biome,
          returnBiome: flow.returnBiome,
          caught: caughtOrPending,
        });

        if (decision.action === "stay") {
          const camping = Boolean(flow.returnBiome);
          if (camping && caughtOrPending && currentBiomeId === flow.returnBiome) {
            // 已经回到原图（手动切的 / 抢回时被抢先）→ 流程结束
            await endFlow(rarity, "已回到原地图");
          } else if (camping) {
            idleOnce(
              `camping:${rarity}`,
              `${trigger}：${rarityLabel} 已连空 ${cur.dryCasts}/${cur.totalCasts} 杆（还差 ${cur.remaining} 杆）` +
                `｜已在保底地图等待出货`,
            );
          } else {
            idle(`${trigger}：${describeAll()}${decision.reason ? ` ｜ ${decision.reason}` : ""}`);
          }
          return;
        }

        const toName = biomes.find((b) => b.id === decision.biomeId)?.name ?? decision.biomeId;

        /* ---------- 抢回保底图（被别的模块 / 手动挪走） ---------- */
        if (decision.action === "reenter") {
          if (flow.reenterUsed) {
            idleOnce(
              `reenter-used:${rarity}`,
              `${trigger}：已不在${rarityLabel}的保底地图（${currentName}），本次流程已经抢回过一次，不再抢（可能你在手动操作；出货后会自动切回原图）`,
            );
            return;
          }
          flow.reenterUsed = true;
          try {
            await ctx.api.biomeTravel(decision.biomeId);
            S.lastTravelAt = Date.now();
            S.lastIdle = "";
            ctx.log.info(
              "保底切图",
              `⛵ ${currentName} → ${toName}（${decision.reason}；` +
                `${rarityLabel} 已连空 ${cur.dryCasts}/${cur.totalCasts} 杆，还差 ${cur.remaining} 杆）`,
            );
          } catch (err) {
            ctx.log.warn("保底切图", `切回 ${toName} 失败：${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        /* ---------- 进保底图 / 切回原图 ---------- */
        const fromLabel = currentName;
        if (decision.action === "enter") {
          // 记住原地图（按档位各记一份），出货后切回
          flow.returnBiome = currentBiomeId;
          S.active = rarity;
        }

        try {
          await ctx.api.biomeTravel(decision.biomeId);
          S.lastTravelAt = Date.now();
          flow.returnAt = 0;
          S.lastIdle = "";

          if (decision.action === "enter") {
            ctx.log.info(
              "保底切图",
              `⛵ ${fromLabel} → ${toName}（${decision.reason}；` +
                `${rarityLabel} 已连空 ${cur.dryCasts}/${cur.totalCasts} 杆，还差 ${cur.remaining} 杆）`,
            );
            // 已经在保底图里了 → 让其它模块让路：
            //   · 「自动切图」整个停掉（它本来就没开则什么都不做）
            //   · 占住「换图决策权」，让「自动报名赛事」只跳过进图（报名照常）
            holdTravelLock();
            await pauseAutoTravel();
          } else {
            ctx.log.info("保底切图", `⛵ ${fromLabel} → ${toName}（${decision.reason}）`);
            await endFlow(rarity, "已切回原地图");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log.warn("保底切图", `切到 ${toName} 失败：${msg}`);
          // 切失败就别记着"要切回"，否则下次会莫名其妙往回切
          if (decision.action === "enter") {
            flow.returnBiome = null;
            flow.pendingReturn = false;
            if (S.active === rarity) S.active = null;
          }
        }
      } catch (err) {
        ctx.log.warn("保底切图", `${trigger} 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.busy = false;
      }
    };

    const everySec = Math.max(20, Number(ctx.config.checkEverySec) || 60);
    ctx.every(everySec * 1000, () => run("定时检查"));

    // 每次结算后保底进度都会变，顺带看一眼（节流到 checkEverySec，避免每 6 秒一次）
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < everySec * 1000) return;
      lastSync = now;
      void run("钓鱼同步");
    });

    ctx.schedule(20_000, () => run("启动检查"));

    ctx.log.info(
      "保底切图",
      targets.length
        ? `已启动：监控 ${targets
            .map(
              (t) =>
                `${PITY_LABELS[t.rarity]}（阈值 ${t.threshold} 杆 → ${!t.biome || t.biome === AUTO_BIOME ? "自动：已解锁的最高地图" : t.biome}）`,
            )
            .join("、")}`
        : "已启动：未勾选任何要监控的保底（奇异鱼 / 奥秘鱼），本功能不会做任何事",
    );
  },

  /**
   * 模块停止时把「自动切图」和进图权还回去（不能让别的功能一直停在关闭状态）。
   * 账号正在停止时 restartModule 内部会 no-op，安全；恢复失败则保留标志，下次启动再补。
   */
  async onStop(ctx) {
    // 换图决策权必须无条件放掉：模块被停 / 账号被停都一样，否则别的模块永远进不了比赛图
    releaseTravel(ctx.account.accountId, `auto-pity:${ctx.account.accountId}`);

    const S = ctx.state as { pausedAutoTravel?: boolean };
    if (S?.pausedAutoTravel !== true) return;
    try {
      await ctx.account.restartModule(AUTO_TRAVEL_ID);
      S.pausedAutoTravel = false;
    } catch {
      /* 保留标志：下次 onStart 会再恢复一次 */
    }
  },
};

export default definition;
