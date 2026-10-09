// 内置模块的类型契约
//
// 这是「插件系统」被移除后取代它的东西：不再有动态加载、注册表、热导入，
// 只有一组编译期就确定的内置模块，由 Runner 直接调用。
//
// 每个模块的 configSchema 既驱动前端表单渲染，也用于后端校验配置值。
import type { AccountRuntime } from "../game/account-runtime.ts";
import type { ChildLogger } from "../lib/logger.ts";
import type { GameClient } from "../game/client.ts";

/* ---------- 配置字段（前端按 type 渲染） ---------- */

export type ConfigFieldBase = {
  key: string;
  label: string;
  hint?: string;
};

export type BooleanField = ConfigFieldBase & { type: "boolean"; default: boolean };
export type NumberField = ConfigFieldBase & {
  type: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
};
export type StringField = ConfigFieldBase & { type: "string"; default: string; placeholder?: string };
export type TextareaField = ConfigFieldBase & { type: "textarea"; default: string; placeholder?: string };
export type SelectField = ConfigFieldBase & {
  type: "select";
  default: string;
  options: { value: string; label: string }[];
};

export type ConfigField = BooleanField | NumberField | StringField | TextareaField | SelectField;

export type ConfigValues = Record<string, unknown>;

/* ---------- 运行上下文（模块在 onStart 里拿到的） ---------- */

export type ModuleContext = {
  readonly moduleId: string;
  /** 本模块在本账号的配置（defaultConfig 与用户配置合并后的结果，已校验） */
  readonly config: ConfigValues;
  /** 模块私有内存（停止后清空，不持久化） */
  readonly state: Record<string, unknown>;
  /** 带账号与模块标签的日志 */
  readonly log: ChildLogger;
  /** 签名游戏客户端 */
  readonly api: GameClient;
  /** 账号运行时：状态上报 + 定时器 + 事件订阅 */
  readonly account: AccountRuntime;
  /** 订阅账号级事件（账号停止时自动取消） */
  on: AccountRuntime["on"];
  /** 受管定时器（账号停止时自动清理） */
  every: AccountRuntime["every"];
  /** 受管延时任务 */
  schedule: AccountRuntime["schedule"];
};

/* ---------- 模块定义 ---------- */

export type ModuleDefinition = {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 新账号是否默认启用（只有保持在线是 true） */
  defaultEnabled: boolean;
  defaultConfig: ConfigValues;
  configSchema: ConfigField[];
  /**
   * 该模块是否依赖「推送通道」（如收益日报）。
   * 为 true 时，用户没有任何可用推送通道就不允许启用/配置它。
   */
  requiresNotification?: boolean;
  /**
   * 启动前检查。抛错则本模块不启动，错误会显示在账号详情页的模块卡片上。
   * 用于「缺前置条件就别开」的场景（例如与官方航线助手硬冲突）。
   */
  onStart?(ctx: ModuleContext): Promise<void>;
  /** 停止时清理自有资源（ctx.every / ctx.on 由 Runner 自动清理） */
  onStop?(ctx: ModuleContext): Promise<void>;
};

/** 把 configSchema 的默认值收成一份 defaultConfig（校验 registry 用） */
export function defaultsFromSchema(schema: ConfigField[]): ConfigValues {
  const out: ConfigValues = {};
  for (const f of schema) out[f.key] = f.default;
  return out;
}

/* ---------- 配置合并与校验 ---------- */

export type ConfigIssue = { key: string; message: string; value: unknown };

/**
 * 合并并校验用户配置。
 * 原则：**未知旧键原样保留**（避免用户配置被静默抹掉），只对已知字段做类型收敛。
 */
