// 账号服务：把「数据库行 + 运行时状态 + 模块配置」拼成前端要的形状
//
// 所有方法都以 userId 为一等参数，并且**先校验归属再返回**；
// 越权一律返回 404（不泄漏资源是否存在）。
import type { Repos } from "../db/repositories/index.ts";
import type { AccountRow, AccountSafeRow } from "../db/repositories/accounts.ts";
import { accountSafeToApi } from "../db/repositories/accounts.ts";
import type { AccountStatus, ModuleRuntimeState, RunSnapshot, AccountStats } from "../game/account-runtime.ts";import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { CredentialVault } from "../security/vault.ts";
import { CredentialVault as Vault } from "../security/vault.ts";
import { HttpError } from "../api/server.ts";
import { MODULES, getModule } from "../modules/registry.ts";
import { validateConfigPatch, type ConfigValues } from "../modules/types.ts";
import { parseProxyInput, parseBaseUrl } from "./proxy-input.ts";

export type AccountView = {
  id: string;
  label: string;
  authType: "credentials" | "cookie";
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
  /** 凭证解不开时给出明确原因（MASTER_KEY 不匹配） */
  credentialOk: boolean;
  credentialError: string | null;
  player: { nickname: string | null; level: number | null; gold: number | null } | null;
  onlinePlayerCount: number | null;
  lastSyncAt: number | null;
  run: RunSnapshot | null;
  modules: ModuleRuntimeState[];
  stats: AccountStats;
  statusPanel: Record<string, unknown> | null;
};

export type CreateAccountInput = {
  label?: string;
  authType?: "credentials" | "cookie";
  email?: string;
  password?: string;
  cookie?: string;
  baseUrl?: string;
  proxyId?: string | null;
  autoStart?: boolean;
};

export type UpdateAccountInput = {
  label?: string;
  email?: string;
  password?: string;
  cookie?: string;
  authType?: "credentials" | "cookie";
  autoStart?: boolean;
  proxyId?: string | null;
};

export class AccountService {
  private repos: Repos;
  private vault: CredentialVault;
  private registry: RunnerRegistry;
  /** 判定用户是否有可用推送通道（收益日报的前置条件） */
  private hasUsableChannel: (userId: string) => boolean;

  constructor(deps: {
    repos: Repos;
    vault: CredentialVault;
    registry: RunnerRegistry;
    /** 可选注入：没注入时不做推送前置检查 */
    hasUsableChannel?: (userId: string) => boolean;
  }) {
    this.repos = deps.repos;
    this.vault = deps.vault;
    this.registry = deps.registry;
    this.hasUsableChannel = deps.hasUsableChannel ?? (() => true);
  }

  /* ---------- 视图拼装 ---------- */

  toView(row: AccountSafeRow): AccountView {
    const rt = this.registry.get(row.id);
    const credentialOk = rt ? !rt.credentialError : true;

    return {
      ...accountSafeToApi(row),
      credentialOk,
      credentialError: rt?.credentialError ?? null,
      player: rt?.client.player
        ? {
            nickname: rt.client.player.nickname ?? null,
            level: rt.client.player.level ?? null,
            gold: rt.client.player.gold ?? null,
          }
        : null,
      onlinePlayerCount: rt?.onlinePlayerCount ?? null,
      lastSyncAt: rt?.lastSyncAt || null,
      run: rt?.run ?? null,
      modules: rt ? rt.moduleStates() : staticModuleStates(this.repos, row.id),
      stats: rt
        ? rt.stats
        : { startedAt: 0, syncs: 0, castsResolved: 0, gold: 0, experience: 0, fishCount: 0 },
      statusPanel: rt?.statusPanel ?? null,
    };
  }

  /** 运行时还没建立时（例如服务刚起）也要给出正确的模块状态 */
  private staticModuleStatesFor(accountId: string): ModuleRuntimeState[] {
    return staticModuleStates(this.repos, accountId);
  }

  listForUser(userId: string): AccountView[] {
    return this.repos.accounts.listSafeForUser(userId).map((row) => this.toView(row));
  }

  /** ★ 归属校验：不属于该用户一律 404 */
  requireOwned(accountId: string, userId: string): AccountSafeRow {
    const row = this.repos.accounts.findSafe(accountId, userId);
    if (!row) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
    return row;
  }

  getForUser(accountId: string, userId: string): AccountView {
    return this.toView(this.requireOwned(accountId, userId));
  }

  /* ---------- 创建 / 更新 / 删除 ---------- */

