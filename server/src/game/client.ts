// 游戏签名客户端
//
// 协议要点（详见 docs/PROTOCOL.md）：
//  1) POST /api/auth/login {email,password} → Set-Cookie: arcane_session=...
//  2) 任意响应头 x-arcane-request-proof 即 HMAC 密钥
//     （base64url(JSON{version,expiresAt}) + "." + 签名）
//  3) 受保护请求需携带：
//       x-arcane-request-proof       密钥本体
//       x-arcane-request-timestamp   毫秒时间戳（用 x-arcane-server-time 校正）
//       x-arcane-request-signature   base64url(HMAC-SHA256(payload))
//     payload = "v1\nMETHOD\npath?query\nts\nbody"（\n 连接，body 为实际发送的 JSON 字符串）
//  4) proof 有效期约 10~20 分钟，过期后签名请求失败 → 重新 GET /api/me 续期
//
// 本实现相对旧版的改动：
//  - 支持 dispatcher 注入（每账号独立代理），调用点无需关心代理
//  - 显式超时（旧版没有超时，网络卡住会永久挂起）
//  - x-frontend-version 不再硬编码过期版本，可配置并随响应更新
//  - 错误分类更细（见 errors.ts），模块据此决定「退避重试」还是「挂起」
import { createHmac } from "node:crypto";
import type { Dispatcher } from "undici";
import { GAME_ERROR_CODES, GameClientError, codeForStatus, looksLikeSignatureIssue } from "./errors.ts";
import { classifyProxyError, describeProxyError } from "./proxy.ts";
import { b64urlEncode, parseTime } from "../lib/util.ts";

/** 免签名白名单 */
const SIGNED_SKIP = new Set(["/api/auth/login", "/api/me", "/api/meta/frontend-release"]);

/** 登录接口：它的 401 是「凭据被拒」，不是「会话失效」 */
const LOGIN_PATH = "/api/auth/login";

/** proof 到期前多久就主动续期 */
const PROOF_REFRESH_MARGIN_MS = 60_000;

/** 默认前端版本（游戏版本更新后可在账号配置里覆盖） */
const DEFAULT_FRONTEND_VERSION = "0.24.3";

export type GameClientOptions = {
  baseUrl: string;
  email?: string;
  password?: string;
  cookie?: string;
  /** 前端版本号，会随响应头自动更新 */
  frontendVersion?: string;
  /** 单请求超时（毫秒） */
  timeoutMs?: number;
  /** 代理 dispatcher；undefined 表示直连 */
  dispatcher?: Dispatcher;
  /** 日志回调（避免客户端依赖 Logger 类型） */
  onLog?: (level: "info" | "warn" | "error", tag: string, msg: string) => void;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
};

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  /** 是否附带幂等键（写操作建议开启） */
  idempotent?: boolean;
  /** 额外请求头 */
  extraHeaders?: Record<string, string>;
  /** 单请求超时覆盖 */
  timeoutMs?: number;
  /** 内部：防止重登递归 */
  _relogin?: boolean;
};

export type PlayerSnapshot = {
  nickname?: string | null;
  level?: number | null;
  gold?: number | null;
  relics?: number | null;
  fragments?: number | null;
};

export class GameClient {
  baseUrl: string;
  email: string;
  password: string;
  cookie: string;
  frontendVersion: string;
  timeoutMs: number;

  /** 当前 proof 密钥 */
  proof: string | null = null;
  proofExpiresAt = 0;
  /** 服务器时间与本地时间的偏移（毫秒） */
  serverTimeOffset = 0;
  player: PlayerSnapshot | null = null;
  publicIdentity: { publicId?: string } | null = null;

  private dispatcher: Dispatcher | undefined;
  private onLog: GameClientOptions["onLog"];
  private fetchImpl: typeof fetch;

