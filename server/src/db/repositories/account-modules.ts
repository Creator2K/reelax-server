// 账号 × 模块配置仓储
//
// config_json 存 JSON 字符串。读取时与模块 defaultConfig 的合并由 module service 负责，
// 这里只保证「存取不丢字段」——未知的旧键会原样保留，避免用户配置被静默抹掉。
import { BaseRepo, now, parseJson } from "./base.ts";

export type AccountModuleRow = {
  account_id: string;
  module_id: string;
  enabled: number;
  config_json: string;
  updated_at: number;
};

export type ModuleState = {
  moduleId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  updatedAt: number;
};

export class AccountModulesRepo extends BaseRepo {
  listForAccount(accountId: string): ModuleState[] {
    const rows = this.db.all<AccountModuleRow>(
      "SELECT * FROM account_modules WHERE account_id = ?",
      accountId,
    );
    return rows.map((r) => ({
      moduleId: r.module_id,
      enabled: Number(r.enabled) === 1,
      config: parseJson<Record<string, unknown>>(r.config_json, {}),
      updatedAt: Number(r.updated_at),
    }));
  }

  /** 单条（不存在返回 null，表示「用默认策略」） */
  find(accountId: string, moduleId: string): ModuleState | null {
    const r = this.db.get<AccountModuleRow>(
      "SELECT * FROM account_modules WHERE account_id = ? AND module_id = ?",
      accountId,
      moduleId,
    );
    if (!r) return null;
    return {
      moduleId: r.module_id,
      enabled: Number(r.enabled) === 1,
      config: parseJson<Record<string, unknown>>(r.config_json, {}),
      updatedAt: Number(r.updated_at),
    };
  }

  /** 是否存在该账号对某模块的显式记录 */
  has(accountId: string, moduleId: string): boolean {
    const r = this.db.get<{ c: number }>(
      "SELECT count(*) AS c FROM account_modules WHERE account_id = ? AND module_id = ?",
      accountId,
      moduleId,
    );
    return Number(r?.c ?? 0) > 0;
  }

  /**
   * 写入（部分更新语义）：
   *  - enabled 传 undefined = 不改
   *  - config 传对象 = 与已有 config 合并（浅合并一层，值级覆盖）
   */
  upsert(
    accountId: string,
    moduleId: string,
    patch: { enabled?: boolean; config?: Record<string, unknown> },
  ): ModuleState {
    const cur = this.find(accountId, moduleId);
    const nextEnabled = patch.enabled ?? cur?.enabled ?? false;
    const nextConfig = patch.config ? { ...(cur?.config ?? {}), ...patch.config } : (cur?.config ?? {});

    this.db.run(
      `INSERT INTO account_modules (account_id, module_id, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, module_id) DO UPDATE SET
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
      accountId,
      moduleId,
      nextEnabled ? 1 : 0,
      JSON.stringify(nextConfig),
      now(),
    );

    return { moduleId, enabled: nextEnabled, config: nextConfig, updatedAt: now() };
  }

  /**
   * 替换整个 config（用于「恢复默认」）。
   * ★ 不改变 enabled —— 恢复默认配置不该顺手把功能开关也重置掉，
   *   否则用户点一下「恢复默认」就意外关掉了功能。
   */
  replaceConfig(accountId: string, moduleId: string, config: Record<string, unknown>): ModuleState {
    const current = this.find(accountId, moduleId);
    const enabled = current?.enabled ?? false;
    this.db.run(
      `INSERT INTO account_modules (account_id, module_id, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, module_id) DO UPDATE SET
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
      accountId,
      moduleId,
      enabled ? 1 : 0,
      JSON.stringify(config),
      now(),
    );
    const state = this.find(accountId, moduleId);
    if (!state) throw new Error("写入模块配置后读取失败");
    return state;
  }

  delete(accountId: string, moduleId: string): boolean {
    return (
      Number(
        this.db.run("DELETE FROM account_modules WHERE account_id = ? AND module_id = ?", accountId, moduleId).changes,
      ) > 0
    );
  }

  /* ---------------- 运行状态（跨重启保留） ---------------- */

  /**
   * 读取模块自己持久化的运行状态（没有则返回 {}）。
   * 只读 state_json，不碰 config —— 状态不该出现在配置界面里。
   */
  getState(accountId: string, moduleId: string): Record<string, unknown> {
    const r = this.db.get<{ state_json: string }>(
      "SELECT state_json FROM account_modules WHERE account_id = ? AND module_id = ?",
      accountId,
      moduleId,
    );
    return parseJson<Record<string, unknown>>(r?.state_json, {});
  }

  /**
   * 写入模块运行状态。
   *
   * ★ 只有已存在配置行（用户配置过这个模块）时才写：
   *   不能为了存状态而 INSERT 一行 —— 新行的 enabled 默认是 0，
   *   而 isEnabled() 会优先读库里的值，等于顺手把默认启用的模块关掉。
   */
  setState(accountId: string, moduleId: string, state: Record<string, unknown>): boolean {
    const res = this.db.run(
      "UPDATE account_modules SET state_json = ?, updated_at = ? WHERE account_id = ? AND module_id = ?",
      JSON.stringify(state ?? {}),
      now(),
      accountId,
      moduleId,
    );
    return Number(res.changes) > 0;
  }

  /** 删除某账号的全部模块配置（账号删除时由外键级联，这里供显式调用） */
  deleteForAccount(accountId: string): number {
    return Number(this.db.run("DELETE FROM account_modules WHERE account_id = ?", accountId).changes);
  }
}
