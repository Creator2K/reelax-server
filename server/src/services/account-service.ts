// 账号服务：把「数据库行 + 运行时状态 + 模块配置」拼成前端要的形状
//
// 所有方法都以 userId 为一等参数，并且**先校验归属再返回**；
// 越权一律返回 404（不泄漏资源是否存在）。
import type { Repos } from "../db/repositories/index.ts";
import type { AccountRow, AccountSafeRow } from "../db/repositories/accounts.ts";
import { accountSafeToApi } from "../db/repositories/accounts.ts";
import type { AccountStatus, ModuleRuntimeState, RunSnapshot, AccountStats, AccountRuntime } from "../game/account-runtime.ts";import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { CredentialVault } from "../security/vault.ts";
import { CredentialVault as Vault } from "../security/vault.ts";
import { HttpError } from "../api/server.ts";
import { MODULES, getModule } from "../modules/registry.ts";
import { validateConfigPatch, type ConfigValues, type ModuleDefinition } from "../modules/types.ts";
import { parseProxyInput, parseBaseUrl } from "./proxy-input.ts";
import { buildMapsView, buildCompetitionMarks, checkTravel, type AccountMapsView } from "./map-view.ts";
import { buildPartyView, invitationList, partyErrorMessage, type PartyView } from "./party-view.ts";
import { fetchBarterOrders, chooseBarterChain, isBarterRarity, type BarterPlan } from "./barter-plan.ts";
import {
  buildBarterView,
  filterStartFish,
  masteryTargetFishIds,
  pickStartCandidates,
  readContentFish,
  readInventoryFish,
  taskFromText,
  taskTargetText,
  toTaskView,
  MAX_OPEN_TASKS,
  MAX_TASK_QUANTITY,
  type BarterTaskView,
  type BarterView,
} from "./barter-view.ts";
import { MAX_SPECS_PER_SIDE } from "../db/repositories/barter-tasks.ts";
import { biomeLabel, biomeName } from "../modules/shared/biomes.ts";
import { rarityLabel } from "../modules/shared/rarity.ts";

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

  /* ---------- 地图与天气（手动换图面板） ---------- */

  /**
   * 面板数据：当前地图 + 全部地图（天气 / 鱼价值 / 比赛标记 / 解锁信息）+ 船队状态。
   *
   * 数据来源就是 `/api/biomes`（含 weather 与 activeCompetitions）与两个比赛 overview；
   * 这里**强制刷新一次**缓存 —— 用户是主动点开这个面板的，看到的应该是"现在"的天气。
   */
  async maps(accountId: string, userId: string): Promise<AccountMapsView> {
    const rt = this.requireRuntime(accountId, userId);
    await rt.refreshDisplayData(true); // 内部已吞掉单个接口的失败，不会抛

    const biomes = [...rt.biomes.values()];
    if (!biomes.length) {
      throw new HttpError(502, "GAME_UNREACHABLE", "读不到地图数据（账号可能还没连上游戏，稍后再试）");
    }

    return buildMapsView({
      biomes,
      myCompetitionBiomes: await this.myCompetitionBiomes(rt),
      party: partyOf(rt),
    });
  }

  /** 手动换图：solo = 只自己过去；party = 把整条船开过去（需船长 / 舵手） */
  async travel(
    accountId: string,
    userId: string,
    input: { biomeId: string; mode: "solo" | "party" },
  ): Promise<{ ok: true; biomeId: string; name: string; mode: "solo" | "party" }> {
    const rt = this.requireRuntime(accountId, userId);
    await rt.refreshDisplayData(true);

    const view = buildMapsView({ biomes: [...rt.biomes.values()], myCompetitionBiomes: new Map(), party: null });
    const biome = view.maps.find((m) => m.id === input.biomeId) ?? null;

    // ★ 带队换图要**现场**再看一次船队状态：状态面板里的船队信息可能是几分钟前的
    let party = view.party;
    if (input.mode === "party") {
      try {
        const st = await rt.client.fishingState();
        const p = st?.party ?? null;
        party = p
          ? {
              inParty: Boolean(p.isInParty),
              canChangeBoatBiome: Boolean(p.canChangeBoatBiome),
              boatName: p.boatName ?? null,
              boatBiomeId: p.boatBiomeId ?? null,
            }
          : null;
      } catch {
        party = null; // 拿不到就当没有权限：checkTravel 会给出明确原因
      }
    }

    const check = checkTravel({ biome, party, mode: input.mode });
    if (!check.ok) throw new HttpError(400, check.code, check.message);

    await rt.manualTravel({ biomeId: input.biomeId, name: biome?.name ?? input.biomeId, mode: input.mode });
    return { ok: true, biomeId: input.biomeId, name: biome?.name ?? input.biomeId, mode: input.mode };
  }

  /** 账号运行时（不存在 = 账号不存在；越权一律 404） */
  private requireRuntime(accountId: string, userId: string) {
    this.requireOwned(accountId, userId);
    const rt = this.registry.get(accountId);
    if (!rt) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
    return rt;
  }

  /**
   * 「我报名的比赛在哪张图」：个人赛 / 公会赛各查一次。
   * 失败就当作没有（面板上少个标记，不该因此打不开面板）。
   */
  private async myCompetitionBiomes(rt: AccountRuntime): Promise<Map<string, string>> {
    const [personal, guild] = await Promise.all([
      rt.client.tournamentsOverview().catch(() => null),
      rt.client.guildTournamentsOverview().catch(() => null),
    ]);
    return buildCompetitionMarks({ personal, guild, now: Date.now() });
  }

  /* ---------- 船队（组队） ---------- */

  /** 船队面板：当前状态 + 成员 + 待处理邀请（每次现读，船队状态变化频繁） */
  async party(accountId: string, userId: string): Promise<PartyView> {
    const rt = this.requireRuntime(accountId, userId);

    const [state, overview, invitations] = await Promise.all([
      rt.client.fishingState().catch(() => null),
      rt.client.partyBoatsOverview().catch(() => null),
      rt.client.partyInvitations().catch(() => null),
    ]);
    if (!state && !overview) {
      throw new HttpError(502, "GAME_UNREACHABLE", "读不到船队状态（账号可能还没连上游戏，稍后再试）");
    }

    return buildPartyView({
      party: state?.party ?? null,
      overview,
      invitations: invitationList(invitations),
      biomeName: biomeName,
    });
  }

  /** 用邀请码加入船队 */
  async joinParty(accountId: string, userId: string, code: string): Promise<{ ok: true; code: string }> {
    const rt = this.requireRuntime(accountId, userId);
    try {
      await rt.joinPartyByCode(code);
    } catch (err) {
      throw new HttpError(400, "PARTY_JOIN_FAILED", partyErrorMessage(err));
    }
    return { ok: true, code };
  }

  /** 离开船队（船长会被游戏拒绝，理由如实转达） */
  async leaveParty(accountId: string, userId: string): Promise<{ ok: true }> {
    const rt = this.requireRuntime(accountId, userId);
    try {
      await rt.leaveParty();
    } catch (err) {
      throw new HttpError(400, "PARTY_LEAVE_FAILED", partyErrorMessage(err));
    }
    return { ok: true };
  }

  /** 接受 / 拒绝一条组队邀请 */
  async respondPartyInvitation(
    accountId: string,
    userId: string,
    invitationId: string,
    action: "accept" | "reject",
  ): Promise<{ ok: true; action: "accept" | "reject" }> {
    const rt = this.requireRuntime(accountId, userId);
    try {
      await rt.respondPartyInvitation(invitationId, action);
    } catch (err) {
      throw new HttpError(400, "PARTY_INVITATION_FAILED", partyErrorMessage(err));
    }
    return { ok: true, action };
  }

  /**
   * 船队成员管理（仅船长，游戏侧也会再校验一次）：
   *  · remove  → 把某人移出船队
   *  · role    → 任命 / 撤销舵手
   *  · captain → 转让船长（只有租用中的船可以）
   */
  async managePartyMember(
    accountId: string,
    userId: string,
    publicId: string,
    action: "remove" | "role" | "captain",
    role?: "helmsman" | "crew",
  ): Promise<{ ok: true; action: string }> {
    const rt = this.requireRuntime(accountId, userId);
    try {
      if (action === "remove") await rt.removePartyMember(publicId);
      else if (action === "role") await rt.setPartyMemberRole(publicId, role === "helmsman" ? "helmsman" : "crew");
      else await rt.transferPartyCaptain(publicId);
    } catch (err) {
      throw new HttpError(400, "PARTY_MEMBER_FAILED", partyErrorMessage(err));
    }
    return { ok: true, action: action === "role" && role ? `role:${role}` : action };
  }

  /* ---------- 以物易物（交换任务面板） ---------- */

  /**
   * 交换任务面板：队列 + 起点候选（地图 × 稀有度）+ 目标候选 + 队首任务的路径预览。
   *
   * 打开面板是用户主动动作，所以**现读游戏接口**（背包 / 鱼表 / 专精目标），
   * 但鱼表走运行时的 6 小时缓存 —— 内容表很大，不能每次开面板都拉一遍。
   */
  async barter(accountId: string, userId: string): Promise<BarterView> {
    const rt = this.requireRuntime(accountId, userId);

    const [inv, content, mastery] = await Promise.all([
      rt.client.inventoryFish().catch(() => null),
      rt.contentBootstrapCached().catch(() => null),
      rt.client.mastery().catch(() => null),
    ]);
    if (!inv || !content) {
      throw new HttpError(502, "GAME_UNREACHABLE", "读不到背包或鱼表（账号可能还没连上游戏，稍后再试）");
    }

    const inventory = readInventoryFish(inv);
    const masteryTargets = masteryTargetFishIds(mastery);
    const tasks = this.repos.barter.listForAccount(accountId);
    const head = tasks.find((t) => t.status === "waiting" || t.status === "running" || t.status === "blocked") ?? null;

    // 队首任务现在能不能走通：失败不影响面板打开（预览只是"顺便看一眼"）
    let headPlan: {
      taskId: string;
      plan: BarterPlan;
      start?: { fishId: string; name: string; biomeId: string | null } | null;
    } | null = null;
    if (head) {
      try {
        const starts = filterStartFish(
          head.from_specs,
          pickStartCandidates({ inventory, content, masteryTargets }),
        );
        const choice = chooseBarterChain({
          orders: await fetchBarterOrders(rt.client, { limit: 50, pages: 2 }),
          starts,
          targets: head.target_specs,
          maxHops: clampMaxHops(rt, getModule("auto-barter")),
          selfNickname: rt.me?.player?.nickname ?? null,
          selfPublicId: rt.client.publicIdentity?.publicId ?? null,
        });
        headPlan = {
          taskId: head.id,
          plan: choice.ok ? choice.plan : { ok: false, reason: choice.reason },
          start: choice.ok
            ? { fishId: choice.start.fishId, name: choice.start.name, biomeId: choice.start.biomeId }
            : null,
        };
      } catch {
        headPlan = null;
      }
    }

    const moduleDef = getModule("auto-barter");
    return buildBarterView({
      tasks,
      inventory,
      content,
      masteryOverview: mastery,
      moduleEnabled: moduleDef ? rt.isEnabled(moduleDef) : false,
      moduleRunning: rt.moduleInstances.includes("auto-barter"),
      head: headPlan,
      maxSpecs: MAX_SPECS_PER_SIDE,
    });
  }

  /**
   * 新增交换任务：起点侧与目标侧都是一组「地图 + 稀有度」规格。
   *
   * 校验全部在这里做完（地图存在、稀有度是最高三档、目标图上真有这一档的鱼、
   * 起点侧至少还有一条能拿出去的鱼），避免把「注定换不到的任务」排进队列。
   */
  async createBarterTask(
    accountId: string,
    userId: string,
    input: {
      fromSpecs: { biomeId: string; rarity: string }[];
      targetSpecs: { biomeId: string; rarity: string }[];
      quantity: number;
    },
  ): Promise<BarterTaskView> {
    const rt = this.requireRuntime(accountId, userId);

    if (this.repos.barter.countOpen(accountId) >= MAX_OPEN_TASKS) {
      throw new HttpError(
        400,
        "BARTER_QUEUE_FULL",
        `未完成的交换任务最多 ${MAX_OPEN_TASKS} 条（已完成的可以先不管，或者取消掉不再需要的）`,
      );
    }

    const fromSpecs = normalizeSpecs(input.fromSpecs, "起点");
    const targetSpecs = normalizeSpecs(input.targetSpecs, "目标");

    const [inv, content, mastery] = await Promise.all([
      rt.client.inventoryFish().catch(() => null),
      rt.contentBootstrapCached().catch(() => null),
      rt.client.mastery().catch(() => null),
    ]);
    if (!inv || !content) {
      throw new HttpError(502, "GAME_UNREACHABLE", "读不到背包或鱼表（账号可能还没连上游戏，稍后再试）");
    }

    // 两边都要「这张图上真有这一档的鱼」，否则这条任务从定义上就换不到
    const catalog = readContentFish(content);
    for (const [side, specs] of [
      ["起点", fromSpecs],
      ["目标", targetSpecs],
    ] as const) {
      for (const spec of specs) {
        const hit = catalog.some((f) => f.biomeId === spec.biomeId && f.rarity === spec.rarity);
        if (!hit) {
          throw new HttpError(
            400,
            "BARTER_SPEC_EMPTY",
            `${side}「${biomeLabel(spec.biomeId) ?? spec.biomeId}」上没有「${rarityLabel(spec.rarity)}」的鱼`,
          );
        }
      }
    }

    // 目标不能和起点完全重合（同图同档 = 原地不动）
    const sameSpec = targetSpecs.find((t) => fromSpecs.some((f) => f.biomeId === t.biomeId && f.rarity === t.rarity));
    if (sameSpec) {
      throw new HttpError(
        400,
        "BARTER_TARGET_SAME_AS_START",
        `目标「${biomeLabel(sameSpec.biomeId) ?? sameSpec.biomeId}」和起点是同一张图上的同一档鱼，换了等于没换`,
      );
    }

    // 起点侧现在至少要有 1 条能拿出去的鱼（未锁定、不是专精目标鱼）
    const starts = filterStartFish(
      fromSpecs.map((s) => ({ biomeId: s.biomeId, rarity: s.rarity, fishId: null })),
      pickStartCandidates({ inventory: readInventoryFish(inv), content, masteryTargets: masteryTargetFishIds(mastery) }),
    );
    const available = starts.reduce((sum, c) => sum + c.quantity, 0);
    if (!starts.length || available <= 0) {
      throw new HttpError(
        400,
        "BARTER_START_FISH_UNUSABLE",
        "这些地图上现在没有可以拿去交换的鱼（需要未锁定、且不是当前专精目标鱼）",
      );
    }

    const quantity = Math.min(Math.max(Math.floor(Number(input.quantity) || 0), 1), MAX_TASK_QUANTITY);

    // 老列（from_fish_* / target_*）只用于展示与老数据兼容：填第一个规格的样子
    const firstStart = starts[0]!;
    const firstTarget = targetSpecs[0]!;
    const row = rt.barterCreateTask({
      accountId,
      userId,
      fromSpecs: fromSpecs.map((s) => ({ biomeId: s.biomeId, rarity: s.rarity, fishId: null })),
      targetSpecs: targetSpecs.map((s) => ({ biomeId: s.biomeId, rarity: s.rarity, fishId: null })),
      quantity,
      fromFishId: firstStart.fishId,
      fromFishName: firstStart.name,
      fromBiomeId: firstStart.biomeId,
      rarity: firstStart.rarity,
      targetBiomeId: firstTarget.biomeId,
      targetFishId: null,
      targetFishName: "",
    });
    this.repos.barter.pruneFinished(accountId);
    return toTaskView(row);
  }

  /** 取消交换任务（已换到的鱼留在背包里） */
  async cancelBarterTask(
    accountId: string,
    userId: string,
    taskId: string,
  ): Promise<{ ok: true; status: string; from: string; to: string }> {
    const rt = this.requireRuntime(accountId, userId);
    const row = this.repos.barter.find(taskId, accountId);
    if (!row) throw new HttpError(404, "BARTER_TASK_NOT_FOUND", "交换任务不存在");
    const names = { from: taskFromText(row), to: taskTargetText(row) };
    // 幂等：已经结束的任务再取消一次不算错
    if (row.status === "done" || row.status === "cancelled") {
      return { ok: true, status: row.status, ...names };
    }
    rt.barterCancelTask(taskId);
    return { ok: true, status: "cancelled", ...names };
  }
}

