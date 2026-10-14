// 自动卖鱼：把背包里指定稀有度的鱼卖给 NPC（与「自动卖装备」同一套思路）
//
// 协议：
//  - GET  /api/inventory/fish    → { fish: [{ fishId, quantity, sellPrice, rarity?, name?,
//                                             isLocked?, isManuallyLocked?, isMasteryLocked?,
//                                             titanValueSummary? }] }
//  - GET  /api/content/bootstrap → { fish: [{ id, name, rarity, sellPrice, … }] }（静态内容表）
//  - POST /api/inventory/fish/sell { items: [{ fishId, quantity }] }
//
// ★ 稀有度从哪来：背包条目的字段随版本变化（有时只给 fishId + quantity），
//   所以取不到时用 `/api/content/bootstrap` 的鱼定义补 —— 那份表基本不变，缓存 6 小时。
//
// 安全底线（任何配置下都不动）：
//   锁定的鱼（isLocked / isManuallyLocked / isMasteryLocked）
//   带泰坦倍率的鱼（默认保护，可关）：titanValueSummary 非空
//
// ★ 与「自动专精献祭」的关系：鱼同时是专精献祭的素材。
//   两个功能一起开时，卖掉的鱼就献不了祭了 —— 所以默认只卖 普通/罕见/精良 三档，
//   并且建议先开「干跑」看一眼到底会卖什么。
import { type ModuleDefinition } from "../types.ts";
import { rarityCheckboxOptions, rarityLabel, rarityRank } from "../shared/rarity.ts";

/** 内容表缓存时长（鱼定义基本不变） */
const CONTENT_TTL_MS = 6 * 3600_000;

/** 单次卖鱼请求最多带多少个鱼种（数量不设上限，但鱼种别太多） */
const MAX_ITEMS_PER_REQUEST = 100;

const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