  create(userId: string, input: CreateAccountInput): AccountView {
    const authType = input.authType === "cookie" ? "cookie" : "credentials";
    const label = (input.label ?? "").trim();

    // 配额
    const used = this.repos.accounts.countForUser(userId);
    const limit = this.limitFor(userId);
    if (used >= limit) {
      throw new HttpError(400, "ACCOUNT_QUOTA_EXCEEDED", `账号数量已达上限（${limit} 个），请先删除不再使用的账号。`);
    }

    // 凭证校验
    if (authType === "credentials") {
      const email = (input.email ?? "").trim();
      const password = input.password ?? "";
      if (!email) throw new HttpError(400, "EMAIL_REQUIRED", "请填写游戏账号邮箱");
      if (!password) throw new HttpError(400, "PASSWORD_REQUIRED", "请填写游戏账号密码");
    } else if (!(input.cookie ?? "").trim()) {
      throw new HttpError(400, "COOKIE_REQUIRED", "请粘贴浏览器 Cookie");
    }

    // 代理归属校验
    if (input.proxyId) this.requireOwnedProxy(input.proxyId, userId);

    // 基础地址校验
    const normalizedBase = parseBaseUrl(input.baseUrl);

    const passwordEnc =
      authType === "credentials" && input.password
        ? this.vault.seal(input.password, userId, "password")
        : null;
    const cookieEnc = authType === "cookie" && input.cookie ? this.vault.seal(input.cookie, userId, "cookie") : null;

    const row = this.repos.accounts.create({
      userId,
      label: label || (input.email ?? "").trim() || "未命名账号",
      authType,
      email: (input.email ?? "").trim(),
      passwordEnc,
      cookieEnc,
      baseUrl: normalizedBase,
      proxyId: input.proxyId ?? null,
      autoStart: input.autoStart !== false,
    });

    // 建运行时（但不自动启动 —— 由调用方决定）
    this.registry.ensure(row);
    return this.toView(this.requireOwned(row.id, userId));
  }

  update(accountId: string, userId: string, patch: UpdateAccountInput): AccountView {
    // 只做归属校验（越权时抛 404）；返回值这里用不到，下面直接用原始行
    this.requireOwned(accountId, userId);
    const raw = this.repos.accounts.findById(accountId);
    if (!raw) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");

    const update: Parameters<Repos["accounts"]["update"]>[2] = {};
    let credentialsChanged = false;
    let proxyChanged = false;

    if (patch.label !== undefined) update.label = patch.label;

    if (patch.proxyId !== undefined) {
      if (patch.proxyId !== null) this.requireOwnedProxy(patch.proxyId, userId);
      if (patch.proxyId !== raw.proxy_id) {
        update.proxyId = patch.proxyId;
        proxyChanged = true;
      }
    }

    if (patch.authType !== undefined) update.authType = patch.authType;
    if (patch.email !== undefined) {
      update.email = patch.email;
      credentialsChanged = true;
    }
    // 口令 / Cookie：空字符串视为「不修改」，避免前端没填就清掉
    if (patch.password !== undefined && patch.password !== "") {
      update.passwordEnc = this.vault.seal(patch.password, userId, "password");
      credentialsChanged = true;
    }
    if (patch.cookie !== undefined && patch.cookie !== "") {
      update.cookieEnc = this.vault.seal(patch.cookie, userId, "cookie");
      credentialsChanged = true;
    }
    if (patch.autoStart !== undefined) update.autoStart = patch.autoStart;

    // 改成 cookie 方式时清掉密码；改成账号密码时清掉 cookie
    if (patch.authType === "cookie") update.passwordEnc = null;
    if (patch.authType === "credentials") update.cookieEnc = null;

    const updated = this.repos.accounts.update(accountId, userId, update);
    if (!updated) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");

    this.registry.refreshFromRecord(accountId, { credentials: credentialsChanged, proxy: proxyChanged });
    return this.toView(this.requireOwned(accountId, userId));
  }

  async remove(accountId: string, userId: string): Promise<void> {
    this.requireOwned(accountId, userId);
    await this.registry.dispose(accountId);
    const ok = this.repos.accounts.delete(accountId, userId);
    if (!ok) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
  }

  /* ---------- 启停 ---------- */

  async start(accountId: string, userId: string): Promise<AccountView> {
    this.requireOwned(accountId, userId);
    await this.registry.start(accountId);
    return this.toView(this.requireOwned(accountId, userId));
  }

  async stop(accountId: string, userId: string): Promise<AccountView> {
    this.requireOwned(accountId, userId);
    await this.registry.stop(accountId, "手动停止");
    return this.toView(this.requireOwned(accountId, userId));
  }

  /* ---------- 模块配置 ---------- */

