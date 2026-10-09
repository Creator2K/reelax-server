// 自动卖装备：按稀有度阈值处理背包装备
//
// 协议：
//  - GET  /api/inventory/gear?cursor=  → { gear: [{ id, name, rarity, quality, slot,
//                                            equippedSlot, isLocked, marketOrderId }], nextCursor }
//  - POST /api/inventory/gear/sell       { gearIds } → { goldEarned, player, ... }
//  - POST /api/inventory/gear/dismantle  { gearIds } → 装备结晶（游戏只允许 传说/神话/奇异）
//
// ★ 分档是纯阈值判断（不做「保留每部位最优」的复杂排序）：
//     稀有度 < sellBelow        → 卖
//     稀有度 在 [sellBelow, dismantleUpTo] 且可分解 → 分解
//     其余                      → 保留
//   这样规则可预测：用户看一眼配置就知道会卖掉什么。
//
// 安全底线（任何模式下都不动）：
//   已穿戴（equippedSlot）/ 已锁定（isLocked）/ 已挂市场（marketOrderId）
// 另有 maxPerRun 限流与 dryRun 干跑，避免一次误操作清空背包。
import { type ModuleDefinition } from "../types.ts";

/** 游戏只允许分解这三档 */
const DISMANTLABLE = ["legendary", "mythic", "exotic"];
const DISMANTLE_OFF = "";

/** 装备稀有度阶梯（与游戏一致，低 → 高） */
const GEAR_RARITIES = ["common", "uncommon", "fine", "rare", "epic", "legendary", "mythic", "exotic", "arcane"];
const GEAR_RARITY_LABELS: Record<string, string> = {
  common: "普通",
  uncommon: "罕见",
  fine: "精良",
  rare: "稀有",
  epic: "史诗",
  legendary: "传说",
  mythic: "神话",
  exotic: "奇异",
  arcane: "奥秘",
};

const gearRarityRank = (r: unknown): number => GEAR_RARITIES.indexOf(String(r ?? ""));
const rarityLabel = (r: unknown): string => GEAR_RARITY_LABELS[String(r ?? "")] ?? String(r ?? "未知");
const rarityOptions = GEAR_RARITIES.map((r, i) => ({ value: r, label: `${i + 1}级·${GEAR_RARITY_LABELS[r]}` }));

/** 纯阈值分档：sell / dismantle / keep */
export function bucketOf(
  rarity: unknown,
  sellBelowRank: number,
  dismantleUpToRank: number,
): "sell" | "dismantle" | "keep" {
  const rank = gearRarityRank(rarity);
  if (rank < 0) return "keep";
  if (rank < sellBelowRank) return "sell";
  if (
    dismantleUpToRank >= sellBelowRank &&
    rank <= dismantleUpToRank &&
    DISMANTLABLE.includes(String(rarity))
  ) {
    return "dismantle";
  }
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
  version: "2.0.0",
  description:
    "按稀有度阈值处理背包装备：低于设定档位的直接卖（NPC 回收），可选把更高一档分解成装备结晶（默认关闭）。已穿戴 / 已锁定 / 已挂市场的装备始终不动。建议第一次先开「干跑」看一天。",
  defaultEnabled: false,
  defaultConfig: {
    sellBelow: "legendary",
    dismantleUpTo: DISMANTLE_OFF,
    maxPerRun: 100,
    minIntervalMin: 10,
    dryRun: false,
  },
  configSchema: [
    {
      key: "sellBelow",
      type: "select",
      label: "低于此稀有度：直接卖（NPC 回收）",
      hint: "默认「传说」= 普通 / 罕见 / 精良 / 稀有 / 史诗 直接卖",
      default: "legendary",
      options: rarityOptions,
    },
    {
      key: "dismantleUpTo",
      type: "select",
      label: "分解到（换装备结晶，默认关闭）",
      hint: "从上面那一档起、到这个稀有度为止的装备拿去分解。游戏只允许分解 传说/神话/奇异，其它档位会自动保留（不会被卖掉）。",
      default: DISMANTLE_OFF,
      options: [{ value: DISMANTLE_OFF, label: "不分解（只卖）" }, ...rarityOptions],
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
    const S = ctx.state as { running: boolean; lastIdle: string; lastSkipNote: string };
    S.running = false;
    S.lastIdle = "";
    S.lastSkipNote = "";

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

      const sellRank = gearRarityRank(ctx.config.sellBelow);
      const disRank = ctx.config.dismantleUpTo ? gearRarityRank(ctx.config.dismantleUpTo) : -1;
      if (sellRank < 0) {
        ctx.log.warn("卖装备", `出售阈值配置无效：「${String(ctx.config.sellBelow)}」`);
        return;
      }

      const toSell: any[] = [];
      const toDismantle: any[] = [];
      const skippedDismantle: any[] = [];
      let kept = 0;

      for (const item of gear) {
        // 安全底线：已穿戴 / 已锁定 / 已挂市场一律不动
        if (item.equippedSlot || item.isLocked || item.marketOrderId) {
          kept++;
          continue;
        }
        const bucket = bucketOf(item.rarity, sellRank, disRank);
        if (bucket === "sell") {
          toSell.push(item);
        } else if (bucket === "dismantle") {
          toDismantle.push(item);
        } else {
          kept++;
          // 落在分解档但游戏不允许分解（非传说/神话/奇异）→ 保留，并让原因可见
          const rank = gearRarityRank(item.rarity);
          if (disRank >= sellRank && rank >= sellRank && rank <= disRank) skippedDismantle.push(item);
        }
      }

      // 每轮上限：先满足出售，余额给分解
      const cap = Math.max(1, Number(ctx.config.maxPerRun) || 100);
      const sellNow = toSell.slice(0, cap);
      const dismantleNow = toDismantle.slice(0, Math.max(0, cap - sellNow.length));

      if (skippedDismantle.length) {
        const byRarity: Record<string, number> = {};
        for (const i of skippedDismantle) {
          byRarity[i.rarity] = (byRarity[i.rarity] ?? 0) + 1;
        }
        const text = Object.entries(byRarity)
          .map(([r, n]) => `${label(r)}×${n}`)
          .join("、");
        const note = `${text} 落在分解档，但游戏只允许分解传说/神话/奇异，已保留`;
        if (S.lastSkipNote !== note) {
          S.lastSkipNote = note;
          ctx.log.info("卖装备", note);
        }
      }

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
