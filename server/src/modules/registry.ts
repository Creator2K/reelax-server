// 内置模块清单
//
// ★ 顺序 = 前端展示顺序。第一个是唯一默认开启的模块。
// ★ ID 与原桌面端的插件 ID 保持一致，便于对照文档与排障话术。
// ★ 这里**显式列出**要交付的功能，不做目录扫描 —— 一个功能要么在清单里，要么不存在。
//
// 配置项默认值全部取自实测可用的旧实现，不要凭感觉改：
// 它们对应游戏里的具体物价/节奏（例如鱼饵 ID、专精保护阈值）。
import { rarityOptions } from "./shared/rarity.ts";
import type { ConfigField, ConfigValues, ModuleDefinition } from "./types.ts";
import keepOnline from "./keep-online/index.ts";
import autoSchedule from "./auto-schedule/index.ts";
import dailyCheckin from "./daily-checkin/index.ts";
import autoStats from "./auto-stats/index.ts";
import autoMastery from "./auto-mastery/index.ts";
import autoTravel from "./auto-travel/index.ts";
import autoBait from "./auto-bait/index.ts";
import autoTournament from "./auto-tournament/index.ts";
import autoWorldBoss from "./auto-world-boss/index.ts";
import autoSellGear from "./auto-sell-gear/index.ts";
import autoLoadout from "./auto-loadout/index.ts";
import autoXpBuff from "./auto-xp-buff/index.ts";
import dailyDigest from "./daily-digest/index.ts";
import autoPity from "./auto-pity/index.ts";
import autoGuildBoost from "./auto-guild-boost/index.ts";
import autoSacrifice from "./auto-sacrifice/index.ts";

export const MODULES: ModuleDefinition[] = [
  keepOnline,
  autoSchedule,
  dailyCheckin,
  autoStats,
  autoMastery,
  autoTravel,
  autoPity,
  autoGuildBoost,
  autoSacrifice,
  autoBait,
  autoTournament,
  autoWorldBoss,
  autoSellGear,
  autoLoadout,
  autoXpBuff,
  dailyDigest,
];

export const MODULE_IDS = MODULES.map((m) => m.id);

/** 新账号默认只开这一个（与原桌面端一致） */
export const DEFAULT_ENABLED_MODULES = ["keep-online"];

export const moduleById = new Map(MODULES.map((m) => [m.id, m]));

export function getModule(id: string): ModuleDefinition | undefined {
  return moduleById.get(id);
}

/** 对外的模块清单（不含实现函数） */
export function moduleCatalog(opts?: {
  /** 判定某模块是否因缺少前置条件而不可用；返回原因字符串表示不可用 */
  unavailableReason?: (def: ModuleDefinition) => string | null;
}): ModuleCatalogEntry[] {
  return MODULES.map((m) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    defaultEnabled: m.defaultEnabled,
    defaultConfig: m.defaultConfig,
    /**
     * configSchema 直接下发，但模板字段要补上变量清单 ——
     * 变量由**模块自己**声明（单一来源），这里只负责注入，
     * 前端因此不需要硬编码任何变量名。
     */
    configSchema: m.configSchema.map((f) =>
      f.type === "template"
        ? ({
            ...f,
            vars: m.templateVars ?? [],
            ...(m.defaultTemplate ? { defaultTemplate: m.defaultTemplate } : {}),
          } as typeof f)
        : f,
    ),
    requiresNotification: Boolean(m.requiresNotification),
    unavailable: opts?.unavailableReason?.(m) ?? null,
  }));
}

export type ModuleCatalogEntry = {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultEnabled: boolean;
  defaultConfig: ConfigValues;
  configSchema: ConfigField[];
  requiresNotification: boolean;
  /** 非 null 表示当前不可用，内容是可展示给用户的原因 */
  unavailable: string | null;
};

/** 启动时自检：id 唯一、名字与默认配置齐全（配置写错在这里就该炸，而不是运行时） */
export function assertRegistryValid(): void {
  const seen = new Set<string>();
  for (const m of MODULES) {
    if (!m.id) throw new Error("模块缺少 id");
    if (seen.has(m.id)) throw new Error(`模块 id 重复：${m.id}`);
    seen.add(m.id);
    if (!m.name) throw new Error(`模块 ${m.id} 缺少 name`);
    if (!Array.isArray(m.configSchema)) throw new Error(`模块 ${m.id} 的 configSchema 不是数组`);

    const keys = new Set<string>();
    for (const f of m.configSchema) {
      if (keys.has(f.key)) throw new Error(`模块 ${m.id} 的配置项重复：${f.key}`);
      keys.add(f.key);
      if (f.type === "select" && (!f.options || f.options.length === 0)) {
        throw new Error(`模块 ${m.id} 的 select 配置 ${f.key} 没有 options`);
      }
      if (f.type === "number" && f.min !== undefined && f.max !== undefined && f.min > f.max) {
        throw new Error(`模块 ${m.id} 的配置 ${f.key} 的 min > max`);
      }
    }
  }
}

export { rarityOptions };
export type { ConfigField, ConfigValues, ModuleDefinition };
export type { ModuleContext } from "./types.ts";
