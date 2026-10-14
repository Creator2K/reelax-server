// 一次性配置升级：把旧版本的配置键换算成新键，并把旧键从库里**删掉**
//
// ★ 为什么必须这样做（真实踩过的坑）：
//   `resolveModuleConfig` 会把**不认识的旧键原样保留** —— 这是对的（不能静默抹掉用户数据），
//   但它带来一个隐蔽后果：模块代码里写的「兼容旧键」分支会**永久生效**，
//   因为旧键永远留在库里。1.8.0 的「跟船队走」就是活例子：
//   旧键 fleetMode=follow 一直在，用户把它从优先级列表里删掉，下次启动又被自动加回最前面，
//   怎么改都改不掉，用户只能看着它反复出现。
//
// 所以：升级时一次性换算 + 删除旧键，之后模块代码只认新键、不再写兼容分支。
// 幂等：只在检测到旧键时动手，换算完旧键就没了。
import type { Repos } from "../db/repositories/index.ts";
import {
  DISMANTLABLE_RARITIES,
  RARITIES,
  STAT_KEYS,
  raritiesAtOrAbove,
  raritiesBelow,
  rarityRank,
} from "./shared/rarity.ts";

type Config = Record<string, unknown>;

type Upgrade = {
  /** 日志里说明这次换算做了什么 */
  note: string;
  /** 返回新配置；没有旧键（不需要升级）时返回 null */
  run: (config: Config) => Config | null;
};

const asArray = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => String(x))
    : String(v ?? "")
        .split(/[,，\s]+/)
        .filter(Boolean);

