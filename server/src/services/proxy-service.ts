// 代理服务：CRUD + 连通性测试 + 与账号的绑定关系
import type { Repos } from "../db/repositories/index.ts";
import type { ProxyRow } from "../db/repositories/proxies.ts";
import type { CredentialVault } from "../security/vault.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import { HttpError } from "../api/server.ts";
import { checkProxy, formatProxy, type ProxyConfig } from "../game/proxy.ts";
import type { Logger } from "../lib/logger.ts";

export type ProxyView = {
  id: string;
  label: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string | null;
  /** 是否设置了口令（不返回口令本身） */
  hasPassword: boolean;
  /** 绑定了该代理的账号数 */
  boundAccounts: number;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastCheckMs: number | null;
  lastExitIp: string | null;
  lastError: string | null;
  createdAt: number;
};

export type ProxyTestResult = {
  ok: boolean;
  latencyMs: number | null;
  exitIp: string | null;
  status: number | null;
  errorCode: string | null;
  error: string | null;
  /** 检测时间 */
  checkedAt: number;
};

export type ProxyServiceDeps = {
  repos: Repos;
  vault: CredentialVault;
  registry: RunnerRegistry;
  logger: Logger;
  baseUrl: string;
  proxyEchoUrl: string;
};

/** 每个用户允许的代理数量上限（代理是用户级资源，不需要 env 配置） */
const MAX_PROXIES_PER_USER = 50;

export class ProxyService {
  private deps: ProxyServiceDeps;

  constructor(deps: ProxyServiceDeps) {
    this.deps = deps;
  }

  /* ---------- 视图 ---------- */

  toView(row: ProxyRow): ProxyView {
    return {
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      host: row.host,
      port: Number(row.port),
      username: row.username,
      hasPassword: Boolean(row.password_enc),
      boundAccounts: this.deps.repos.proxies.boundAccountCount(row.id),
      lastCheckAt: row.last_check_at == null ? null : Number(row.last_check_at),
      lastCheckOk: row.last_check_ok == null ? null : Number(row.last_check_ok) === 1,
      lastCheckMs: row.last_check_ms == null ? null : Number(row.last_check_ms),
      lastExitIp: row.last_exit_ip,
      lastError: row.last_error,
      createdAt: Number(row.created_at),
    };
  }

  listForUser(userId: string): ProxyView[] {
    return this.deps.repos.proxies.listForUser(userId).map((r) => this.toView(r));
  }

  /** ★ 归属校验：不属于该用户一律 404 */
  requireOwned(proxyId: string, userId: string): ProxyRow {
    const row = this.deps.repos.proxies.findOwned(proxyId, userId);
    if (!row) throw new HttpError(404, "PROXY_NOT_FOUND", "代理不存在");
    return row;
  }

  getForUser(proxyId: string, userId: string): ProxyView {
    return this.toView(this.requireOwned(proxyId, userId));
  }

  /* ---------- 增删改 ---------- */

  create(
    userId: string,
    input: { label: string; protocol: "http" | "https" | "socks5"; host: string; port: number; username: string | null; password: string | null },
  ): ProxyView {
    const count = this.deps.repos.proxies.countForUser(userId);
    if (count >= MAX_PROXIES_PER_USER) {
      throw new HttpError(400, "PROXY_QUOTA_EXCEEDED", `代理数量已达上限（${MAX_PROXIES_PER_USER} 个）`);
    }

    const row = this.deps.repos.proxies.create({
      userId,
      label: input.label,
      protocol: input.protocol,
      host: input.host,
      port: input.port,
      username: input.username,
      passwordEnc: input.password ? this.deps.vault.seal(input.password, userId, "proxy_password") : null,
    });
    return this.toView(row);
  }

  update(
    proxyId: string,
    userId: string,
    patch: {
      label?: string;
      protocol?: "http" | "https" | "socks5";
      host?: string;
      port?: number;
      username?: string | null;
      /** undefined = 不改口令；"" = 清除口令；其它 = 设置新口令 */
      password?: string;
    },
  ): ProxyView {
    const current = this.requireOwned(proxyId, userId);

    const update: Parameters<Repos["proxies"]["update"]>[2] = {};
    let connectionChanged = false;

    if (patch.label !== undefined) update.label = patch.label;
    if (patch.protocol !== undefined && patch.protocol !== current.protocol) {
      update.protocol = patch.protocol;
      connectionChanged = true;
    }
    if (patch.host !== undefined && patch.host !== current.host) {
      update.host = patch.host;
      connectionChanged = true;
    }
    if (patch.port !== undefined && patch.port !== Number(current.port)) {
      update.port = patch.port;
      connectionChanged = true;
    }
    if (patch.username !== undefined) {
      update.username = patch.username;
      connectionChanged = true;
    }
    if (patch.password !== undefined) {
      update.passwordEnc = patch.password === "" ? null : this.deps.vault.seal(patch.password, userId, "proxy_password");
      connectionChanged = true;
    }

    const updated = this.deps.repos.proxies.update(proxyId, userId, update);
    if (!updated) throw new HttpError(404, "PROXY_NOT_FOUND", "代理不存在");

    // 连接参数变了：让绑定该代理的账号热切换（下一个请求即生效）
    if (connectionChanged) this.refreshBoundAccounts(proxyId);

    return this.toView(updated);
  }

