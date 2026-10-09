// 代理仓储
//
// password_enc 同样是密文；列表查询不触碰它，只有真正建连接时才解密。
import { BaseRepo, newId, nn, now } from "./base.ts";

export type ProxyProtocol = "http" | "https" | "socks5";

export type ProxyRow = {
  id: string;
  user_id: string;
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password_enc: string | null;
  last_check_at: number | null;
  last_check_ok: number | null;
  last_check_ms: number | null;
  last_exit_ip: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type ProxyCheckResult = {
  ok: boolean;
  latencyMs: number | null;
  exitIp: string | null;
  error: string | null;
};

export class ProxiesRepo extends BaseRepo {
  findById(id: string): ProxyRow | undefined {
    return this.db.get<ProxyRow>("SELECT * FROM proxies WHERE id = ?", id);
  }

  /** ★ 必须带 userId：防止跨用户读取 */
  findOwned(id: string, userId: string): ProxyRow | undefined {
    return this.db.get<ProxyRow>("SELECT * FROM proxies WHERE id = ? AND user_id = ?", id, userId);
  }

  listForUser(userId: string): ProxyRow[] {
    return this.db.all<ProxyRow>("SELECT * FROM proxies WHERE user_id = ? ORDER BY created_at DESC", userId);
  }

  countForUser(userId: string): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM proxies WHERE user_id = ?", userId);
    return Number(r?.c ?? 0);
  }

  /** 每个代理被多少账号绑定（用于 UI 提示「删除会影响这些账号」） */
  boundAccountCount(proxyId: string): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM game_accounts WHERE proxy_id = ?", proxyId);
    return Number(r?.c ?? 0);
  }

  create(input: {
    userId: string;
    label: string;
    protocol: ProxyProtocol;
    host: string;
    port: number;
    username?: string | null;
    passwordEnc?: string | null;
  }): ProxyRow {
    const id = newId();
    const ts = now();
    this.db.run(
      `INSERT INTO proxies (id, user_id, label, protocol, host, port, username, password_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.label.trim(),
      input.protocol,
      input.host.trim(),
      input.port,
      nn(input.username),
      nn(input.passwordEnc),
      ts,
      ts,
    );
    const row = this.findById(id);
    if (!row) throw new Error("创建代理后读取失败");
    return row;
  }

  update(
    id: string,
    userId: string,
    patch: {
      label?: string;
      protocol?: ProxyProtocol;
      host?: string;
      port?: number;
      /** 传 undefined = 不改；传 null = 清空；传字符串 = 设为新密文 */
      username?: string | null;
      passwordEnc?: string | null;
    },
  ): ProxyRow | undefined {
    const cur = this.findOwned(id, userId);
    if (!cur) return undefined;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const push = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };

    if (patch.label !== undefined) push("label", patch.label.trim());
    if (patch.protocol !== undefined) push("protocol", patch.protocol);
    if (patch.host !== undefined) push("host", patch.host.trim());
    if (patch.port !== undefined) push("port", patch.port);
    if (patch.username !== undefined) push("username", nn(patch.username));
    if (patch.passwordEnc !== undefined) push("password_enc", nn(patch.passwordEnc));

    if (!sets.length) return cur;
    push("updated_at", now());
    params.push(id, userId);
    this.db.run(`UPDATE proxies SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, ...params);
    return this.findById(id);
  }

  /** 写入一次连接性检测结果 */
  recordCheck(id: string, result: ProxyCheckResult): void {
    this.db.run(
      `UPDATE proxies
          SET last_check_at = ?, last_check_ok = ?, last_check_ms = ?, last_exit_ip = ?, last_error = ?, updated_at = ?
        WHERE id = ?`,
      now(),
      result.ok ? 1 : 0,
      nn(result.latencyMs),
      nn(result.exitIp),
      nn(result.error),
      now(),
      id,
    );
  }

  delete(id: string, userId: string): boolean {
    return Number(this.db.run("DELETE FROM proxies WHERE id = ? AND user_id = ?", id, userId).changes) > 0;
  }

  /** 账号解绑某个代理（删除代理前调用，或由 ON DELETE SET NULL 自动处理） */
  unbindFromAccounts(proxyId: string, userId: string): number {
    return Number(
      this.db.run(
        "UPDATE game_accounts SET proxy_id = NULL, updated_at = ? WHERE proxy_id = ? AND user_id = ?",
        now(),
        proxyId,
        userId,
      ).changes,
    );
  }
}