/** "2:3:0:1" → [2,3,0,1]（老格式的顺序是固定的 力量:智力:运气:耐力） */
function parseLegacyQuad(input: unknown): number[] | null {
  const parts = String(input ?? "")
    .split(/[:：,，\s]+/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (parts.length !== 4) return null;
  const nums = parts.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums;
}

const UPGRADES: Record<string, Upgrade> = {
  /**
   * 自动切图：`fleetMode: "follow"` → 优先级列表里的 `follow` 项。
   * 换算后删掉 fleetMode，用户才能真正把它从列表里去掉。
   */
  "auto-travel": {
    note: "fleetMode → 优先级列表里的「跟船队走」",
    run: (config) => {
      if (!("fleetMode" in config)) return null;
      const { fleetMode, ...rest } = config;
      const list = asArray(rest.priorities).filter((p) => p !== "follow");
      if (String(fleetMode) === "follow") list.unshift("follow");
      return { ...rest, priorities: list.length ? list : ["competition", "golden", "experience"] };
    },
  },

  /**
   * 自动卖装备：两处阈值下拉 → 两个勾选集合。
   *   sellBelow      = 低于此档直接卖  → sellRarities = 比它低的全部档
   *   dismantleUpTo  = 分解到这一档    → dismantleRarities = [sellBelow, dismantleUpTo] 里可分解的档
   */
  "auto-sell-gear": {
    note: "sellBelow / dismantleUpTo → sellRarities / dismantleRarities",
    run: (config) => {
      if (!("sellBelow" in config) && !("dismantleUpTo" in config)) return null;
      const { sellBelow, dismantleUpTo, ...rest } = config;

      const sellRank = rarityRank(sellBelow);
      const sellRarities =
        sellRank > 0 ? raritiesBelow(sellBelow) : asArray(rest.sellRarities).filter((r) => rarityRank(r) >= 0);

      const disRank = rarityRank(dismantleUpTo);
      const dismantleRarities =
        sellRank >= 0 && disRank >= sellRank
          ? RARITIES.filter(
              (r, i) => i >= sellRank && i <= disRank && DISMANTLABLE_RARITIES.includes(r),
            )
          : asArray(rest.dismantleRarities).filter((r) => DISMANTLABLE_RARITIES.includes(r as never));

      return { ...rest, sellRarities, dismantleRarities };
    },
  },

  /**
   * 自动专精献祭：`excludeBelow`（不献祭低于此档）→ 献祭模式 + 自选集合。
   *
   * ★ 旧值等于旧默认（"common" = 不排除任何档 = 全部都献）时，换成**新默认**
   *   （保护传说及以上）而不是「全部献祭」：那多半是用户从没动过这一项，
   *   而新版本刻意把默认改成了保护高稀有度 —— 沿用一个没人选过的旧默认，
   *   用户反而看不到这次新增的保护。
   *   用户**特意**排除过低档位（rank > 0）时，按原意换算成自选集合。
   */
  "auto-mastery": {
    note: "excludeBelow → sacrificeMode / sacrificeRarities",
    run: (config) => {
      if (!("excludeBelow" in config)) return null;
      const { excludeBelow, ...rest } = config;
      const rank = rarityRank(excludeBelow);
      if (rank <= 0) return { ...rest, sacrificeMode: "protectLegendary", sacrificeRarities: [] };
      return { ...rest, sacrificeMode: "custom", sacrificeRarities: raritiesAtOrAbove(excludeBelow) };
    },
  },

  /**
   * 自动加点：按位置解释的 "2:3:0:1" / "0:2000:0:100" → 有序 + 带数值的 statPlan。
   * 用当前 mode 决定拿哪一份数据（配比模式用 ratio，其余用 targets）。
   */
  "auto-stats": {
    note: "ratio / targets / primary → statPlan（顺序 + 数值）",
    run: (config) => {
      if (!("ratio" in config) && !("targets" in config) && !("primary" in config)) return null;
      const { ratio, targets, primary: _primary, ...rest } = config;
      const source = String(rest.mode ?? "priority") === "ratio" ? ratio : targets;
      const nums = parseLegacyQuad(source) ?? parseLegacyQuad(targets) ?? [0, 0, 0, 0];
      const statPlan = STAT_KEYS.map((key, i) => ({ key, value: nums[i] ?? 0 }));
      return { ...rest, statPlan };
    },
  },

  /**
   * 保底切图：单目标（rarity + targetBiome + thresholdCasts）→ 多目标（rarities + 各自的图与阈值）。
   *
   * 旧配置只盯一档，升级后**只把那一档勾上**、地图与阈值照搬，另一档留默认值 ——
   * 不能凭空给用户多监控一档（那可能让他被切到没打算去的图）。
   */
  "auto-pity": {
    note: "rarity / targetBiome / thresholdCasts → rarities + 各自的地图与阈值",
    run: (config) => {
      if (!("rarity" in config) && !("targetBiome" in config) && !("thresholdCasts" in config)) return null;
      const { rarity, targetBiome, thresholdCasts, ...rest } = config;
      const picked = String(rarity) === "exotic" ? "exotic" : "arcane"; // 旧默认是奥秘
      const biome = String(targetBiome ?? "").trim() || "b_015";
      const threshold = Math.max(1, Number(thresholdCasts) || 30);
      return {
        ...rest,
        rarities: [picked],
        ...(picked === "exotic"
          ? { exoticBiome: biome, exoticThreshold: threshold }
          : { arcaneBiome: biome, arcaneThreshold: threshold }),
      };
    },
  },
};

export type UpgradeReport = {
  /** 扫描到的配置行数 */
  scanned: number;
  /** 实际改写过的（moduleId@accountId 前缀） */
  changed: string[];
};

/**
 * 扫描所有账号的模块配置，把旧键换算成新键并删除旧键。
 *
 * 在服务启动、迁移执行完之后调用一次即可（幂等）。
 */
export function upgradeModuleConfigs(repos: Repos): UpgradeReport {
  const changed: string[] = [];
  let scanned = 0;

  for (const [moduleId, upgrade] of Object.entries(UPGRADES)) {
    let rows;
    try {
      rows = repos.modules.listByModule(moduleId);
    } catch {
      continue; // 表还没建好（迁移未跑）时不该让启动失败
    }
    for (const row of rows) {
      scanned += 1;
      const next = upgrade.run(row.config);
      if (!next) continue;
      repos.modules.replaceConfig(row.accountId, moduleId, next);
      changed.push(`${moduleId}@${row.accountId.slice(0, 8)}`);
    }
  }

  return { scanned, changed };
}
