// 自动卖装备：按稀有度**勾选**处理背包装备
//
// 协议：
//  - GET  /api/inventory/gear?cursor=  → { gear: [{ id, name, rarity, quality, slot,
//                                            equippedSlot, isLocked, marketOrderId }], nextCursor }
//  - POST /api/inventory/gear/sell       { gearIds } → { goldEarned, player, ... }
//  - POST /api/inventory/gear/dismantle  { gearIds } → 装备结晶（游戏只允许 传说/神话/奇异）
//
// ★ 分档是「两个勾选集合」（v3 起）：
//     稀有度 ∈ 分解集合（且游戏允许分解） → 分解
//     稀有度 ∈ 出售集合                   → 卖
//     其余                                → 保留
//   旧版是「低于 X 档就卖」这种阈值下拉，把一个集合压成了一个点：
//   想「普通/精良卖、稀有留着、史诗又卖」这种组合根本表达不出来，
//   而且阈值是「以下全包含」，调一档会连带影响它下面所有档，用户很难预期。
//
// 安全底线（任何模式下都不动）：
//   已穿戴（equippedSlot）/ 已锁定（isLocked）/ 已挂市场（marketOrderId）
// 另有 maxPerRun 限流与 dryRun 干跑，避免一次误操作清空背包。
import { type ModuleDefinition } from "../types.ts";
import { DISMANTLABLE_RARITIES, rarityCheckboxOptions, rarityLabel, rarityRank } from "../shared/rarity.ts";

const gearRarityRank = rarityRank;
const rarityOptions = rarityCheckboxOptions;

/** 配置里的多选值（已由 resolveModuleConfig 归一化成数组，这里只做防御） */
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/**
 * 纯集合分档：dismantle / sell / keep。
 *
 * 分解优先于出售：同时勾了两边的档位走分解（分解拿结晶，比 NPC 回收值钱），
 * 但只在游戏允许分解的档位上生效（传说 / 神话 / 奇异）。
 */
export function bucketOf(
  rarity: unknown,
  sellRarities: ReadonlySet<string>,
  dismantleRarities: ReadonlySet<string>,
): "sell" | "dismantle" | "keep" {
  const r = String(rarity ?? "");
  if (gearRarityRank(r) < 0) return "keep"; // 不认识的稀有度：不碰
  if (dismantleRarities.has(r) && (DISMANTLABLE_RARITIES as readonly string[]).includes(r)) return "dismantle";
  if (sellRarities.has(r)) return "sell";
  return "keep";
}

/** 分页拉取全部装备 */
async function fetchAllGear(api: { gearInventory: (cursor?: string) => Promise<any> }, maxPages = 20): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await api.gearInventory(cursor);
    const gear: any[] = Array.isArray(page?.gear) ? page.gear : [];
    out.push(...gear);
    cursor = page?.nextCursor;
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 300)); // 分页之间稍作间隔
  }
  return out;
}

