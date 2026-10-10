// 自动专精献祭：把背包里能献的鱼批量献祭给地图专精
//
// 协议：
//  - GET  /api/mastery → { biomes: [{ biomeId, biomeName, masteryLevel, isUnlocked,
//                                    rarities: [{ fish:{id,name}, remainingQuantity,
//                                                 availableQuantity, isWaiting, ... }] }] }
//  - POST /api/mastery/{biomeId}/contribute-all { excludedRarities }
//    服务端一次匹配该地图所有可献的鱼，不需要逐个提交
//
// 选图口径：**专精等级越低越优先**（等级低时升级收益最大）。
// 每轮只处理一张地图，避免一次打出一串请求。
//
// 与官方航线助手的「奥秘献祭」不是一回事：那是全世界共同消耗资源激活全地图涌流
// （/api/events/arcane-sacrifice，由本项目的「奥秘献祭」模块负责），
// 这里做的是把鱼献给自己地图的专精等级（/api/mastery）。
import { type ModuleDefinition } from "../types.ts";
import { jitter } from "../../lib/util.ts";
import { RARITIES, RARITY_LABELS } from "../shared/rarity.ts";

const definition: ModuleDefinition = {
  id: "auto-mastery",
  name: "自动专精献祭",
  version: "2.0.0",
  description:
    "把背包里多余的鱼献祭给地图专精，从等级最低的地图开始，逐步提升各地图加成。",
  defaultEnabled: false,
  defaultConfig: {
    intervalMin: 12,
    excludeBelow: "common",
  },
  configSchema: [
    {
      key: "intervalMin",
      type: "number",
      label: "检查间隔（分钟）",
      hint: "每次随机跳过部分轮次，节奏更自然。",
      default: 12,
      min: 3,
      max: 120,
      step: 1,
    },
    {
      key: "excludeBelow",
      type: "select",
      label: "不献祭低于此档的鱼",
      hint: "默认「普通」= 全部都献。想保住低稀有度鱼就往上调。",
      default: "common",
      options: RARITIES.map((r, i) => ({ value: r, label: `${i + 1}级·${RARITY_LABELS[r]}` })),
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as { running: boolean; lastIdleSig: string };
    S.running = false;
    S.lastIdleSig = "";

    const run = async (trigger: string) => {
      if (S.running) return;
      S.running = true;
      try {
        const overview = await ctx.api.mastery();
        const biomes = (overview?.biomes ?? []).filter((b: any) => b?.biomeId && b.isUnlocked !== false);

        // 有可献项的地图；专精等级越低越优先
        const candidates = biomes
          .map((biome: any) => {
            const items = (biome.rarities ?? []).filter(
              (item: any) =>
                !item.isWaiting && Math.min(Number(item.remainingQuantity) || 0, Number(item.availableQuantity) || 0) > 0,
            );
            return { biome, items };
          })
          .filter((c: { items: unknown[] }) => c.items.length > 0)
          .sort(
            (a: any, b: any) => (Number(a.biome.masteryLevel) || 0) - (Number(b.biome.masteryLevel) || 0),
          );

        if (!candidates.length) {
          const sig = biomes.map((b: any) => `${b.biomeId}:${b.masteryLevel}`).join("|");
          if (S.lastIdleSig !== sig) {
            S.lastIdleSig = sig;
            ctx.log.info("自动献祭", `${trigger}：暂无可献祭的鱼（已检查 ${biomes.length} 张地图）`);
          }
          return;
        }

        const { biome, items } = candidates[0] as { biome: any; items: any[] };
        const name = biome.biomeName ?? biome.biomeId;

        // 排除低稀有度：把配置档位及以下都排除
        const excludeRank = RARITIES.indexOf(String(ctx.config.excludeBelow) as (typeof RARITIES)[number]);
        const excluded: string[] = [];
        if (excludeRank > 0) {
          for (const r of RARITIES) {
            if (RARITIES.indexOf(r) < excludeRank) excluded.push(r);
          }
        }

        const r = await ctx.api.masteryContributeAll(biome.biomeId, excluded);
        const gained = r?.contributedCount ?? r?.contributed ?? items.length;
        const level = r?.masteryLevel ?? biome.masteryLevel;
        S.lastIdleSig = "";

        ctx.log.info(
          "自动献祭",
          `${trigger}：${name} 献祭 ${gained} 项` +
            (level != null ? `（专精等级 ${level}）` : "") +
            (excluded.length ? `，已排除 ${excluded.map((x) => RARITY_LABELS[x as never]).join("/")}` : ""),
        );
      } catch (err) {
        ctx.log.warn("自动献祭", `${trigger} 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.running = false;
      }
    };

    const intervalMs = Math.max(3, Number(ctx.config.intervalMin) || 12) * 60_000;

    ctx.every(intervalMs, () => {
      // 随机跳过 1/4 轮次，形成自然抖动的操作节奏（与旧版行为一致）
      if (Math.random() < 0.25) return;
      void run("定时检查");
    });

    // 启动后错峰执行（避开登录与首轮钓鱼）
    ctx.schedule(jitter(20_000), () => void run("启动检查"));

    // 每次钓鱼结算后也可能有新的可献鱼；节流 5 分钟
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < 5 * 60_000) return;
      lastSync = now;
      void run("钓鱼同步");
    });
  },
};

export default definition;
