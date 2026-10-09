// 运行时设置：环境变量给初始值，之后以数据库为准，可在后台在线修改、立即生效
//
// 为什么需要它：`ALLOW_REGISTRATION`、每用户账号上限这类值，运维时经常要临时调
// （开一段注册、给某人放宽额度）。要求改 .env 再重启容器太重。
//
// 设计：
//  · 首次启动把环境变量的值写进数据库作为**初始值**，之后不再覆盖（否则重启就白改了）
//  · 读走内存缓存，写入后立刻刷新 —— 修改立即生效，不需要重启
//  · 每个键都有类型与范围校验（zod），不合法直接 400
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { Env } from "../env.ts";

/** 可在后台修改的设置项定义（key → 校验 + 元信息） */
export const SETTING_DEFS = {
  allowRegistration: {
    label: "允许自助注册",
    hint: "关闭后只有管理员能在后台建号，注册页会提示「已关闭自助注册」",
    type: "boolean",
    schema: z.boolean(),
  },
  requireInvite: {
    label: "注册需要邀请码",
    hint: "打开后必须凭邀请码才能注册；关闭则任何人都能直接注册（公开站点请保持打开）",
    type: "boolean",
    schema: z.boolean(),
  },
  maxAccountsPerUser: {
    label: "每个用户可挂账号数",
    hint: "单用户最多能添加几个游戏账号。默认额度，个别用户可在用户管理里单独放宽",
    type: "number",
    schema: z.number().int().min(1).max(100),
  },
  maxRunningAccounts: {
    label: "全局同时运行上限",
    hint: "所有用户加起来最多同时挂机多少个账号，防止把服务器压满",
    type: "number",
    schema: z.number().int().min(1).max(1000),
  },
  logRetentionDays: {
    label: "日志保留天数",
    hint: "超过该天数的运行日志会被自动清理",
    type: "number",
    schema: z.number().int().min(1).max(3650),
  },
  sessionTtlDays: {
    label: "登录态有效期（天）",
    hint: "用户多久不操作就需要重新登录",
    type: "number",
    schema: z.number().int().min(1).max(3650),
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;

export type SettingsValues = {
  allowRegistration: boolean;
  requireInvite: boolean;
  maxAccountsPerUser: number;
  maxRunningAccounts: number;
  logRetentionDays: number;
  sessionTtlDays: number;
};

/** 由环境变量推导初始值（键名与 Env 字段一致） */
function defaultsFromEnv(env: Env): SettingsValues {
  return {
    allowRegistration: env.allowRegistration,
    // 环境变量里没有这一项：默认「需要邀请码」，这是更安全的默认
    requireInvite: true,
    maxAccountsPerUser: env.maxAccountsPerUser,
    maxRunningAccounts: env.maxRunningAccounts,
    logRetentionDays: env.logRetentionDays,
    sessionTtlDays: env.sessionTtlDays,
  };
}

export class SettingsService {
  private db: Db;
  private values: SettingsValues;
  /** 与 env 不同的项（用于在界面上标出「已被改动」） */
  private envDefaults: SettingsValues;
  private listeners = new Set<(v: SettingsValues) => void>();

  constructor(db: Db, env: Env) {
    this.db = db;
    this.envDefaults = defaultsFromEnv(env);

    // 首次启动：把默认值写进库（已存在的键不覆盖 —— 否则重启就把运维改的值冲掉了）
    for (const [key, def] of Object.entries(SETTING_DEFS) as [SettingKey, (typeof SETTING_DEFS)[SettingKey]][]) {
      const existing = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key);
      if (!existing) {
        const initial = this.envDefaults[key];
        this.db.run(
          "INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)",
          key,
          JSON.stringify(initial),
          Date.now(),
        );
      }
      void def;
    }

    this.values = this.readAll();
  }

  private readAll(): SettingsValues {
    const rows = this.db.all<{ key: string; value: string }>("SELECT key, value FROM app_settings");
    const out = { ...this.envDefaults };
    for (const row of rows) {
      const def = SETTING_DEFS[row.key as SettingKey];
      if (!def) continue; // 库里有旧键（已下线的设置项）：忽略而不是报错

      // ★ 值可能是坏 JSON（手工改过库、写入中断、旧版本格式不同）。
      //   这里必须容错：一项坏了只退回该项的默认值，不能让整个服务起不来。
      let raw: unknown;
      try {
        raw = JSON.parse(row.value);
      } catch {
        continue;
      }
      const parsed = def.schema.safeParse(raw);
      if (parsed.success) {
        (out as Record<string, unknown>)[row.key] = parsed.data;
      }
    }
    return out;
  }

  /** 当前生效值（读内存，热路径可放心调用） */
  get all(): SettingsValues {
    return this.values;
  }

  get<K extends SettingKey>(key: K): SettingsValues[K] {
    return this.values[key];
  }

  /** 该项是否被改过（与初始环境值不同） */
  isOverridden(key: SettingKey): boolean {
    return this.values[key] !== this.envDefaults[key];
  }

  /** 环境变量里的初始值（界面上对比展示用） */
  envValue<K extends SettingKey>(key: K): SettingsValues[K] {
    return this.envDefaults[key];
  }

  /** 批量更新；返回实际改动的键 */
  update(patch: Partial<Record<SettingKey, unknown>>, updatedBy: string | null): SettingKey[] {
    const changed: SettingKey[] = [];
    for (const [rawKey, rawValue] of Object.entries(patch)) {
      const key = rawKey as SettingKey;
      const def = SETTING_DEFS[key];
      if (!def) throw new Error(`未知设置项：${rawKey}`);
      if (rawValue === undefined) continue;

      const parsed = def.schema.safeParse(rawValue);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${def.label}：${issue?.message ?? "取值不合法"}`);
      }
      if (this.values[key] === parsed.data) continue;

      this.db.run(
        "UPDATE app_settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?",
        JSON.stringify(parsed.data),
        Date.now(),
        updatedBy,
        key,
      );
      changed.push(key);
    }

    if (changed.length) {
      this.values = this.readAll();
      for (const fn of this.listeners) fn(this.values);
    }
    return changed;
  }

  /** 订阅变更（例如 RunnerRegistry 需要立刻按新的并发上限收紧） */
  onChange(fn: (v: SettingsValues) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 给前端用的清单（含当前值、初始值、是否改过、类型与说明） */
  describe(): {
    key: SettingKey;
    label: string;
    hint: string;
    type: "boolean" | "number";
    value: unknown;
    envValue: unknown;
    overridden: boolean;
  }[] {
    return (Object.entries(SETTING_DEFS) as [SettingKey, (typeof SETTING_DEFS)[SettingKey]][]).map(([key, def]) => ({
      key,
      label: def.label,
      hint: def.hint,
      type: def.type,
      value: this.values[key],
      envValue: this.envDefaults[key],
      overridden: this.isOverridden(key),
    }));
  }
}