export function resolveModuleConfig(
  def: ModuleDefinition,
  stored: ConfigValues | undefined,
): { config: ConfigValues; issues: ConfigIssue[] } {
  const allowed = new Set(def.configSchema.map((f) => f.key));
  const merged: ConfigValues = { ...def.defaultConfig, ...(stored ?? {}) };
  const issues: ConfigIssue[] = [];

  for (const field of def.configSchema) {
    const raw = merged[field.key];
    switch (field.type) {
      case "boolean": {
        if (typeof raw !== "boolean") {
          // 兼容历史数据里用 0/1 或 "true" 存的布尔
          if (raw === 0 || raw === 1) merged[field.key] = raw === 1;
          else if (raw === "true" || raw === "false") merged[field.key] = raw === "true";
          else if (raw === undefined || raw === null) merged[field.key] = field.default;
          else {
            issues.push({ key: field.key, message: "应为布尔值", value: raw });
            merged[field.key] = field.default;
          }
        }
        break;
      }
      case "number": {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(n)) {
          issues.push({ key: field.key, message: "应为数字", value: raw });
          merged[field.key] = field.default;
          break;
        }
        let v = n;
        if (field.min !== undefined && v < field.min) v = field.min;
        if (field.max !== undefined && v > field.max) v = field.max;
        merged[field.key] = v;
        break;
      }
      case "string":
      case "textarea": {
        if (typeof raw !== "string") {
          issues.push({ key: field.key, message: "应为字符串", value: raw });
          merged[field.key] = field.default;
        }
        break;
      }
      case "select": {
        const valid = field.options.some((o) => o.value === raw);
        if (!valid) {
          issues.push({ key: field.key, message: `取值必须是 ${field.options.map((o) => o.value).join(" / ")} 之一`, value: raw });
          merged[field.key] = field.default;
        }
        break;
      }
    }
  }

  // 未知键保留，但记录一条提示（便于发现旧版本残留配置）
  for (const k of Object.keys(merged)) {
    if (!allowed.has(k)) {
      issues.push({ key: k, message: "不是当前版本认识的配置项（已保留原值，不影响运行）", value: merged[k] });
    }
  }

  return { config: merged, issues };
}

/** 只保留 configSchema 认识的键（用于「恢复默认」） */
export function pickKnownConfig(def: ModuleDefinition, stored: ConfigValues | undefined): ConfigValues {
  const out: ConfigValues = {};
  for (const f of def.configSchema) {
    if (stored && stored[f.key] !== undefined) out[f.key] = stored[f.key];
  }
  return out;
}

/** 把「PATCH 部分配置」收敛为「只含合法键的补丁」，非法值直接报错（不静默丢弃） */
export function validateConfigPatch(
  def: ModuleDefinition,
  patch: ConfigValues,
): { patch: ConfigValues; errors: ConfigIssue[] } {
  const byKey = new Map(def.configSchema.map((f) => [f.key, f]));
  const out: ConfigValues = {};
  const errors: ConfigIssue[] = [];

  for (const [k, v] of Object.entries(patch)) {
    const field = byKey.get(k);
    if (!field) {
      errors.push({ key: k, message: "不是该模块的配置项", value: v });
      continue;
    }
    switch (field.type) {
      case "boolean":
        if (typeof v !== "boolean") errors.push({ key: k, message: "应为布尔值", value: v });
        else out[k] = v;
        break;
      case "number": {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) {
          errors.push({ key: k, message: "应为数字", value: v });
        } else if (field.min !== undefined && n < field.min) {
          errors.push({ key: k, message: `不能小于 ${field.min}`, value: v });
        } else if (field.max !== undefined && n > field.max) {
          errors.push({ key: k, message: `不能大于 ${field.max}`, value: v });
        } else {
          out[k] = n;
        }
        break;
      }
      case "string":
      case "textarea":
        if (typeof v !== "string") errors.push({ key: k, message: "应为字符串", value: v });
        else if (field.type === "string" && v.length > 200) errors.push({ key: k, message: "过长", value: v });
        else out[k] = v;
        break;
      case "select":
        if (!field.options.some((o) => o.value === v)) {
          errors.push({ key: k, message: `取值必须是 ${field.options.map((o) => o.value).join(" / ")} 之一`, value: v });
        } else {
          out[k] = v;
        }
        break;
    }
  }

  return { patch: out, errors };
}
