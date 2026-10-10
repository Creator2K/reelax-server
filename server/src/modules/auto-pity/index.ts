// 稀有鱼保底监控：快触发保底时切到指定地图，钓到后切回原图
//
// 协议：
//  - GET /api/statistics → pity: {
//        exotic: { hardPityCasts, currentDryCasts },   // 奇异鱼
//        arcane: { hardPityCasts, currentDryCasts },   // 奥秘鱼
//        effectiveLuck, luckTier, baitId, weatherId
//      }
//  - GET /api/biomes → 地图列表（找目标地图的名字、判断当前在哪）
//  - PUT /api/player/current-biome { biomeId }   换图（免费）
//  - GET /api/convenience + PUT .../route-assistant/settings   临时接管助手的「自动换图」
//
// 为什么需要它：稀有鱼有**硬保底**（连空到 hardPityCasts 杆时必出），而不同地图对稀有度的
// 加成不同。把剩下最后几十杆放到"保底地图"里钓，出货时就能吃到那张图的加成。
//
// 设计要点：
//  - hardPityCasts 会随运气/鱼饵/天气变化，**每轮都要重新读**，不能缓存
//  - 「钓到了」用 dry 计数下降来判定（比解析鱼获列表更可靠）
//  - 只接管自己切过去的图：如果用户本来就在目标图，不去"接管"（避免误切回）
//
// ★ 与官方航线助手：**完全不看它**（不读它的开关、不接管、不提示）。
//   本项目自己负责换图；助手是跑在游戏页面里的循环，挂机时它本来就不动，
//   你只要在游戏里把它关掉即可。
import { type ModuleDefinition } from "../types.ts";
import { BIOME_OPTIONS } from "../shared/biomes.ts";
import { decidePityAction, didCatch, readPity, type PityProgress } from "./decide.ts";

export { decidePityAction, didCatch, readPity } from "./decide.ts";

const definition: ModuleDefinition = {
  id: "auto-pity",
  name: "保底切图",
  version: "1.0.0",
  description:
    "监控奇异鱼 / 奥秘鱼的硬保底进度：快触发保底时自动切到你指定的地图，出货后自动切回原来的地图。适合把「最后几十杆」放到加成更好的地图里钓。",
  defaultEnabled: false,
  defaultConfig: {
    rarity: "arcane",
    thresholdCasts: 30,
    targetBiome: "b_015",
    checkEverySec: 60,
    returnDelaySec: 5,
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
      lastTravelAt: number;
    };
    S.busy = false;
    S.prev = null;
    S.returnBiome = null;
    S.lastIdle = "";
    S.returnAt = 0;
    S.lastTravelAt = 0;

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("保底切图", msg);
    };

    const rarity = ctx.config.rarity === "exotic" ? "exotic" : "arcane";
    const threshold = Math.max(1, Number(ctx.config.thresholdCasts) || 30);
    const targetBiome = String(ctx.config.targetBiome ?? "").trim();
    const returnDelayMs = Math.max(0, Number(ctx.config.returnDelaySec) || 0) * 1000;
    const rarityLabel = rarity === "arcane" ? "奥秘鱼" : "奇异鱼";

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
          idle(`${trigger}：读不到${rarityLabel}的保底数据（游戏接口可能变了）`);
          S.prev = null;
          return;
        }

        const caught = didCatch(S.prev, cur);
        S.prev = cur;

        /* ---------- 出货后的延迟切回 ---------- */
        if (S.returnBiome && caught) {
          S.returnAt = Date.now() + returnDelayMs;
          ctx.log.info(
            "保底切图",
            `🎉 ${rarityLabel}保底出货了（连空 ${cur.dryCasts} 杆后重置）` +
              (returnDelayMs > 0 ? `，${Math.round(returnDelayMs / 1000)} 秒后切回 ${currentName}` : ""),
          );
        }
        if (S.returnAt && Date.now() < S.returnAt) {
          return; // 还在缓冲期
        }

        /* ---------- 决策 ---------- */
        const decision = decidePityAction({
          remaining: cur.remaining,
          threshold,
          currentBiome: currentBiomeId,
          targetBiome,
          returnBiome: S.returnBiome,
          caught,
        });

        if (decision.action === "stay") {
          // ★ 已经回到原图（用户手动切的 / 切回时被抢先）：流程结束，别一直挂在
          //   「等待切回」状态上 —— 否则以后再触发保底也不会切图了。
          if (S.returnBiome && caught && currentBiomeId === S.returnBiome) {
            S.returnBiome = null;
          }
          // 顺便把进度说清楚（同一句只记一次）
          idle(
            `${trigger}：${rarityLabel} 已连空 ${cur.dryCasts}/${cur.totalCasts} 杆（还差 ${cur.remaining} 杆）` +
              (decision.reason ? ` ｜ ${decision.reason}` : ""),
          );
          return;
        }

        /* ---------- 执行换图 ---------- */
        const fromLabel = currentName;
        const toBiomeId = decision.action === "enter" ? decision.biomeId : decision.biomeId;
        const toName = biomes.find((b) => b.id === toBiomeId)?.name ?? toBiomeId;

        if (decision.action === "enter") {
          // 记住原地图，出货后切回
          S.returnBiome = currentBiomeId;
        }

        try {
          await ctx.api.biomeTravel(toBiomeId);
          S.lastTravelAt = Date.now();
          S.returnAt = 0;
          S.lastIdle = "";

          if (decision.action === "enter") {
            ctx.log.info(
              "保底切图",
              `⛵ ${fromLabel} → ${toName}（${decision.reason}；` +
                `已连空 ${cur.dryCasts}/${cur.totalCasts} 杆，还差 ${cur.remaining} 杆）`,
            );
          } else {
            ctx.log.info("保底切图", `⛵ ${fromLabel} → ${toName}（${decision.reason}）`);
            S.returnBiome = null; // 已回到原图，退出保底流程
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log.warn("保底切图", `切到 ${toName} 失败：${msg}`);
          // 切失败就别记着"要切回"，否则下次会莫名其妙往回切
          if (decision.action === "enter") S.returnBiome = null;
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
};

export default definition;
