// 游戏账号仓储
//
// credential 密文列（password_enc / cookie_enc）在列表与详情查询里都不返回；
// 需要真实凭证时用 findCredentials()，由 service 层解密后立即交给 GameClient。
import { BaseRepo, newId, nn, now } from "./base.ts";

export type AuthType = "credentials" | "cookie";
export type AccountStatus = "stopped" | "starting" | "online" | "reconnecting" | "error" | "expired";

export type AccountRow = {
  id: string;
  user_id: string;
  label: string;
  auth_type: AuthType;
  email: string;
  password_enc: string | null;
  cookie_enc: string | null;
  base_url: string;
  proxy_id: string | null;
  auto_start: number;
  status: AccountStatus;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

/** 不含密文的对外行 */
export type AccountSafeRow = Omit<AccountRow, "password_enc" | "cookie_enc"> & {
  has_password: number;
  has_cookie: number;
  proxy_label: string | null;
};

/** 运行时需要的凭证（调用方用完即弃，不要缓存） */
export type AccountCredentials = {
  id: string;
  userId: string;
  authType: AuthType;
  email: string;
  passwordEnc: string | null;
  cookieEnc: string | null;
  baseUrl: string;
  proxyId: string | null;
};

const SAFE_SELECT = `
  SELECT a.id, a.user_id, a.label, a.auth_type, a.email, a.base_url, a.proxy_id,
         a.auto_start, a.status, a.last_error, a.created_at, a.updated_at,
         (a.password_enc IS NOT NULL) AS has_password,
         (a.cookie_enc   IS NOT NULL) AS has_cookie,
         p.label AS proxy_label
    FROM game_accounts a
    LEFT JOIN proxies p ON p.id = a.proxy_id
`;

export class AccountsRepo extends BaseRepo {
  findSafe(id: string, userId: string): AccountSafeRow | undefined {
    return this.db.get<AccountSafeRow>(`${SAFE_SELECT} WHERE a.id = ? AND a.user_id = ?`, id, userId);
  }

  /** 内部用：不做用户过滤（仅在已知归属的上下文中使用） */
  findById(id: string): AccountRow | undefined {
    return this.db.get<AccountRow>("SELECT * FROM game_accounts WHERE id = ?", id);
  }

  /** 全部账号原始行（服务启动时建立运行时用，包含全部用户） */
  listAll(): AccountRow[] {
    return this.db.all<AccountRow>("SELECT * FROM game_accounts ORDER BY created_at ASC");
  }

  listSafeForUser(userId: string): AccountSafeRow[] {
    return this.db.all<AccountSafeRow>(`${SAFE_SELECT} WHERE a.user_id = ? ORDER BY a.created_at ASC`, userId);
  }

  /** 全部账号（服务启动时恢复 autoStart 用），只取必要字段 */
  listAutoStart(): AccountCredentials[] {
    const rows = this.db.all<AccountRow>(
      "SELECT * FROM game_accounts WHERE auto_start = 1 ORDER BY created_at ASC",
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      authType: r.auth_type,
      email: r.email,
      passwordEnc: r.password_enc,
      cookieEnc: r.cookie_enc,
      baseUrl: r.base_url,
      proxyId: r.proxy_id,
    }));
  }

  countForUser(userId: string): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM game_accounts WHERE user_id = ?", userId);
    return Number(r?.c ?? 0);
  }

  /** 建连接时才取凭证 */
  findCredentials(id: string, userId: string): AccountCredentials | undefined {
    const r = this.db.get<AccountRow>(
      "SELECT * FROM game_accounts WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!r) return undefined;
    return {
      id: r.id,
      userId: r.user_id,
      authType: r.auth_type,
      email: r.email,
      passwordEnc: r.password_enc,
      cookieEnc: r.cookie_enc,
      baseUrl: r.base_url,
      proxyId: r.proxy_id,
    };
  }

  create(input: {
    userId: string;
    label: string;
    authType: AuthType;
    email: string;
    passwordEnc?: string | null;
    cookieEnc?: string | null;
    baseUrl: string;
    proxyId?: string | null;
    autoStart?: boolean;
  }): AccountRow {
    const id = newId();
    const ts = now();
    this.db.run(
      `INSERT INTO game_accounts
         (id, user_id, label, auth_type, email, password_enc, cookie_enc, base_url, proxy_id, auto_start, status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', NULL, ?, ?)`,
      id,
      input.userId,
      input.label.trim(),
      input.authType,
      input.email.trim(),
      nn(input.passwordEnc),
      nn(input.cookieEnc),
      input.baseUrl,
      nn(input.proxyId),
      input.autoStart === false ? 0 : 1,
      ts,
      ts,
    );
    const row = this.findById(id);
    if (!row) throw new Error("创建账号后读取失败");
    return row;
  }

  /**
   * 更新。密文字段语义：undefined = 不改，null = 清空，字符串 = 设为新密文。
   * proxyId 同理（null = 解绑）。
   */
  update(
    id: string,
    userId: string,
    patch: {
      label?: string;
      authType?: AuthType;
      email?: string;
      passwordEnc?: string | null;
      cookieEnc?: string | null;
      baseUrl?: string;
      proxyId?: string | null;
      autoStart?: boolean;
    },
  ): AccountRow | undefined {
    const cur = this.findById(id);
    if (!cur || cur.user_id !== userId) return undefined;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const push = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };

    if (patch.label !== undefined) push("label", patch.label.trim());
    if (patch.authType !== undefined) push("auth_type", patch.authType);
    if (patch.email !== undefined) push("email", patch.email.trim());
    if (patch.passwordEnc !== undefined) push("password_enc", nn(patch.passwordEnc));
    if (patch.cookieEnc !== undefined) push("cookie_enc", nn(patch.cookieEnc));
    if (patch.baseUrl !== undefined) push("base_url", patch.baseUrl);
    if (patch.proxyId !== undefined) push("proxy_id", nn(patch.proxyId));
    if (patch.autoStart !== undefined) push("auto_start", patch.autoStart ? 1 : 0);

    if (!sets.length) return cur;
    push("updated_at", now());
    params.push(id, userId);
    this.db.run(`UPDATE game_accounts SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, ...params);
    return this.findById(id);
  }

  /** 运行时状态回写（不常驻内存的部分：状态与错误） */
  setStatus(id: string, status: AccountStatus, lastError: string | null = null): void {
    this.db.run("UPDATE game_accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?", status, lastError, now(), id);
  }

  delete(id: string, userId: string): boolean {
    return Number(this.db.run("DELETE FROM game_accounts WHERE id = ? AND user_id = ?", id, userId).changes) > 0;
  }

  /** 启动时把所有账号状态复位（上次进程被杀时留下的 running 状态是脏数据） */
  resetAllStatuses(): void {
    this.db.run("UPDATE game_accounts SET status = 'stopped', last_error = NULL WHERE status != 'stopped'");
  }

  /** 引用了某代理的账号（代理连通性失败时用于提示影响面） */
  listByProxy(proxyId: string): AccountRow[] {
    return this.db.all<AccountRow>("SELECT * FROM game_accounts WHERE proxy_id = ?", proxyId);
  }
}

export function accountSafeToApi(row: AccountSafeRow): {
  id: string;
  label: string;
  authType: AuthType;
  email: string;
  hasPassword: boolean;
  hasCookie: boolean;
  baseUrl: string;
  proxyId: string | null;
  proxyLabel: string | null;
  autoStart: boolean;
  status: AccountStatus;
  lastError: string | null;
  createdAt: number;
} {
  return {
    id: row.id,
    label: row.label,
    authType: row.auth_type,
    email: row.email,
    hasPassword: Number(row.has_password) === 1,
    hasCookie: Number(row.has_cookie) === 1,
    baseUrl: row.base_url,
    proxyId: row.proxy_id,
    proxyLabel: row.proxy_label,
    autoStart: Number(row.auto_start) === 1,
    status: row.status,
    lastError: row.last_error,
    createdAt: Number(row.created_at),
  };
}