  constructor(opts: GameClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.email = opts.email ?? "";
    this.password = opts.password ?? "";
    this.cookie = opts.cookie ?? "";
    this.frontendVersion = opts.frontendVersion || DEFAULT_FRONTEND_VERSION;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.dispatcher = opts.dispatcher;
    this.onLog = opts.onLog;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get hasCredentials(): boolean {
    return Boolean(this.email && this.password);
  }

  /** 校正后的当前时间 */
  now(): number {
    return Date.now() + this.serverTimeOffset;
  }

  /** 代理变更后替换 dispatcher（无需重建客户端，凭证与会话都保留） */
  setDispatcher(dispatcher: Dispatcher | undefined): void {
    this.dispatcher = dispatcher;
  }

  /** 更新凭证（用户改密码/换 Cookie 后调用，会清掉旧 proof 强制重登） */
  setCredentials(input: { email?: string; password?: string; cookie?: string }): void {
    if (input.email !== undefined) this.email = input.email;
    if (input.password !== undefined) this.password = input.password;
    if (input.cookie !== undefined) this.cookie = input.cookie;
    this.proof = null;
    this.proofExpiresAt = 0;
  }

  private log(level: "info" | "warn" | "error", tag: string, msg: string): void {
    this.onLog?.(level, tag, msg);
  }

  /* ---------- 签名 ---------- */

  /**
   * HMAC-SHA256(payload)，payload 各段用 \n 连接。
   * 导出为静态方法便于单测对账（用固定向量验证算法本身没写错）。
   */
  static buildPayload(method: string, path: string, ts: string, bodyStr: string): string {
    return ["v1", method.toUpperCase(), path, ts, bodyStr].join("\n");
  }

  static signWithProof(proof: string, method: string, path: string, ts: string, bodyStr: string): string {
    const payload = GameClient.buildPayload(method, path, ts, bodyStr);
    return b64urlEncode(createHmac("sha256", proof).update(payload, "utf8").digest());
  }

  sign(method: string, path: string, ts: string, bodyStr: string): string {
    if (!this.proof) throw new GameClientError("缺少签名密钥（proof）", { code: GAME_ERROR_CODES.SESSION_EXPIRED });
    return GameClient.signWithProof(this.proof, method, path, ts, bodyStr);
  }

  /** 从 proof 里解析出过期时间（第一段是 base64url 的 JSON） */
  static parseProofExpiry(proof: string): number {
    try {
      const payloadB64 = proof.split(".")[0] ?? "";
      const json = Buffer.from(payloadB64.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
      const parsed = JSON.parse(json) as { expiresAt?: number };
      return Number(parsed.expiresAt) || 0;
    } catch {
      return 0;
    }
  }

  setProof(proof: string): void {
    this.proof = proof;
    this.proofExpiresAt = GameClient.parseProofExpiry(proof);
  }

  /* ---------- 会话引导 ---------- */

  async login(): Promise<unknown> {
    if (!this.hasCredentials) {
      throw new GameClientError("未配置邮箱或密码，无法登录", { code: GAME_ERROR_CODES.NO_CREDENTIALS });
    }
    const data = await this.request("/api/auth/login", {
      method: "POST",
      body: { email: this.email, password: this.password },
      idempotent: true,
      _relogin: false,
    });
    this.log("info", "登录", `账号 ${this.email} 登录成功`);
    return data;
  }

  /** 刷新 proof：GET /api/me（免签名） */
  async refreshProof(): Promise<any> {
    const resp = await this.raw("/api/me", { headers: { "cache": "no-store" } });
    const data = await this.readJson(resp);
    if (resp.status === 401 || resp.status === 403) {
      throw new GameClientError("会话已失效", {
        status: resp.status,
        code: GAME_ERROR_CODES.SESSION_EXPIRED,
        payload: data,
      });
    }
    if (!resp.ok) {
      const msg = pickErrorMessage(data) || `刷新会话失败（HTTP ${resp.status}）`;
      throw new GameClientError(msg, { status: resp.status, code: codeForStatus(resp.status), payload: data });
    }
    this.absorb(resp, data);
    return data;
  }

  /** 确保会话可用：有 Cookie 先验证；失效且有账密则重新登录 */
  async ensureSession(): Promise<any> {
    try {
      return await this.refreshProof();
    } catch (err) {
      if (err instanceof GameClientError && err.code === GAME_ERROR_CODES.SESSION_EXPIRED && this.hasCredentials) {
        this.log("warn", "会话", "Cookie 已失效，正在用账号密码重新登录");
        return await this.login();
      }
      throw err;
    }
  }

  /* ---------- 统一请求入口 ---------- */

  async request(path: string, opts: RequestOptions = {}): Promise<any> {
    const method = opts.method ?? "GET";
    // 幂等键在重试间必须复用，否则服务端会把重试当成第二次操作
    const idempotencyKey = opts.idempotent ? crypto.randomUUID() : null;

    if (!this.proof && !SIGNED_SKIP.has(path)) {
      await this.ensureSession();
    }
    // proof 临近过期则主动续期（省掉一次「失败 → 重试」）
    if (this.proof && this.proofExpiresAt && this.now() > this.proofExpiresAt - PROOF_REFRESH_MARGIN_MS) {
      try {
        await this.refreshProof();
      } catch (err) {
        this.log("warn", "会话", `proof 续期失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const attempt = async (isRetry: boolean): Promise<any> => {
      const ts = String(this.now());
      const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : "";

      const headers: Record<string, string> = {
        Accept: "application/json",
        "x-frontend-version": this.frontendVersion || DEFAULT_FRONTEND_VERSION,
        ...(opts.headers ?? {}),
        ...(opts.extraHeaders ?? {}),
      };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      if (this.cookie) headers["Cookie"] = this.cookie;

      if (this.proof && !SIGNED_SKIP.has(path)) {
        headers["x-arcane-request-proof"] = this.proof;
        headers["x-arcane-request-timestamp"] = ts;
        headers["x-arcane-request-signature"] = this.sign(method, path, ts, bodyStr);
      }

      let resp: Response;
      try {
        resp = await this.raw(path, { method, headers, body: opts.body !== undefined ? bodyStr : undefined });
      } catch (err) {
        throw this.toNetworkError(err, opts.timeoutMs);
      }

      const text = await resp.text().catch(() => "");
      const data = parseJsonLoose(text);
      this.absorb(resp, data);

      if (resp.ok) {
        return data;
      }

      const message = pickErrorMessage(data) || text.slice(0, 300);

      // ★ 除了**登录接口本身**，其余请求的 401/403 都可能是「proof 过期 / Cookie 失效」，
      //   应当续期或重登后重试。唯独登录接口不签名，它的 401 含义是「邮箱或口令不对」——
      //   早期把登录也塞进这个分支，最终报成「会话已失效且无法自动重登」，
      //   用户按提示去修 Cookie，排查方向完全错了。
      const canRefreshSession = path !== LOGIN_PATH;

      if (canRefreshSession && looksLikeSignatureIssue(resp.status, text, message) && !isRetry) {
        // proof 过期 / Cookie 失效：先续期，续期失败且有账密则重登，然后重试一次
        try {
          await this.refreshProof();
        } catch (refreshErr) {
          if (this.hasCredentials && opts._relogin !== false) {
            await this.login();
          } else {
            throw new GameClientError(
              `会话已失效且无法自动重登：${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`,
              { status: resp.status, code: GAME_ERROR_CODES.SESSION_EXPIRED, payload: data },
            );
          }
        }
        return attempt(true);
      }

      const loginRejected = path === LOGIN_PATH && (resp.status === 401 || resp.status === 403);
      throw new GameClientError(
        loginRejected
          ? `邮箱或口令不正确${message ? `（${message}）` : ""}`
          : message || `请求失败（HTTP ${resp.status}）`,
        {
          status: resp.status,
          code: loginRejected
            ? GAME_ERROR_CODES.BAD_CREDENTIALS
            : codeForStatus(resp.status, extractServerCode(data)),
          payload: data,
        },
      );
    };

    return attempt(false);
  }

  /** 网络异常 → 分类错误（代理问题与游戏侧问题要能区分） */
  private toNetworkError(err: unknown, timeoutOverride?: number): GameClientError {
    const causeName = (err as { name?: string })?.name;
    if (causeName === "TimeoutError" || causeName === "AbortError") {
      return new GameClientError(`请求超时（${timeoutOverride ?? this.timeoutMs}ms）`, {
        code: GAME_ERROR_CODES.TIMEOUT,
      });
    }

    // ★ 只有在确实配了代理时，才把失败归因到代理。
    //   直连时的 ECONNREFUSED 就是普通的网络错误，报成「代理连接失败」会误导排查方向。
    if (this.dispatcher) {
      const proxyCode = classifyProxyError(err);
      if (proxyCode !== "PROXY_ERROR") {
        return new GameClientError(`代理连接失败：${describeProxyError(err)}`, { code: proxyCode });
      }
    }

    return new GameClientError(`网络错误：${describeProxyError(err) || String(err)}`, {
      code: GAME_ERROR_CODES.NETWORK,
    });
  }

  /* ---------- 便捷封装 ---------- */

  me() {
    return this.request("/api/me");
  }
  fishingState() {
    return this.request("/api/fishing/state");
  }
  fishingStart() {
    return this.request("/api/fishing/start", { method: "POST", idempotent: true });
  }
  fishingStop() {
    return this.request("/api/fishing/stop", { method: "POST", idempotent: true });
  }
  fishingRefill() {
    return this.request("/api/fishing/refill", { method: "POST", idempotent: true });
  }
  fishingSync(snapshotKey?: string) {
    return this.request("/api/fishing/sync", {
      method: "POST",
      idempotent: true,
      extraHeaders: { "X-Fishing-Run-Snapshot-Key": snapshotKey || "missing" },
    });
  }
  biomes() {
    return this.request("/api/biomes");
  }
  biomeTravel(biomeId: string) {
    return this.request("/api/player/current-biome", { method: "PUT", body: { biomeId } });
  }
  routeTravel() {
    return this.request("/api/route-assistant/travel", { method: "POST", idempotent: true });
  }
  dailyCheckInStatus() {
    return this.request("/api/daily-check-in");
  }
  dailyCheckInClaim() {
    return this.request("/api/daily-check-in/claim", { method: "POST", idempotent: true });
  }
  statsAllocate(body: unknown) {
    return this.request("/api/player/stats/allocate", { method: "POST", body, idempotent: true });
  }
  statsReset() {
    return this.request("/api/player/stats/reset", { method: "POST", idempotent: true });
  }
  mastery() {
    return this.request("/api/mastery");
  }
  masteryContributeAll(biomeId: string, excludedRarities: string[]) {
    return this.request(`/api/mastery/${encodeURIComponent(biomeId)}/contribute-all`, {
      method: "POST",
      body: { excludedRarities },
      idempotent: true,
    });
  }
  worldBoss() {
    return this.request("/api/events/world-boss");
  }
  worldBossSelect(stat: string) {
    return this.request("/api/events/world-boss/selection", { method: "POST", body: { stat }, idempotent: true });
  }
  tournamentsOverview() {
    return this.request("/api/tournaments/overview");
  }
  guildTournamentsOverview() {
    return this.request("/api/guild-tournaments/overview");
  }
  tournamentRegister(id: string) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/register`, {
      method: "POST",
      body: {},
      idempotent: true,
    });
  }
  guildsMe() {
    return this.request("/api/guilds/me");
  }
  gearInventory(cursor?: string) {
    return this.request("/api/inventory/gear" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""));
  }
  gearSell(gearIds: string[]) {
    return this.request("/api/inventory/gear/sell", { method: "POST", body: { gearIds }, idempotent: true });
  }
  inventoryFish() {
    return this.request("/api/inventory/fish");
  }
  sellFish(items: unknown[]) {
    return this.request("/api/inventory/fish/sell", { method: "POST", body: { items }, idempotent: true });
  }
  baits() {
    return this.request("/api/baits");
  }
  /** 奥术宝箱列表（含每个宝箱的硬保底进度） */
  chests() {
    return this.request("/api/inventory/chests");
  }
  /** 灯塔抽奖状态（含神器保底进度） */
  lighthouseLottery() {
    return this.request("/api/lighthouse-lottery");
  }
  /** 购买鱼饵（注意：不是 POST /api/baits，而是 /api/baits/{id}/purchase） */
  purchaseBait(baitId: string, quantity: number) {
    return this.request(`/api/baits/${encodeURIComponent(baitId)}/purchase`, {
      method: "POST",
      body: { quantity },
      idempotent: true,
    });
  }
  /** 装备/切换鱼饵 */
  equipBait(baitId: string) {
    return this.request(`/api/baits/${encodeURIComponent(baitId)}/equip`, { method: "POST", idempotent: true });
  }
  /** 购买商店商品（productId + quantity） */
  buyProduct(productId: string, quantity = 1) {
    return this.request("/api/shop/purchases", { method: "POST", body: { productId, quantity }, idempotent: true });
  }
  /** 拆解装备（只能传传说/神话/奇异） */
  gearDismantle(gearIds: string[]) {
    return this.request("/api/inventory/gear/dismantle", { method: "POST", body: { gearIds }, idempotent: true });
  }
  guildTournamentRegister(id: string) {
    return this.request(`/api/guild-tournaments/${encodeURIComponent(id)}/register`, {
      method: "POST",
      body: {},
      idempotent: true,
    });
  }
  statistics() {
    return this.request("/api/statistics");
  }
  reincarnation() {
    return this.request("/api/player/reincarnation");
  }
  convenience() {
    return this.request("/api/convenience");
  }

  /* ---------- 底层 ---------- */

  async raw(
    path: string,
    { method = "GET", headers = {}, body, timeoutMs }: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const url = this.baseUrl + path;
    const timeout = timeoutMs ?? this.timeoutMs;

    const init: RequestInit & { dispatcher?: Dispatcher } = {
      method,
      headers: {
        // 与真实浏览器一致，降低被识别为脚本的概率
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/`,
        ...headers,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    };
    if (this.dispatcher) init.dispatcher = this.dispatcher;

    return this.fetchImpl(url, init);
  }

  private async readJson(resp: Response): Promise<any> {
    const text = await resp.text().catch(() => "");
    return parseJsonLoose(text);
  }

  /** 从响应里吸收 proof / 服务器时间 / 版本 / Cookie / 玩家信息 */
  absorb(resp: Response, data: unknown): void {
    // Cookie：服务端可能刷新会话
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    if (setCookies.length) {
      this.cookie = setCookies.map((c) => c.split(";")[0] ?? "").filter(Boolean).join("; ");
    }

    // 服务器时间校正
    const serverTime = resp.headers.get("x-arcane-server-time");
    if (serverTime) {
      const st = Number(serverTime);
      if (Number.isSafeInteger(st) && st > 0) this.serverTimeOffset = st - Date.now();
    }

    // proof
    const proof = resp.headers.get("x-arcane-request-proof");
    if (proof) this.setProof(proof);

    // 前端版本
    const fe = resp.headers.get("x-frontend-version");
    if (fe) this.frontendVersion = fe;

    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (d.player && typeof d.player === "object") this.player = d.player as PlayerSnapshot;
      if (d.publicIdentity && typeof d.publicIdentity === "object") {
        this.publicIdentity = d.publicIdentity as { publicId?: string };
      }
      const st = parseTime(d.serverTime);
      if (st) this.serverTimeOffset = st - Date.now();
    }
  }

  /** 给 UI/日志用的安全快照（绝不含密码） */
  snapshot(): {
    email: string | null;
    hasCookie: boolean;
    hasCredentials: boolean;
    proofExpiresAt: number | null;
    frontendVersion: string;
    player: PlayerSnapshot | null;
    publicId: string | null;
  } {
    return {
      email: this.email || null,
      hasCookie: Boolean(this.cookie),
      hasCredentials: this.hasCredentials,
      proofExpiresAt: this.proofExpiresAt || null,
      frontendVersion: this.frontendVersion,
      player: this.player,
      publicId: this.publicIdentity?.publicId ?? null,
    };
  }
}

/* ---------- 辅助 ---------- */

function parseJsonLoose(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function pickErrorMessage(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as { error?: { message?: string }; message?: string };
  return d.error?.message ?? d.message ?? "";
}

function extractServerCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as { error?: { code?: string } };
  return d.error?.code;
}
