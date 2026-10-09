// 账号运行时：一个游戏账号的引擎
//
// 取代旧版的 PluginHost —— 不再有动态插件，只有编译期确定的内置模块，由这里直接驱动。
//
// 职责：
//  1) 持有 GameClient（含该账号的代理 dispatcher）
//  2) 驱动「保持在线」节拍循环（这是唯一的时间驱动源，其他模块挂在事件上）
//  3) 实例化并管理已启用的内置模块（定时器 / 事件订阅随账号停止统一清理）
//  4) 聚合运行状态供 API 与 WS 推送（run / 统计 / 在线人数 / 状态面板）
//
// 关键设计：**模块异常只影响该模块**，绝不把整个账号循环打挂 —— 旧版这一点做得对，保留。

/**
 * 状态面板实现（在 keep-online 模块加载时反向注入）。
 *
 * ★ 这个 `let` 必须放在所有 import 之前。
 *   模块图里有环：account-runtime → modules/registry → keep-online/index → account-runtime。
 *   于是 keep-online 的模块体在 account-runtime 的模块体完成之前就会执行，
 *   此时去赋值一个在 import 之后声明的 `let` 会命中 TDZ 并抛
 *   「Cannot access 'statusPanelImpl' before initialization」。
 *   把它提到最前面，模块体一开始就完成了它的初始化。
 */
let statusPanelImpl: ((st: any, rt: any) => Record<string, unknown>) | null = null;

/** 由 keep-online 在加载时调用（避免 account-runtime 直接 import 它而形成硬环） */
export function registerStatusPanelBuilder(fn: (st: any, rt: any) => Record<string, unknown>): void {
  statusPanelImpl = fn;
}

import type { Repos } from "../db/repositories/index.ts";
import type { AccountRow } from "../db/repositories/accounts.ts";
import type { CredentialVault } from "../security/vault.ts";
import type { Logger } from "../lib/logger.ts";
import type { ChildLogger } from "../lib/logger.ts";
import type { Bus } from "../lib/bus.ts";
import { EVENTS } from "../lib/bus.ts";
import { TimerPool, TtlCache } from "../lib/timers.ts";
import { SerialRunner } from "../lib/timers.ts";
import { clamp, jitter, parseTime, sleepUntil } from "../lib/util.ts";
import { GameClient } from "./client.ts";
import { GAME_ERROR_CODES, GameClientError } from "./errors.ts";
import { ProxyDispatcherHolder, type ProxyConfig } from "./proxy.ts";
import { getModule, MODULES } from "../modules/registry.ts";
import { resolveModuleConfig, type ModuleContext, type ModuleDefinition } from "../modules/types.ts";

export type AccountStatus = "stopped" | "starting" | "online" | "reconnecting" | "error" | "expired";

export type AccountStats = {
  startedAt: number;
  syncs: number;
  castsResolved: number;
  gold: number;
  experience: number;
  fishCount: number;
};

export type RunSnapshot = {
  id: string;
  status: string;
  mode?: string;
  biomeId?: string;
  totalCasts?: number;
  remainingCasts?: number;
  cycleDurationMs?: number;
  nextCastAt?: string;
  snapshotKey?: string;
};

export type ModuleRuntimeState = {
  id: string;
  /** 展示名（前端卡片标题直接用，不必再查模块清单） */
  name: string;
  enabled: boolean;
  running: boolean;
  config: Record<string, unknown>;
  /** 配置校验发现的问题（旧键、类型不符） */
  configIssues: { key: string; message: string; value: unknown }[];
  startError: string | null;
};

export type DigestPayload = {
  date: string;
  label: string;
  lines: string[];
  netGold: number;
  income: number;
  baitCost: number;
  fishTotal: number;
  xpText: string;
  levelText: string;
};

/** 补杆/退避序列（沿用实测可用值） */
const BACKOFF_SEC = [5, 10, 20, 45, 60];