  moduleStates(accountId: string, userId: string): ModuleRuntimeState[] {
    this.requireOwned(accountId, userId);
    const rt = this.registry.get(accountId);
    return rt ? rt.moduleStates() : staticModuleStates(this.repos, accountId);
  }

  /** 更新模块开关 / 配置，并热重启该模块 */
  async updateModule(
    accountId: string,
    userId: string,
    moduleId: string,
    patch: { enabled?: boolean; config?: ConfigValues },
  ): Promise<{ states: ModuleRuntimeState[]; startError: string | null }> {
    this.requireOwned(accountId, userId);

    const def = getModule(moduleId);
    if (!def) throw new HttpError(404, "MODULE_NOT_FOUND", "功能不存在");

    // ★ 依赖推送通道的功能（收益日报）：没有可用通道时不许启用。
    //   前端会显示 unavailable 原因，这里是服务端兜底（不能只靠前端拦）。
    if (def.requiresNotification && patch.enabled === true && !this.hasUsableChannel(userId)) {
      throw new HttpError(
        400,
        "NOTIFICATION_REQUIRED",
        `${def.name} 需要先配置推送通道（Server酱 或微信机器人）：没有通道时它只会写一条日志，不会推送到手机。`,
      );
    }

    if (patch.config) {
      // ★ 库里已经存在、但当前 schema 不认识的键 = 旧版本残留（例如某次改版删掉的配置项）。
      //   配置表单会把服务端下发的整份配置原样回传，所以这些键必须放行，
      //   否则用户改任何一项都会被「不是该模块的配置项」挡下来 —— 那个模块就再也存不了配置。
      const stored = this.repos.modules.find(accountId, moduleId)?.config ?? {};
      const knownKeys = new Set(def.configSchema.map((f) => f.key));
      const legacyKeys = Object.keys(stored).filter((k) => !knownKeys.has(k));

      const { patch: clean, errors } = validateConfigPatch(def, patch.config, { tolerateUnknown: legacyKeys });
      if (errors.length) {
        const first = errors[0]!;
        throw new HttpError(400, "INVALID_CONFIG", `${first.key}：${first.message}`);
      }
      this.repos.modules.upsert(accountId, moduleId, { config: clean });
    }
    if (patch.enabled !== undefined) {
      this.repos.modules.upsert(accountId, moduleId, { enabled: patch.enabled });
    }

    // 热重启：停旧起新（账号未运行时只更新配置）
    const rt = this.registry.require(accountId);
    const result = await rt.restartModule(moduleId);

    return {
      states: rt.moduleStates(),
      startError: result.ok ? null : (result.error ?? null),
    };
  }

  /** 恢复某模块的默认配置 */
  async resetModule(accountId: string, userId: string, moduleId: string): Promise<ModuleRuntimeState[]> {
    this.requireOwned(accountId, userId);
    const def = getModule(moduleId);
    if (!def) throw new HttpError(404, "MODULE_NOT_FOUND", "功能不存在");
    this.repos.modules.replaceConfig(accountId, moduleId, {});
    const rt = this.registry.require(accountId);
    await rt.restartModule(moduleId);
    return rt.moduleStates();
  }

  /* ---------- 辅助 ---------- */

  private limitFor(userId: string): number {
    // 该用户实际生效的额度：优先用单独设置的覆盖值，否则全局默认。
    // （管理员可以在「用户 → 编辑」里给某个人单独放宽）
    const user = this.repos.users.findById(userId);
    if (!user) return this.registry.limitPerUser;
    const override = user.quota_override == null ? null : Number(user.quota_override);
    if (Number.isFinite(override) && (override as number) > 0) return override as number;
    return this.registry.limitPerUser;
  }

  private requireOwnedProxy(proxyId: string, userId: string): void {
    const p = this.repos.proxies.findOwned(proxyId, userId);
    if (!p) throw new HttpError(400, "PROXY_NOT_OWNED", "代理不存在或不属于你");
  }

  /** 供路由层复用：解析并校验代理地址 */
  static parseProxyInput = parseProxyInput;
}

/** 运行时未建立时的静态模块状态（按数据库记录 + 模块默认值） */
export function staticModuleStates(repos: Repos, accountId: string): ModuleRuntimeState[] {
  const stored = new Map(repos.modules.listForAccount(accountId).map((m) => [m.moduleId, m]));
  return MODULES.map((def) => {
    const s = stored.get(def.id);
    const config = { ...def.defaultConfig, ...(s?.config ?? {}) };
    return {
      id: def.id,
      name: def.name,
      enabled: s ? s.enabled : def.defaultEnabled,
      running: false,
      config,
      configIssues: [],
      startError: null,
    };
  });
}

export { Vault as CredentialVaultClass };
export type { AccountRow };