const definition: ModuleDefinition = {
  id: "auto-sell-gear",
  name: "自动卖装备",
  version: "3.0.0",
  description:
    "按稀有度勾选处理背包装备：勾了「直接卖」的品质卖给 NPC，勾了「分解」的品质分解成装备结晶（分解优先，且只有传说 / 神话 / 奇异可分解）。已穿戴 / 已锁定 / 已挂市场的装备始终不动。建议第一次先开「干跑」看一天。",
  defaultEnabled: false,
  defaultConfig: {
    sellRarities: ["common", "uncommon", "fine", "rare", "epic"],
    dismantleRarities: [],
    maxPerRun: 100,
    minIntervalMin: 10,
    dryRun: false,
  },
  configSchema: [
    {
      key: "sellRarities",
      type: "multi-select",
      label: "直接卖（NPC 回收）这些品质",
      hint: "勾哪个卖哪个，不勾的保留。空着 = 不卖任何装备。",
      default: ["common", "uncommon", "fine", "rare", "epic"],
      options: rarityOptions(),
    },
    {
      key: "dismantleRarities",
      type: "multi-select",
      label: "这些品质拿去分解（换装备结晶）",
      hint: "游戏只允许分解 传说 / 神话 / 奇异，所以这里只列这三档。同时勾了「直接卖」与「分解」时按分解处理。",
      default: [],
      options: rarityCheckboxOptions({ include: DISMANTLABLE_RARITIES }),
    },
    {
      key: "maxPerRun",
      type: "number",
      label: "每轮最多处理件数",
      hint: "防止一次误操作清空背包",
      default: 100,
      min: 1,
      max: 500,
      step: 10,
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
      hint: "打开后只在日志里列出「本该卖 / 本该分解」的清单，不动背包。强烈建议第一次先开着看一天。",
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
      ctx.log.debug("卖装备", msg);
    };

    const label = (r: unknown) => rarityLabel(r);
    const brief = (i: any) =>
      `${i.name}(${label(i.rarity)}${i.quality != null ? `·Q${Math.round(Number(i.quality))}` : ""})`;

    let lastRun = 0;

    const run = async (trigger: string) => {
      const gear = await fetchAllGear(ctx.api);
      if (!gear.length) {
        idle("背包里没有装备");
        return;
      }

      const sellSet = new Set(asStringArray(ctx.config.sellRarities).filter((r) => gearRarityRank(r) >= 0));
      const dismantleSet = new Set(
        asStringArray(ctx.config.dismantleRarities).filter((r) =>
          (DISMANTLABLE_RARITIES as readonly string[]).includes(r),
        ),
      );
      if (!sellSet.size && !dismantleSet.size) {
        idle("没有勾选任何要处理（卖 / 分解）的品质");
        return;
      }

      const toSell: any[] = [];
      const toDismantle: any[] = [];
      let kept = 0;

      for (const item of gear) {
        // 安全底线：已穿戴 / 已锁定 / 已挂市场一律不动
        if (item.equippedSlot || item.isLocked || item.marketOrderId) {
          kept++;
          continue;
        }
        const bucket = bucketOf(item.rarity, sellSet, dismantleSet);
        if (bucket === "sell") toSell.push(item);
        else if (bucket === "dismantle") toDismantle.push(item);
        else kept++;
      }

      // 每轮上限：先满足出售，余额给分解
      const cap = Math.max(1, Number(ctx.config.maxPerRun) || 100);
      const sellNow = toSell.slice(0, cap);
      const dismantleNow = toDismantle.slice(0, Math.max(0, cap - sellNow.length));

      if (!sellNow.length && !dismantleNow.length) {
        idle(`${trigger}：没有需要处理的装备（保留 ${kept} 件）`);
        return;
      }

      /* ---------- 干跑 ---------- */
      if (ctx.config.dryRun) {
        ctx.log.info(
          "卖装备",
          `[干跑] 本该卖 ${sellNow.length} 件（${sellNow.slice(0, 4).map(brief).join("、")}${sellNow.length > 4 ? " 等" : ""}）` +
            `；本该分解 ${dismantleNow.length} 件（${dismantleNow.slice(0, 4).map(brief).join("、")}${dismantleNow.length > 4 ? " 等" : ""}）`,
        );
        return;
      }

      /* ---------- 真正执行 ---------- */
      if (sellNow.length) {
        const r = await ctx.api.gearSell(sellNow.map((i) => i.id));
        const gold = Number(r?.goldEarned) || 0;
        ctx.log.info(
          "卖装备",
          `💰 已卖 ${sellNow.length} 件（${sellNow.slice(0, 4).map(brief).join("、")}${sellNow.length > 4 ? " 等" : ""}）` +
            (gold ? `，获得 ${gold.toLocaleString("zh-CN")} 金币` : ""),
        );
      }

      if (dismantleNow.length) {
        const r = await ctx.api.gearDismantle(dismantleNow.map((i) => i.id));
        const crystal = Number(r?.crystalEarned ?? r?.crystals) || 0;
        ctx.log.info(
          "卖装备",
          `⚗️ 已分解 ${dismantleNow.length} 件（${dismantleNow.slice(0, 4).map(brief).join("、")}${dismantleNow.length > 4 ? " 等" : ""}）` +
            (crystal ? `，获得 ${crystal} 装备结晶` : ""),
        );
      }
    };

    const tryRun = (trigger: string, force = false) => {
      const now = Date.now();
      const intervalMs = Math.max(1, Number(ctx.config.minIntervalMin) || 10) * 60_000;
      if (!force && now - lastRun < intervalMs) return;
      lastRun = now;
      if (S.running) return;
      S.running = true;
      run(trigger)
        .catch((err) => ctx.log.warn("卖装备", `本轮失败：${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          S.running = false;
        });
    };

    // 钓到装备后延时处理（结算里带 gear 才触发）
    ctx.on("fishing:sync", (evt: any) => {
      if ((evt?.settlement?.gear?.length ?? 0) > 0) {
        ctx.schedule(15_000, () => tryRun("钓获装备"));
      }
    });

    ctx.every(Math.max(1, Number(ctx.config.minIntervalMin) || 10) * 60_000, () => tryRun("定时检查"));
    ctx.schedule(20_000, () => tryRun("启动检查", true));
  },
};

export default definition;