/** 展示数据刷新间隔 */
const BIOMES_TTL_MS = 5 * 60_000;
const BAIT_TTL_MS = 90_000;

type ModuleInstance = {
  def: ModuleDefinition;
  ctx: ModuleContext;
  startError: string | null;
};

export type AccountRuntimeDeps = {
  repos: Repos;
  vault: CredentialVault;
  logger: Logger;
  bus: Bus;
  /** 账号行（含密文与代理 id） */
  record: AccountRow;
  /** 账号标签（展示用） */
  label: string;
  /** 全局兜底代理（账号没配代理时使用） */
  globalProxy: ProxyConfig | null;
  onPersistStatus?: (accountId: string, status: AccountStatus, lastError: string | null) => void;
  /** 注入用于测试 */
  fetchImpl?: typeof fetch;
};

export class AccountRuntime {
  readonly accountId: string;
  readonly userId: string;
  readonly label: string;

  status: AccountStatus = "stopped";
  lastError: string | null = null;
  startedAt: number | null = null;

  client: GameClient;
  readonly stats: AccountStats = {
    startedAt: 0,
    syncs: 0,
    castsResolved: 0,
    gold: 0,
    experience: 0,
    fishCount: 0,
  };

  /** 最近一次 run 快照 */
  run: RunSnapshot | null = null;
  lastSyncAt = 0;
  lastSettlement: Record<string, unknown> | null = null;
  /** 游戏内「当前在线人数」（来自 /api/fishing/state） */
  onlinePlayerCount: number | null = null;
  onlineCountAt = 0;
  /** 展示用状态面板（地图 / 经验加成 / 等级资源） */
  statusPanel: Record<string, unknown> | null = null;

  /** 凭证是否可用（MASTER_KEY 不匹配时前端要明确提示） */
  credentialError: string | null = null;

  private deps: AccountRuntimeDeps;
  private repos: Repos;
  private vault: CredentialVault;
  private log: ChildLogger;
  private bus: Bus;
  private timers: TimerPool;
  private instances = new Map<string, ModuleInstance>();
  /**
   * 每个模块注册的事件订阅取消函数。
   *
   * ★ 为什么必须自己记账：`ctx.on()` 返回的是 unsubscribe，而模块代码普遍丢弃了它。
   *   不释放的话，模块停止后旧实例仍会收到 `fishing:sync`（账号维度过滤照样命中），
   *   于是停→启一次就多一个实例在跑：两个 auto-bait 同时买饵（每笔带新幂等键 = 真实重复消费）、
   *   两个 auto-travel 抢着切图，且重复份数随每次重启/改配置线性增长。
   */
  private moduleUnsubs = new Map<string, Array<() => void>>();
  private startErrors = new Map<string, string>();
  private abortRequested = false;
  /** 上次真正写库的 (status, lastError) 指纹，用于跳过无意义的重复写 */
  private persistedStatusKey: string | null = null;
  private loopPromise: Promise<void> | null = null;
  private proxyHolder: ProxyDispatcherHolder;
  private runSerial: SerialRunner;

  /** 缓存的展示数据 */
  private biomesCache = new TtlCache<Map<string, any>>(BIOMES_TTL_MS);
  private baitCache = new TtlCache<any>(BAIT_TTL_MS);
  private meCache = new TtlCache<any>(BIOMES_TTL_MS);
  private reincarnationCache = new TtlCache<any>(BIOMES_TTL_MS);
  /** 稀有鱼硬保底进度（奇异 / 奥秘） */
  private statisticsCache = new TtlCache<any>(BIOMES_TTL_MS);
  /** 奥术宝箱硬保底 */
  private chestsCache = new TtlCache<any>(BIOMES_TTL_MS);
  /** 灯塔神器保底 */
  private lighthouseCache = new TtlCache<any>(BIOMES_TTL_MS);