  /** 删除代理：先把账号解绑 + 让运行时切回直连，再删记录 */
  remove(proxyId: string, userId: string): { unboundAccounts: number } {
    this.requireOwned(proxyId, userId);

    const affected = this.deps.repos.accounts.listByProxy(proxyId).filter((a) => a.user_id === userId);
    this.deps.repos.proxies.unbindFromAccounts(proxyId, userId);
    for (const acc of affected) {
      this.deps.registry.refreshFromRecord(acc.id, { proxy: true });
    }

    const ok = this.deps.repos.proxies.delete(proxyId, userId);
    if (!ok) throw new HttpError(404, "PROXY_NOT_FOUND", "代理不存在");
    return { unboundAccounts: affected.length };
  }

  /** 让所有绑定该代理的账号重建 dispatcher */
  private refreshBoundAccounts(proxyId: string): void {
    for (const acc of this.deps.repos.accounts.listByProxy(proxyId)) {
      this.deps.registry.refreshFromRecord(acc.id, { proxy: true });
    }
  }

  /* ---------- 连通性测试 ---------- */

  /** 还原成可用的代理配置（解密口令） */
  toConfig(row: ProxyRow): ProxyConfig {
    let password: string | null = null;
    if (row.password_enc) {
      const r = this.deps.vault.open(row.password_enc, row.user_id, "proxy_password");
      if (r.ok) password = r.value;
      else {
        // 解不开就测不了，直接给出明确原因
        throw new HttpError(
          400,
          "PROXY_SECRET_UNREADABLE",
          `代理口令无法解密：${r.message}`,
        );
      }
    }
    return {
      protocol: row.protocol,
      host: row.host,
      port: Number(row.port),
      username: row.username,
      password,
    };
  }

  /**
   * 测试一个已保存的代理。结果会写回数据库（含出口 IP 与延迟）。
   *
   * 探测目标：游戏的免签名轻量端点（POST 前的 GET），这样能同时验证
   * 「代理通」与「代理到游戏通」两件事，比只 ping 一下更有意义。
   */
  async test(proxyId: string, userId: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<ProxyTestResult> {
    const row = this.requireOwned(proxyId, userId);
    const config = this.toConfig(row);
    return this.runTest(row.id, config, row.user_id, opts);
  }

  /** 测试一组尚未保存的配置（创建前的「先测再用」） */
  async testAdhoc(
    userId: string,
    config: ProxyConfig,
    opts: { fetchImpl?: typeof fetch } = {},
  ): Promise<ProxyTestResult> {
    return this.runTest(null, config, userId, opts);
  }

  private async runTest(
    proxyId: string | null,
    config: ProxyConfig,
    userId: string,
    opts: { fetchImpl?: typeof fetch },
  ): Promise<ProxyTestResult> {
    const outcome = await checkProxy(config, {
      probeUrl: `${this.deps.baseUrl}/api/meta/frontend-release`,
      ...(this.deps.proxyEchoUrl ? { echoUrl: this.deps.proxyEchoUrl } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

    const result: ProxyTestResult = {
      ok: outcome.ok,
      latencyMs: outcome.latencyMs,
      exitIp: outcome.exitIp,
      status: outcome.status,
      errorCode: outcome.errorCode,
      error: outcome.error,
      checkedAt: Date.now(),
    };

    if (proxyId) {
      this.deps.repos.proxies.recordCheck(proxyId, {
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        exitIp: outcome.exitIp,
        error: outcome.error,
      });
      this.deps.logger.info(
        "代理",
        outcome.ok
          ? `代理 ${formatProxy(config)} 连通（${outcome.latencyMs}ms${outcome.exitIp ? `，出口 ${outcome.exitIp}` : ""}）`
          : `代理 ${formatProxy(config)} 不通：${outcome.error}`,
        { userId },
      );
    }

    return result;
  }
}