const definition: ModuleDefinition = {
  id: "auto-sell-fish",
  name: "自动卖鱼",
  version: "1.0.0",
  description:
    "按稀有度勾选把背包里的鱼卖给 NPC（换金币），不勾的留着。锁定的鱼与带泰坦倍率的鱼不动。建议第一次先开「干跑」看一天 —— 鱼同时是专精献祭的素材，别把要献祭的档位卖掉了。",
  defaultEnabled: false,
  defaultConfig: {
    sellRarities: ["common", "uncommon", "fine"],
    protectTitan: true,
    maxPerRun: 2000,
    minIntervalMin: 10,
    dryRun: false,
  },
  configSchema: [
    {
      key: "sellRarities",
      type: "multi-select",
      label: "直接卖掉这些品质的鱼",
      hint: "勾哪个卖哪个，不勾的保留。空着 = 不卖任何鱼。鱼还是「自动专精献祭」的素材，别把要献的档位勾上。",
      default: ["common", "uncommon", "fine"],
      options: rarityCheckboxOptions(),
    },
    {
      key: "protectTitan",
      type: "boolean",
      label: "保护带泰坦倍率的鱼",
      hint: "带有泰坦/巨型倍率的鱼价值远高于 NPC 回收价，默认不卖。",
      default: true,
    },
    {
      key: "maxPerRun",
      type: "number",
      label: "每轮最多卖多少条",
      hint: "按条数限流，防止一次误操作把背包清空。",
      default: 2000,
      min: 1,
      max: 100_000,
      step: 100,
    },
    {
      key: "minIntervalMin",
      type: "number",
      label: "检查间隔（分钟）",
      default: 10,
      min: 1,
      max: 120,
      step: 1,
    },
    {
      key: "dryRun",
      type: "boolean",
      label: "只报告不动作（干跑）",
      hint: "打开后只在日志里列出「本该卖多少条、约多少金币」，不动背包。",
      default: false,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as { running: boolean; lastIdle: string };
    S.running = false;
    S.lastIdle = "";

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("卖鱼", msg);
    };

    /** 内容表：fishId → 鱼定义（取稀有度用），按 TTL 缓存 */
    let contentFish: Map<string, any> | null = null;
    let contentAt = 0;
    const fishDefs = async (): Promise<Map<string, any>> => {
      if (contentFish && Date.now() - contentAt < CONTENT_TTL_MS) return contentFish;
      try {
        const data = await ctx.api.contentBootstrap();
        const list: any[] = Array.isArray(data?.fish) ? data.fish : [];
        contentFish = new Map(list.filter((f) => f?.id).map((f) => [String(f.id), f]));
        contentAt = Date.now();
      } catch {
        // 拿不到内容表也不致命：背包条目自己带 rarity 时照常工作
        if (!contentFish) contentFish = new Map();
      }
      return contentFish;
    };

    let lastRun = 0;

    const run = async (trigger: string) => {
      const resp = await ctx.api.inventoryFish();
      const items: any[] = Array.isArray(resp?.fish) ? resp.fish : [];
      if (!items.length) {
        idle("背包里没有鱼");
        return;
      }

      const sellSet = new Set(asStringArray(ctx.config.sellRarities).filter((r) => rarityRank(r) >= 0));
      if (!sellSet.size) {
        idle("没有勾选任何要卖的品质");
        return;
      }
      const protectTitan = ctx.config.protectTitan !== false;
      const defs = await fishDefs();

      const pick: { fishId: string; quantity: number; rarity: string; name: string; unit: number }[] = [];
      let lockedSkipped = 0;
      let titanSkipped = 0;

      for (const item of items) {
        const fishId = String(item?.fishId ?? item?.id ?? "");
        if (!fishId) continue;
        const quantity = Math.max(0, Math.floor(Number(item?.quantity) || 0));
        if (quantity <= 0) continue;

        const def = defs.get(fishId) ?? null;
        const rarity = String(item?.rarity ?? def?.rarity ?? "");
        if (rarityRank(rarity) < 0 || !sellSet.has(rarity)) continue;

        if (item?.isLocked || item?.isManuallyLocked || item?.isMasteryLocked) {
          lockedSkipped += 1;
          continue;
        }
        if (protectTitan && item?.titanValueSummary != null) {
          titanSkipped += 1;
          continue;
        }

        pick.push({
          fishId,
          quantity,
          rarity,
          name: String(item?.name ?? def?.name ?? fishId),
          unit: Number(item?.sellPrice ?? def?.sellPrice) || 0,
        });
      }

      if (!pick.length) {
        idle(
          `${trigger}：没有符合条件（勾选的品质）的鱼` +
            (lockedSkipped ? `，${lockedSkipped} 种被锁定跳过` : "") +
            (titanSkipped ? `，${titanSkipped} 种因泰坦倍率保护跳过` : ""),
        );
        return;
      }

      // 每轮上限（按条数），并限制单次请求里的鱼种数
      const cap = Math.max(1, Number(ctx.config.maxPerRun) || 2000);
      const chosen: typeof pick = [];
      let totalQuantity = 0;
      for (const p of pick) {
        if (chosen.length >= MAX_ITEMS_PER_REQUEST) break;
        const room = cap - totalQuantity;
        if (room <= 0) break;
        const q = Math.min(p.quantity, room);
        chosen.push({ ...p, quantity: q });
        totalQuantity += q;
      }

      const estGold = chosen.reduce((a, p) => a + p.unit * p.quantity, 0);
      const byRarity = new Map<string, number>();
      for (const p of chosen) byRarity.set(p.rarity, (byRarity.get(p.rarity) ?? 0) + p.quantity);
      const rarityText = [...byRarity]
        .sort((a, b) => rarityRank(b[0]) - rarityRank(a[0]))
        .map(([r, n]) => `${rarityLabel(r)}×${n}`)
        .join("、");
      const sample = chosen
        .slice(0, 3)
        .map((p) => p.name)
        .join("、");

      if (ctx.config.dryRun) {
        ctx.log.info(
          "卖鱼",
          `[干跑] 本该卖 ${totalQuantity} 条（${rarityText}，如 ${sample}${chosen.length > 3 ? " 等" : ""}）` +
            (estGold ? `，约 ${estGold.toLocaleString("zh-CN")} 金币` : "") +
            (lockedSkipped ? `；另有 ${lockedSkipped} 种被锁定跳过` : "") +
            (titanSkipped ? `；${titanSkipped} 种因泰坦倍率保护跳过` : ""),
        );
        return;
      }

      const r = await ctx.api.sellFish(chosen.map((p) => ({ fishId: p.fishId, quantity: p.quantity })));
      const gold = Number(r?.goldEarned ?? r?.gold ?? r?.goldReceived) || 0;
      ctx.log.info(
        "卖鱼",
        `🐟 已卖 ${totalQuantity} 条（${rarityText}）` +
          (gold ? `，获得 ${gold.toLocaleString("zh-CN")} 金币` : estGold ? `，约 ${estGold.toLocaleString("zh-CN")} 金币` : ""),
      );
    };

    /**
     * 触发一轮（带间隔与并发保护）。
     *
     * ★ 返回 Promise 便于测试 await —— 定时器回调会忽略它（`void`），
     *   但测试里能准确等到这一轮真的做完，而不是靠 setTimeout 猜。
     */
    const tryRun = (trigger: string, force = false): Promise<void> => {
      const now = Date.now();
      const intervalMs = Math.max(1, Number(ctx.config.minIntervalMin) || 10) * 60_000;
      if (!force && now - lastRun < intervalMs) return Promise.resolve();
      lastRun = now;
      if (S.running) return Promise.resolve();
      S.running = true;
      return run(trigger)
        .catch((err) => {
          ctx.log.warn("卖鱼", `本轮失败：${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          S.running = false;
        })
        // 日志函数有返回值，这里抹平类型：调用方只关心「这一轮做完了」
        .then(() => undefined);
    };

    // 钓到鱼后延时处理（结算里带鱼才触发）
    ctx.on("fishing:sync", (evt: any) => {
      if ((evt?.settlement?.fish?.length ?? 0) > 0) {
        ctx.schedule(20_000, () => void tryRun("钓获新鱼"));
      }
    });

    ctx.every(Math.max(1, Number(ctx.config.minIntervalMin) || 10) * 60_000, () => void tryRun("定时检查"));
    ctx.schedule(25_000, () => tryRun("启动检查", true));
  },
};

export default definition;