  constructor(deps: AccountRuntimeDeps) {
    this.deps = deps;
    this.repos = deps.repos;
    this.vault = deps.vault;
    this.bus = deps.bus;
    this.accountId = deps.record.id;
    this.userId = deps.record.user_id;
    this.label = deps.label;
    this.log = deps.logger.child({ userId: deps.record.user_id, accountId: deps.record.id });

    // 定时器池：账号停止时统一清理，异步错误进日志
    this.timers = new TimerPool((err) => {
      this.log.error("定时器", `任务失败：${err instanceof Error ? err.message : String(err)}`);
    });

    this.runSerial = new SerialRunner((err) => {
      this.log.error("运行时", `任务异常：${err instanceof Error ? err.message : String(err)}`);
    });

    // 代理：账号自己的优先，其次全局兜底
    this.proxyHolder = new ProxyDispatcherHolder((m) => this.log.info("代理", m));

    this.client = new GameClient({
      baseUrl: deps.record.base_url,
      onLog: (level, tag, msg) => this.log[level](tag, msg),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

    this.applyCredentialsFromRecord(deps.record);
    this.applyProxyFromRecord(deps.record);
  }

  /* ---------------- 凭证与代理 ---------------- */

  /** 解密并装入凭证；解不开时明确记录原因（不静默） */
  private applyCredentialsFromRecord(record: AccountRow): void {
    let password = "";
    let cookie = "";
    let credentialError: string | null = null;

    if (record.password_enc) {
      const r = this.vault.open(record.password_enc, record.user_id, "password");
      if (r.ok) password = r.value;
      else credentialError = r.message;
    }
    if (record.cookie_enc) {
      const r = this.vault.open(record.cookie_enc, record.user_id, "cookie");
      if (r.ok) cookie = r.value;
      else credentialError = credentialError ?? r.message;
    }

    this.client.setCredentials({ email: record.email, password, cookie });
    this.credentialError = credentialError;
    if (credentialError) {
      this.log.error("凭证", credentialError);
    }
  }

  private proxyConfigFromRecord(record: AccountRow): ProxyConfig | null {
    if (!record.proxy_id) return null;
    const row = this.repos.proxies.findById(record.proxy_id);
    if (!row) return null;
    let password: string | null = null;
    if (row.password_enc) {
      const r = this.vault.open(row.password_enc, row.user_id, "proxy_password");
      if (r.ok) password = r.value;
      else {
        this.log.warn("代理", `代理口令解密失败：${r.message}`);
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

  private applyProxyFromRecord(record: AccountRow): void {
    const own = this.proxyConfigFromRecord(record);
    const effective = own ?? this.deps.globalProxy;
    const changed = this.proxyHolder.set(effective);
    if (changed || effective) {
      this.client.setDispatcher(this.proxyHolder.current);
      this.log.info("代理", own ? `使用账号代理 ${own.host}:${own.port}` : effective ? "使用全局兜底代理" : "直连（未配置代理）");
    }
  }

  /** 代理配置在数据库里被修改后调用：重建 dispatcher，下一次请求即生效 */
  refreshProxy(): void {
    const record = this.repos.accounts.findById(this.accountId);
    if (!record) return;
    this.applyProxyFromRecord(record);
  }

  /** 凭证被修改后调用：更新客户端并清 proof 强制重登 */
  refreshCredentials(): void {
    const record = this.repos.accounts.findById(this.accountId);
    if (!record) return;
    this.applyCredentialsFromRecord(record);
  }

  /* ---------------- 事件与定时器（暴露给模块） ---------------- */

  on = (event: string, handler: (payload: any) => void): (() => void) => {
    const off = this.bus.on(event, (payload: any) => {
      // 只处理本账号的事件（模块不该看到别人的）
      if (payload?.accountId && payload.accountId !== this.accountId) return;
      if (payload?.userId && payload.userId !== this.userId && payload?.accountId !== this.accountId) return;
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err) => {
          this.log.error("模块", `事件 ${event} 处理失败：${err instanceof Error ? err.message : String(err)}`);
        });
    });
    return off;
  };

  every = (ms: number, fn: () => unknown | Promise<unknown>): NodeJS.Timeout => {
    return this.timers.every(ms, fn);
  };

  schedule = (ms: number, fn: () => unknown | Promise<unknown>): NodeJS.Timeout => {
    return this.timers.schedule(ms, fn);
  };

  /** 模块抛出的结构化事件（如日报 digest） */
  emit = (event: string, payload: Record<string, unknown>): void => {
    this.bus.emit(event, { accountId: this.accountId, userId: this.userId, label: this.label, ...payload });
  };

  /** 供模块读取本次运行累计统计（日报的「无基线」兜底） */
  runtimeStats = (): AccountStats => this.stats;

  /* ---------------- 状态上报 ---------------- */

  setStatus(status: AccountStatus, detail?: string | null): void {
    if (this.status !== status) {
      this.status = status;
      this.bus.emit(EVENTS.ACCOUNT_STATUS, {
        accountId: this.accountId,
        userId: this.userId,
        status,
        detail: detail ?? null,
      });
    }
    if (detail !== undefined) this.lastError = detail;
    // ★ 只在「状态或错误信息真的变了」时写库。
    //   tickLoop 每轮都会调 setStatus("online", null)，早期实现让每个账号
    //   每 ~6 秒白写一次 SQLite（多余的 WAL 增长 + 无意义 IO）。
    const key = `${status}\u0000${this.lastError ?? ""}`;
    if (key === this.persistedStatusKey) return;
    this.deps.onPersistStatus?.(this.accountId, status, this.lastError);
    this.persistedStatusKey = key;
  }

  reportError(message: string): void {
    this.lastError = message;
    this.bus.emit(EVENTS.ACCOUNT_ERROR, { accountId: this.accountId, userId: this.userId, message });
  }

  /** 同一 run 增量合并，并保留 state 有而 sync 无的字段 */
  reportRun(run: RunSnapshot | null | undefined): void {
    if (!run) return;
    const prev = this.run;
    this.run =
      prev && prev.id === run.id
        ? { ...prev, ...run, totalCasts: run.totalCasts ?? prev.totalCasts }
        : run;
  }

  reportSync(input: {
    run?: RunSnapshot | null;
    settlement?: Record<string, any> | null;
    playerPatch?: Record<string, any> | null;
  }): void {
    this.reportRun(input.run ?? null);
    this.lastSyncAt = Date.now();
    const settlement = input.settlement ?? null;
    this.lastSettlement = settlement;

    const st = this.stats;
    st.syncs++;
    if (settlement) {
      const casts = Number(settlement.castsResolved) || 0;
      const gold = Number(settlement.directGoldNet ?? settlement.gold) || 0;
      const exp = Number(settlement.experience) || 0;
      const fish = Array.isArray(settlement.fish)
        ? settlement.fish.reduce((a: number, f: any) => a + (Number(f?.quantity) || 0), 0)
        : 0;
      st.castsResolved += casts;
      st.gold += gold;
      st.experience += exp;
      st.fishCount += fish;

      // 落库统计（日报与统计页共用），按本地日累加
      try {
        this.repos.stats.add(this.accountId, this.userId, {
          casts,
          gold,
          experience: exp,
          fish,
          gear: Array.isArray(settlement.gear) ? settlement.gear.length : 0,
          chests: Array.isArray(settlement.chests) ? settlement.chests.length : 0,
          relics: Number(settlement.relics) || 0,
        });
      } catch (err) {
        this.log.warn("统计", `写入每日统计失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.bus.emit(EVENTS.FISHING_SYNC, {
      accountId: this.accountId,
      userId: this.userId,
      run: this.run,
      settlement,
      playerPatch: input.playerPatch ?? null,
    });
  }

  reportOnlineCount(count: unknown): void {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 0) return;
    const changed = this.onlinePlayerCount !== n;
    this.onlinePlayerCount = n;
    this.onlineCountAt = Date.now();
    if (changed) {
      this.bus.emit(EVENTS.ACCOUNT_STATUS, {
        accountId: this.accountId,
        userId: this.userId,
        status: this.status,
        detail: null,
      });
    }
  }

  reportStatusPanel(panel: Record<string, unknown> | null): void {
    if (!panel) return;
    const changed = JSON.stringify(this.statusPanel) !== JSON.stringify(panel);
    this.statusPanel = { ...panel, at: Date.now() };
    if (changed) {
      this.bus.emit(EVENTS.ACCOUNT_STATUS, {
        accountId: this.accountId,
        userId: this.userId,
        status: this.status,
        detail: null,
      });
    }
  }

  /* ---------------- 展示数据缓存 ---------------- */

  get biomes(): Map<string, any> {
    return this.biomesCache.peek() ?? new Map();
  }
  get bait(): any {
    return this.baitCache.peek();
  }
  get me(): any {
    return this.meCache.peek();
  }
  get reincarnation(): any {
    return this.reincarnationCache.peek();
  }
  get statistics(): any {
    return this.statisticsCache.peek();
  }
  get chests(): any {
    return this.chestsCache.peek();
  }
  get lighthouse(): any {
    return this.lighthouseCache.peek();
  }

  /** 刷新地图表 / 鱼饵 / 玩家资料（供状态面板使用；失败不影响钓鱼） */
  async refreshDisplayData(force = false): Promise<void> {
    await Promise.all([
      this.biomesCache
        .get(async () => {
          const d = await this.client.biomes();
          const map = new Map<string, any>();
          for (const b of d?.biomes ?? []) if (b?.id) map.set(b.id, b);
          return map;
        }, force)
        .catch(() => this.biomesCache.peek() ?? new Map()),
      this.baitCache
        .get(async () => {
          const d = await this.client.baits();
          return (d?.baits ?? []).find((b: any) => b?.isSelected) ?? null;
        }, force)
        .catch(() => this.baitCache.peek()),
      this.meCache.get(() => this.client.me(), force).catch(() => this.meCache.peek()),
      this.reincarnationCache.get(() => this.client.reincarnation(), force).catch(() => this.reincarnationCache.peek()),
      // 保底类数据：状态面板要显示「还差多少杆 / 多少个」，失败不影响钓鱼
      this.statisticsCache.get(() => this.client.statistics(), force).catch(() => this.statisticsCache.peek()),
      this.chestsCache.get(() => this.client.chests(), force).catch(() => this.chestsCache.peek()),
      this.lighthouseCache.get(() => this.client.lighthouseLottery(), force).catch(() => this.lighthouseCache.peek()),
    ]);
  }

  /* ---------------- 模块管理 ---------------- */

  /** 解析某模块的最终配置（默认值 + 用户配置，含校验） */
  resolveConfig(def: ModuleDefinition): { config: Record<string, unknown>; issues: ModuleRuntimeState["configIssues"] } {
    const stored = this.repos.modules.find(this.accountId, def.id);
    const { config, issues } = resolveModuleConfig(def, stored?.config);
    return { config, issues };
  }

  /** 该模块是否启用（会话级记录优先，其次模块默认值） */
  isEnabled(def: ModuleDefinition): boolean {
    const stored = this.repos.modules.find(this.accountId, def.id);
    if (stored) return stored.enabled;
    return def.defaultEnabled;
  }

  moduleStates(): ModuleRuntimeState[] {
    return MODULES.map((def) => {
      const { config, issues } = this.resolveConfig(def);
      const inst = this.instances.get(def.id);
      return {
        id: def.id,
        name: def.name,
        enabled: inst ? true : this.isEnabled(def),
        running: Boolean(inst),
        config,
        configIssues: issues,
        startError: inst?.startError ?? this.startErrors.get(def.id) ?? null,
      };
    });
  }

  private buildContext(def: ModuleDefinition, config: Record<string, unknown>): ModuleContext {
    // 载入上次持久化的运行状态（没有就是空对象）。
    // 模块想丢弃旧状态就在 onStart 里显式重置对应字段。
    const state: Record<string, unknown> = { ...this.repos.modules.getState(this.accountId, def.id) };
    return {
      moduleId: def.id,
      config,
      state,
      log: this.log.child({ moduleId: def.id }),
      api: this.client,
      account: this,
      // ★ 交给模块的是「带清理的 on」：注册时就按模块名记下取消函数，
      //   stopModule / 启动失败 / dispose 时统一释放。
      on: (event, handler) => {
        const off = this.on(event, handler);
        const list = this.moduleUnsubs.get(def.id);
        if (list) list.push(off);
        else this.moduleUnsubs.set(def.id, [off]);
        return off;
      },
      every: this.every,
      schedule: this.schedule,
      persistState: () => {
        try {
          this.repos.modules.setState(this.accountId, def.id, state);
        } catch (err) {
          this.log.warn("模块", `${def.id} 状态落库失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
  }

  /** 启动全部已启用模块（单个失败不影响其他） */
  async startModules(): Promise<void> {
    for (const def of MODULES) {
      await this.startModule(def);
    }
  }

  async startModule(def: ModuleDefinition): Promise<{ ok: boolean; error?: string }> {
    this.startErrors.delete(def.id);
    if (!this.isEnabled(def)) return { ok: true };

    const { config } = this.resolveConfig(def);
    const ctx = this.buildContext(def, config);

    try {
      await def.onStart?.(ctx);
      this.instances.set(def.id, { def, ctx, startError: null });
      this.log.info("模块", `${def.name} 已启动`);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // onStart 可能已经注册了订阅才抛错，这里也要释放，否则留下收不到 onStop 的幽灵订阅
      this.releaseModuleUnsubs(def.id);
      this.startErrors.set(def.id, msg);
      this.log.error("模块", `启动 ${def.id} 失败：${msg}`);
      return { ok: false, error: msg };
    }
  }

  async stopModule(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (inst) {
      try {
        await inst.def.onStop?.(inst.ctx);
      } catch (err) {
        this.log.warn("模块", `停止 ${id} 时报错：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // 无论有没有实例都要释放（onStart 失败的模块可能只留下订阅）
    this.releaseModuleUnsubs(id);
    this.instances.delete(id);
  }

  /** 释放某模块注册的事件订阅（模块停止 / 启动失败 / 实例废弃时调用） */
  private releaseModuleUnsubs(id: string): void {
    const list = this.moduleUnsubs.get(id);
    if (!list) return;
    this.moduleUnsubs.delete(id);
    for (const off of list) {
      try {
        off();
      } catch {
        /* 取消失败不影响停止流程 */
      }
    }
  }

  /**
   * 模块配置被修改后热重启：停旧的、按新配置起新的。
   * 账号未运行时只更新配置、不实例化。
   */
  async restartModule(id: string): Promise<{ ok: boolean; error?: string; enabled: boolean }> {
    const def = getModule(id);
    if (!def) return { ok: false, error: "模块不存在", enabled: false };

    await this.stopModule(id);
    if (this.status === "stopped") return { ok: true, enabled: this.isEnabled(def) };

    const res = await this.startModule(def);
    return { ok: res.ok, ...(res.error ? { error: res.error } : {}), enabled: this.isEnabled(def) };
  }

  /* ---------------- 生命周期 ---------------- */

  async start(): Promise<void> {
    if (this.status === "online" || this.status === "starting") return;
    this.abortRequested = false;
    this.setStatus("starting", null);
    this.startedAt = Date.now();
    this.stats.startedAt = this.startedAt;

    // 每次启动都重新读一次凭证与代理（可能刚被用户改过）
    this.refreshCredentials();
    this.refreshProxy();

    if (this.credentialError) {
      this.setStatus("expired", this.credentialError);
      throw new Error(this.credentialError);
    }

    try {
      await this.client.ensureSession();
    } catch (err) {
      const e = err as GameClientError;
      const expired = e?.isSessionFatal;
      this.setStatus(expired ? "expired" : "error", e?.message ?? String(err));
      this.startedAt = null;
      throw err;
    }

    // 启动模块
    await this.startModules();

    // 启动节拍循环（只有启用了 keep-online 才真正跑钓鱼）
    const keepOnlineDef = getModule("keep-online");
    const keepOnlineEnabled = keepOnlineDef ? this.isEnabled(keepOnlineDef) : false;
    this.setStatus("online", null);
    this.bus.emit(EVENTS.ACCOUNT_STARTED, { accountId: this.accountId, userId: this.userId });

    if (keepOnlineEnabled) {
      this.loopPromise = this.tickLoop().catch((err) => {
        this.log.error("保持在线", `循环意外退出：${err instanceof Error ? err.message : String(err)}`);
      });
    } else {
      this.log.info("会话", "「保持在线」未启用，账号不会产生渔获（仅运行其他模块）");
    }
  }

  async stop(reason = "手动停止"): Promise<void> {
    if (this.status === "stopped") return;
    this.log.info("会话", `停止账号「${this.label}」：${reason}`);
    this.abortRequested = true;

    // 先停模块（它们可能持有定时器），再清空定时器池
    for (const id of [...this.instances.keys()]) {
      await this.stopModule(id);
    }
    this.timers.clear();

    // 等循环退出（最多 2 秒，避免卡住停止流程）
    if (this.loopPromise) {
      await Promise.race([this.loopPromise, new Promise((r) => setTimeout(r, 2000))]);
      this.loopPromise = null;
    }

    await this.proxyHolder.close().catch(() => {});
    this.setStatus("stopped", null);
    this.startedAt = null;
    this.bus.emit(EVENTS.ACCOUNT_STOPPED, { accountId: this.accountId, userId: this.userId, reason });
  }

  private isAborted(): boolean {
    return this.abortRequested || this.status === "stopped";
  }

  /** 保持在线主循环 */
  private async tickLoop(): Promise<void> {
    let backoffIdx = 0;
    let snapshotKey = "missing";
    let keyRunId: string | null = null;

    const keepOnline = getModule("keep-online");
    const cfg = keepOnline ? this.resolveConfig(keepOnline).config : {};
    const autoRefill = cfg.autoRefill !== false;
    const syncJitterMs = clamp(Number(cfg.syncJitterMs) || 0, 0, 3000);
    const retrySec = clamp(Number(cfg.retrySec) || 30, 1, 600);

    while (!this.isAborted()) {
      try {
        const st = await this.client.fishingState();
        this.reportOnlineCount(st?.onlinePlayerCount);
        await this.refreshDisplayData();
        this.reportStatusPanel(buildStatusPanel(st, this));

        let run: RunSnapshot | undefined = st?.run;

        // 1. 确保有一轮在跑
        if (!run || run.status !== "running") {
          try {
            const started = await this.client.fishingStart();
            run = started?.run;
            this.log.info(
              "保持在线",
              `开始钓鱼：${run?.remainingCasts ?? "?"}/${run?.totalCasts ?? "?"} 杆，周期 ${run?.cycleDurationMs ?? "?"}ms`,
            );
          } catch (err) {
            if (!autoRefill) throw err;
            this.log.info("保持在线", `直接开始失败（${describe(err)}），尝试补杆`);
            const rf = await this.client.fishingRefill();
            run = rf?.run;
            if (!run || run.status !== "running") {
              run = (await this.client.fishingStart())?.run;
            }
            this.log.info("保持在线", `补杆完成：${run?.remainingCasts ?? "?"} 杆可用`);
          }
        }

        if (!run || run.status !== "running") {
          throw new Error(`钓鱼未能开始（${run?.status ?? "unknown"}）`);
        }
        this.reportRun(run);

        // 2. 等到下一次结算 + 抖动
        const cycle = Number(run.cycleDurationMs) || 6000;
        const nextCastAt = parseTime(run.nextCastAt) ?? Date.now() + cycle;
        const wakeAt = nextCastAt + (syncJitterMs > 0 ? jitter(syncJitterMs) : 0);
        await sleepUntil(wakeAt, () => this.isAborted(), 800);
        if (this.isAborted()) return;

        // 3. 同步（run 换代时用 missing，与官方客户端一致）
        const key = keyRunId === run.id ? snapshotKey : "missing";
        const resp = await this.client.fishingSync(key);
        if (resp?.run) {
          if (resp.run.snapshotKey) snapshotKey = resp.run.snapshotKey;
          keyRunId = resp.run.id;
          run = resp.run;
        }

        const settlement = resp?.settlement ?? null;
        this.reportSync({ run, settlement, playerPatch: resp?.playerPatch ?? null });
        this.setStatus("online", null);

        if (settlement?.mode && settlement.mode !== "online") {
          this.log.warn("保持在线", `本轮结算为「${settlement.mode}」模式，未按在线计（同步不及时？）`);
        }

        if (run && run.status !== "running") {
          this.log.info("保持在线", `本轮结束（${run.status}），准备${autoRefill ? "补杆" : "重启"}`);
        }

        backoffIdx = 0;
      } catch (err) {
        if (this.isAborted()) break;

        // 会话类错误：挂起，等用户处理，不要无限重试
        if (err instanceof GameClientError && err.isSessionFatal) {
          this.setStatus("expired", err.message);
          this.log.error("保持在线", `会话已失效，引擎挂起：${err.message}`);
          return;
        }
        // 凭证解不开也挂起
        if (err instanceof GameClientError && err.code === GAME_ERROR_CODES.NO_CREDENTIALS) {
          this.setStatus("expired", err.message);
          this.log.error("保持在线", `缺少凭证，引擎挂起：${err.message}`);
          return;
        }

        const sec = clamp(BACKOFF_SEC[Math.min(backoffIdx, BACKOFF_SEC.length - 1)] ?? retrySec, 1, retrySec);
        backoffIdx++;
        this.setStatus("reconnecting", describe(err));
        this.log.warn("保持在线", `异常：${describe(err)}，${sec}s 后重试`);
        await sleepUntil(Date.now() + sec * 1000, () => this.isAborted(), 800);
      }
    }

    this.log.info("保持在线", "引擎已停止");
  }

  /** 供模块与 API 查询当前是否在跑 */
  get isRunning(): boolean {
    return this.status !== "stopped";
  }

  get proxyFingerprint(): string {
    return this.proxyHolder.currentFingerprint;
  }

  /** 供测试观察 */
  get moduleInstances(): string[] {
    return [...this.instances.keys()];
  }

  get timerCount(): number {
    return this.timers.size;
  }

  /**
   * 释放资源（账号被删除时调用）。与 stop() 的区别：
   * stop 只是挂起，dispose 之后这个实例不再可用 —— 关掉代理连接池。
   */
  async dispose(): Promise<void> {
    this.abortRequested = true;
    // 兜底：正常路径上 stop() 已经释放过了，这里防止「实例被丢弃但订阅还在」
    for (const id of [...this.moduleUnsubs.keys()]) this.releaseModuleUnsubs(id);
    this.timers.clear();
    await this.proxyHolder.close().catch(() => {});
  }
}

function describe(err: unknown): string {
  if (err instanceof GameClientError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * 组装展示用状态面板（纯展示，算错不影响钓鱼）。
 * 实现见 modules/keep-online/status-panel.ts，由该模块通过 registerStatusPanelBuilder 注入。
 */
function buildStatusPanel(st: any, rt: AccountRuntime): Record<string, unknown> {
  if (!statusPanelImpl) return {};
  try {
    return statusPanelImpl(st, rt);
  } catch {
    return {};
  }
}