/**
 * 规格列表校验与去重：地图必须存在、稀有度必须是最高三档、不能重复、每侧 1~5 项。
 * 出错直接抛 400（带上人话原因），调用方不需要再判。
 */
function normalizeSpecs(
  raw: { biomeId: string; rarity: string }[],
  side: "起点" | "目标",
): { biomeId: string; rarity: string }[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new HttpError(400, "BARTER_SPEC_REQUIRED", `${side}至少选一张地图`);
  }
  if (raw.length > MAX_SPECS_PER_SIDE) {
    throw new HttpError(400, "BARTER_SPEC_TOO_MANY", `${side}最多 ${MAX_SPECS_PER_SIDE} 项`);
  }
  const out: { biomeId: string; rarity: string }[] = [];
  for (const item of raw) {
    const biomeId = String(item?.biomeId ?? "");
    const rarity = String(item?.rarity ?? "");
    if (!biomeName(biomeId)) {
      throw new HttpError(400, "BARTER_BIOME_UNKNOWN", `${side}里有不存在的地图：${biomeId}`);
    }
    if (!isBarterRarity(rarity)) {
      throw new HttpError(
        400,
        "BARTER_RARITY_NOT_ALLOWED",
        `${side}里有「${rarity || "未选"}」这一档：以物易物只支持神话 / 奇异 / 奥秘`,
      );
    }
    if (out.some((s) => s.biomeId === biomeId && s.rarity === rarity)) continue; // 重复的直接并掉
    out.push({ biomeId, rarity });
  }
  if (!out.length) throw new HttpError(400, "BARTER_SPEC_REQUIRED", `${side}至少选一张地图`);
  return out;
}

/**
 * 面板预览用的跳数上限：与「自动以物易物」的配置保持一致。
 *
 * 预览是给用户看的「它打算怎么走」，必须与模块真正执行时用同一套上限，
 * 否则会出现「面板说有路、模块却说没有」这种自相矛盾的提示。
 */
function clampMaxHops(rt: AccountRuntime, def: ModuleDefinition | undefined): number {
  const fallback = 3;
  if (!def) return fallback;
  const n = Math.floor(Number(rt.resolveConfig(def).config.maxHops));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 6) : fallback;
}

/** 状态面板里的船队信息 → 面板视图（没有就 null） */
function partyOf(rt: AccountRuntime): AccountMapsView["party"] {
  const fleet = (rt.statusPanel as { fleet?: Record<string, unknown> } | null)?.fleet ?? null;
  if (!fleet) return null;
  return {
    inParty: true,
    canChangeBoatBiome: Boolean(fleet.canChangeBoatBiome),
    boatName: (fleet.boatName as string | null) ?? null,
    boatBiomeId: (fleet.boatBiomeId as string | null) ?? null,
  };
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
