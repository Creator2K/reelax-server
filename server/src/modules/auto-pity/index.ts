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
import { BIOME_OPTIONS } from "../shared/biomes.ts";
import {
  decidePityAction,
  didCatch,
  pityUnavailableReason,
  readPity,
  type PityProgress,
} from "./decide.ts";

export { decidePityAction, didCatch, readPity, pityUnavailableReason } from "./decide.ts";

/** 我们要让路的模块（它也会换图） */
const AUTO_TRAVEL_ID = "auto-travel";

const definition: ModuleDefinition = {
  id: "auto-pity",
  name: "保底切图",
  version: "2.0.0",
  description:
    "监控奇异鱼 / 奥秘鱼的硬保底进度：快触发保底时自动切到你指定的地图，出货后自动切回原来的地图。保底流程期间会临时暂停「自动切图」（出货后恢复），避免它把你从保底地图拽走。",
  defaultEnabled: false,
  defaultConfig: {
    rarity: "arcane",
    thresholdCasts: 30,
    targetBiome: "b_015",
    checkEverySec: 60,
    returnDelaySec: 5,
    pauseAutoTravel: true,
  },
  configSchema: [
    {
      key: "rarity",
      type: "select",
      label: "监控哪种保底",
      hint: "奥秘鱼是最稀有的档位，通常优先盯它。",
      default: "arcane",
      options: [
        { value: "arcane", label: "奥秘鱼保底（最高档）" },
        { value: "exotic", label: "奇异鱼保底" },
      ],
    },
    {
      key: "thresholdCasts",
      type: "number",
      label: "距保底还剩多少杆时切图",
      hint: "越接近保底，出货越确定。设太小可能来不及切；设太大则会在目标图待很久。",
      default: 30,
      min: 1,
      max: 500,
      step: 5,
    },
    {
      key: "targetBiome",
      type: "select",
      label: "保底地图（切到这里等出货）",
      hint: "建议选对目标稀有度有加成的地图。还没解锁的地图切过去会失败，日志里会提示。",
      default: "b_015",
      options: BIOME_OPTIONS,
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
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      busy: boolean;
      /** 上一次的保底进度（用于判定"钓到了"） */
      prev: PityProgress | null;
      /** 切到保底图之前所在的图（null = 不在保底流程里） */
      returnBiome: string | null;
      lastIdle: string;
      /** 出货后等待切回的截止时间戳 */
      returnAt: number;
      /** ★ 有一笔"欠切回"还没执行（缓冲期过后仍然有效，见文件头说明） */
      pendingReturn: boolean;
      /** 本次保底流程里已经抢回过一次目标图（避免和手动操作拉锯） */
      reenterUsed: boolean;
      /** 我们临时停掉了「自动切图」，流程结束后要恢复（跨重启保留） */
      pausedAutoTravel: boolean;
      lastTravelAt: number;
      /** 已经用 info 提示过的"没动作"原因（按 key 去重） */
      notified: Set<string>;
    };
    S.busy = false;
    S.prev = null;
    S.returnBiome = null;
    S.lastIdle = "";
    S.returnAt = 0;
    S.pendingReturn = false;
    S.reenterUsed = false;
    S.lastTravelAt = 0;
    S.notified = new Set();
    if (typeof S.pausedAutoTravel !== "boolean") S.pausedAutoTravel = false;

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

    const rarity = ctx.config.rarity === "exotic" ? "exotic" : "arcane";
    const threshold = Math.max(1, Number(ctx.config.thresholdCasts) || 30);
    const targetBiome = String(ctx.config.targetBiome ?? "").trim();
    const returnDelayMs = Math.max(0, Number(ctx.config.returnDelaySec) || 0) * 1000;
    const rarityLabel = rarity === "arcane" ? "奥秘鱼" : "奇异鱼";

    /** 结束保底流程（回到原图 / 放弃）：清干净并恢复「自动切图」 */
    const endFlow = async (why: string) => {
      S.returnBiome = null;
      S.pendingReturn = false;
      S.reenterUsed = false;
      S.returnAt = 0;
      await resumeAutoTravel(why);
    };

    const run = async (trigger: string) => {
      if (S.busy) return;
      S.busy = true;
      try {
        /* ---------- 读当前地图 + 保底进度 ---------- */
        const [biomesData, stats] = await Promise.all([ctx.api.biomes(), ctx.api.statistics()]);
        const biomes: any[] = biomesData?.biomes ?? [];
        const currentBiomeId: string | null = biomes.find((b) => b.isCurrent)?.id ?? null;
        const currentName = biomes.find((b) => b.id === currentBiomeId)?.name ?? currentBiomeId ?? "未知";

        const cur = readPity(stats?.pity, rarity);
        if (!cur) {
          // 说清楚是"当前条件无保底"还是"接口变了"（两种都见过，别混在一句话里）
          idleOnce(`no-pity:${rarity}`, `${trigger}：${pityUnavailableReason(stats?.pity, rarity)}`);
          S.prev = null;
          return;
        }

        const caught = didCatch(S.prev, cur);
        S.prev = cur;

        /* ---------- 出货：记一笔"欠切回" ---------- */
        if (S.returnBiome && caught) {
          S.pendingReturn = true;
          S.returnAt = Date.now() + returnDelayMs;
          ctx.log.info(
            "保底切图",
            `🎉 ${rarityLabel}保底出货了（连空 ${cur.dryCasts} 杆后重置）` +
              (returnDelayMs > 0 ? `，${Math.round(returnDelayMs / 1000)} 秒后切回` : "，立即切回原地图"),
          );
        }
        if (S.returnAt && Date.now() < S.returnAt) {
          return; // 缓冲期
        }

        /* ---------- 决策 ---------- */
        // ★ 缓冲期过后，这笔"欠切回"依然算数：不能只看本轮的 caught ——
        //   出货后 dry 计数已经从 0 涨回去了，下一轮 caught 必然是 false，
        //   旧版正是因此永远走不到"切回原图"。
        const caughtOrPending = caught || S.pendingReturn;
        const decision = decidePityAction({
          remaining: cur.remaining,
          threshold,
          currentBiome: currentBiomeId,
          targetBiome,
          returnBiome: S.returnBiome,
          caught: caughtOrPending,
        });

        if (decision.action === "stay") {
          const camping = Boolean(S.returnBiome);
          if (camping && caughtOrPending && currentBiomeId === S.returnBiome) {
            // 已经回到原图（手动切的 / 抢回时被抢先）→ 流程结束
            await endFlow("已回到原地图");
          } else if (camping) {
            idleOnce(
              `camping:${rarity}`,
              `${trigger}：${rarityLabel} 已连空 ${cur.dryCasts}/${cur.totalCasts} 杆（还差 ${cur.remaining} 杆）` +
                `｜已在保底地图等待出货`,
            );
          } else {
            idle(
              `${trigger}：${rarityLabel} 已连空 ${cur.dryCasts}/${cur.totalCasts} 杆（还差 ${cur.remaining} 杆）` +
                (decision.reason ? ` ｜ ${decision.reason}` : ""),
            );
          }
          return;
        }

        const toName = biomes.find((b) => b.id === decision.biomeId)?.name ?? decision.biomeId;

        /* ---------- 抢回保底图（被别的模块 / 手动挪走） ---------- */
        if (decision.action === "reenter") {
          if (S.reenterUsed) {
            idleOnce(
              "reenter-used",
              `${trigger}：已不在保底地图（${currentName}），本次流程已经抢回过一次，不再抢（可能你在手动操作；出货后会自动切回原图）`,
            );
            return;
          }
          S.reenterUsed = true;
          try {
            await ctx.api.biomeTravel(decision.biomeId);
            S.lastTravelAt = Date.now();
            S.lastIdle = "";
            ctx.log.info(
              "保底切图",
              `⛵ ${currentName} → ${toName}（${decision.reason}；` +
                `已连空 ${cur.dryCasts}/${cur.totalCasts} 杆，还差 ${cur.remaining} 杆）`,
            );
          } catch (err) {
            ctx.log.warn("保底切图", `切回 ${toName} 失败：${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        /* ---------- 进保底图 / 切回原图 ---------- */
        const fromLabel = currentName;
        if (decision.action === "enter") {
          // 记住原地图，出货后切回
          S.returnBiome = currentBiomeId;
        }

        try {
          await ctx.api.biomeTravel(decision.biomeId);
          S.lastTravelAt = Date.now();
          S.returnAt = 0;
          S.lastIdle = "";

          if (decision.action === "enter") {
            ctx.log.info(
              "保底切图",
              `⛵ ${fromLabel} → ${toName}（${decision.reason}；` +
                `已连空 ${cur.dryCasts}/${cur.totalCasts} 杆，还差 ${cur.remaining} 杆）`,
            );
            // 已经在保底图里了 → 让「自动切图」让路（否则十分钟内就会被它拽走）
            await pauseAutoTravel();
          } else {
            ctx.log.info("保底切图", `⛵ ${fromLabel} → ${toName}（${decision.reason}）`);
            await endFlow("已切回原地图");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log.warn("保底切图", `切到 ${toName} 失败：${msg}`);
          // 切失败就别记着"要切回"，否则下次会莫名其妙往回切
          if (decision.action === "enter") {
            S.returnBiome = null;
            S.pendingReturn = false;
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

    ctx.log.info("保底切图", `已启动：监控 ${rarityLabel}，阈值 ${threshold} 杆，目标地图 ${targetBiome || "（未配置）"}`);
  },

  /**
   * 模块停止时把「自动切图」还回去（不能让别的功能一直停在关闭状态）。
   * 账号正在停止时 restartModule 内部会 no-op，安全；恢复失败则保留标志，下次启动再补。
   */
  async onStop(ctx) {
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
