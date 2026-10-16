// CDK 公共库：提交验证 + 一键兑换
//
// 规则（与用户确认过）：
//  · 码是**按账号**可重复领的（一直能领）→ 库里保留，谁都能兑换；
//  · 提交前必须用**自己的账号**试领一次：无效 / 停用 / 超限 → 不入库；
//    领取成功 / 本账号已领取过 → 入库；还没到可兑奖时间 → 入库并标记「未开始」；
//  · 兑换时若发现已失效 → 自动把该码移出库（标记 exhausted，保留提交记录便于追查）；
//  · 重复提交：归一化后撞唯一约束 → 直接拒绝（不靠"先查后插"这种有竞态的写法）。
//
// 为什么逐个码试领而不是批量：批量接口只给 redeemedCount / invalidCount，
// 分不清"无效"与"没到时间"；一次一个才能拿到具体错误码（CDK_NOT_STARTED 等）。
import { HttpError } from "../api/server.ts";
import type { Repos, CdkRow, CdkStatus } from "../db/repositories/index.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { Logger } from "../lib/logger.ts";
import { GameClientError } from "../game/errors.ts";

/** 归一化：去空格与连字符后大写（`moyu 666` / `MOYU-666` / `moyu666` 视为同一个） */
export function normalizeCdk(raw: unknown): { normalized: string; display: string } | null {
  const display = String(raw ?? "").trim().toUpperCase();
  if (!display || display.length > 80) return null;
  // 控制字符一律拒绝（从表格/聊天记录里粘出来的东西经常带）
  for (const ch of display) {
    const code = ch.charCodeAt(0);
    if (code <= 31 || code === 127) return null;
  }
  const normalized = display.replace(/[\s-]+/g, "");
  // 游戏侧允许 字母 / 数字 / 下划线（活动码）；赞助码去掉连字符后也落在同一集合
  if (!/^[A-Z0-9_]+$/.test(normalized)) return null;
  return { normalized, display };
}

export type RedeemFailKind = "already" | "not-started" | "invalid" | "other";

/**
 * 把兑换失败翻译成可处理的类别。
 * 游戏侧的原始错误码见注释；未知一律按 other 处理（不入库 / 不移除）。
 */
export function classifyRedeemFailure(code: string | null | undefined, message: string): { kind: RedeemFailKind; text: string } {
  const c = String(code ?? "");
  if (c === "CDK_ALREADY_REDEEMED" || c === "SPONSORSHIP_CODE_REDEEMED") {
    return { kind: "already", text: "该账号已经领取过这个码" };
  }
  if (c === "CDK_NOT_STARTED") return { kind: "not-started", text: "这个码还没到可兑换时间" };
  if (
    c === "CDK_DISABLED" ||
    c === "CDK_EXPIRED" ||
    c === "CDK_USAGE_LIMIT_REACHED" ||
    c === "SPONSORSHIP_CODE_INVALID" ||
    c === "OPERATIONAL_CDK_EXPORT_UNAVAILABLE"
  ) {
    return { kind: "invalid", text: "这个码已失效" };
  }
  return { kind: "other", text: message || "兑换失败" };
}

/**
 * 读一次兑换的结果。
 *
 * ★ 为什么必须看响应内容：接口对"这个码你的账号已经领过"**不报错**，
 *   而是返回 200 + `redeemedCount: 0` —— 早期只看"请求没抛错"就当成成功，
 *   于是界面上显示"兑换成功"却没领到东西（用户反馈）。现在以「有没有 redemptions」为准。
 */
export function readRedeemOutcome(data: unknown, code: string): { ok: boolean; reward?: RewardSummary } {
  const d = (data ?? {}) as { redemptions?: unknown[]; redeemedCount?: unknown };
  const list = Array.isArray(d.redemptions) ? d.redemptions : [];
  const mine =
    list.find((r) => {
      const c = String((r as { code?: unknown } | null)?.code ?? "").toUpperCase();
      return !c || c === code.toUpperCase();
    }) ?? list[0];
  if (!mine) return { ok: false };
  return { ok: true, reward: summarizeRewards({ redemptions: [mine] }) };
}

/** 奖励摘要（兑换成功后实际到账的东西） */
export type RewardSummary = {
  gold?: number;
  relics?: number;
  fragments?: number;
  items?: number;
  chests?: number;
  /** 全服增益等其他奖励的可读说明 */
  notes?: string[];
};

/** 从一次兑换响应里抽出奖励摘要 */
export function summarizeRewards(data: unknown): RewardSummary | undefined {
  const first = (data as { redemptions?: unknown[] } | null)?.redemptions?.[0] as
    | { rewards?: Record<string, unknown>; globalBuff?: Record<string, unknown> }
    | undefined;
  if (!first) return undefined;
  const r = (first.rewards ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) && x !== 0 ? x : undefined;
  };
  const out: RewardSummary = {
    ...(n(r.gold) !== undefined ? { gold: n(r.gold) } : {}),
    ...(n(r.relics) !== undefined ? { relics: n(r.relics) } : {}),
    ...(n(r.fragments) !== undefined ? { fragments: n(r.fragments) } : {}),
    ...(n(r.itemQuantity) !== undefined ? { items: n(r.itemQuantity) } : {}),
    ...(n(r.chestQuantity) !== undefined ? { chests: n(r.chestQuantity) } : {}),
  };
  if (first.globalBuff) out.notes = ["获得全服增益"];
  if (r.dualRodEarlyAccessGranted === true) out.notes = [...(out.notes ?? []), "解锁双竿"];
  return Object.keys(out).length ? out : undefined;
}

export type CdkView = {
  id: string;
  /** 自己的提交给完整码；别人的打码（避免绕开页面直接用） */
  code: string;
  masked: boolean;
  status: CdkStatus;
  reward: RewardSummary | null;
  submittedBy: string;
  mine: boolean;
  successCount: number;
  lastError: string | null;
  submittedAt: number;
};

export type SubmitOutcome = {
  input: string;
  ok: boolean;
  status?: CdkStatus;
  reward?: RewardSummary;
  reason?: string;
  id?: string;
};

/** 后台码库的一行：不打码，并且带提交人的可读名字 */
export type AdminCdkItem = {
  id: string;
  code: string;
  status: CdkStatus;
  reward: RewardSummary | null;
  submittedBy: string;
  /** 「显示名（邮箱）」；提交人已被删除时退回 id */
  submitter: string;
  accountId: string | null;
  successCount: number;
  lastError: string | null;
  submittedAt: number;
  lastRedeemedAt: number | null;
};

export type ClaimOutcome =
  | { ok: true; reward?: RewardSummary; already?: boolean }
  | { ok: false; reason: string; removed?: boolean; already?: boolean };

const maskCode = (code: string): string => {
  if (code.length <= 4) return `${code.slice(0, 1)}***`;
  return `${code.slice(0, 4)}${"*".repeat(Math.min(8, Math.max(3, code.length - 4)))}`;
};

export type CdkServiceDeps = {
  repos: Repos;
  registry: RunnerRegistry;
  logger: Logger;
};

export class CdkService {
  private readonly deps: CdkServiceDeps;

  constructor(deps: CdkServiceDeps) {
    this.deps = deps;
  }

  /* ---------------- 读 ---------------- */

  list(
    userId: string,
    opts: { status?: CdkStatus | "all"; search?: string; mineOnly?: boolean; limit?: number; offset?: number } = {},
  ): { items: CdkView[]; counts: Record<CdkStatus, number>; total: number } {
    const filter = {
      status: opts.status ?? "all",
      ...(opts.search?.trim() ? { search: opts.search.trim() } : {}),
      ...(opts.mineOnly ? { submittedBy: userId } : {}),
    };
    const rows = this.deps.repos.cdk.list({ ...filter, limit: opts.limit ?? 50, offset: opts.offset ?? 0 });
    return {
      items: rows.map((row) => this.toView(row, userId)),
      counts: this.deps.repos.cdk.countByStatus(),
      total: this.deps.repos.cdk.count(filter),
    };
  }

  private toView(row: CdkRow, userId: string): CdkView {
    const mine = row.submitted_by === userId;
    let reward: RewardSummary | null = null;
    if (row.reward_json) {
      try {
        reward = JSON.parse(row.reward_json) as RewardSummary;
      } catch {
        reward = null;
      }
    }
    return {
      id: row.id,
      code: mine ? row.code : maskCode(row.code),
      masked: !mine,
      status: row.status,
      reward,
      submittedBy: row.submitted_by,
      mine,
      successCount: Number(row.success_count) || 0,
      lastError: row.last_error,
      submittedAt: Number(row.submitted_at),
    };
  }

  /* ---------------- 提交 ---------------- */

  /**
   * 提交码（逐个验证）。返回每个输入的结论，调用方直接把结论展示给用户。
   * 只要有一个码通过了验证就会入库；没通过的会说明原因（不静默丢弃）。
   */
  async submit(userId: string, accountId: string, rawCodes: unknown[]): Promise<SubmitOutcome[]> {
    this.requireOwnAccount(userId, accountId);
    const rt = this.deps.registry.require(accountId);
    const out: SubmitOutcome[] = [];

    for (const raw of rawCodes.slice(0, 50)) {
      const input = String(raw ?? "").trim();
      if (!input) continue;
      const norm = normalizeCdk(input);
      if (!norm) {
        out.push({ input, ok: false, reason: "格式不对（只允许字母、数字、连字符与下划线）" });
        continue;
      }
      if (this.deps.repos.cdk.existsNormalized(norm.normalized)) {
        out.push({ input, ok: false, reason: "库里已经有这个码了" });
        continue;
      }

      try {
        const data = await rt.redeemCdks([norm.display]);
        const outcome = readRedeemOutcome(data, norm.display);
        // ★ 200 但没有 redemptions：「这个账号已经领过」是接口的常见返回（不报错）
        const reward = outcome.reward;
        const row = this.insertWithRetry({
          code: norm.display,
          normalized: norm.normalized,
          status: "available",
          reward,
          submittedBy: userId,
          accountId,
          alreadyRedeemed: true,
          ...(outcome.ok ? {} : { lastError: "你的账号已经领过这个码" }),
        });
        if (!row) {
          out.push({ input, ok: false, reason: "库里已经有这个码了" });
          continue;
        }
        out.push(
          outcome.ok
            ? { input, ok: true, status: "available", reward, id: row.id }
            : { input, ok: true, status: "available", id: row.id, reason: "你的账号已经领过，仍已入库供他人兑换" },
        );
      } catch (err) {
        const { code, message } = describeErr(err);
        const kind = classifyRedeemFailure(code, message);
        if (kind.kind === "already") {
          // 本账号已领过 → 码有效，入库
          const row = this.insertWithRetry({
            code: norm.display,
            normalized: norm.normalized,
            status: "available",
            submittedBy: userId,
            accountId,
            lastError: kind.text,
            alreadyRedeemed: true,
          });
          out.push(
            row
              ? { input, ok: true, status: "available", id: row.id, reason: "你已领取过，仍已入库供他人兑换" }
              : { input, ok: false, reason: "库里已经有这个码了" },
          );
          continue;
        }
        if (kind.kind === "not-started") {
          const row = this.insertWithRetry({
            code: norm.display,
            normalized: norm.normalized,
            status: "not_started",
            submittedBy: userId,
            accountId,
            lastError: kind.text,
          });
          out.push(
            row
              ? { input, ok: true, status: "not_started", id: row.id, reason: "还没到可兑换时间，已入库标记「未开始」" }
              : { input, ok: false, reason: "库里已经有这个码了" },
          );
          continue;
        }
        // 无效 / 停用 / 超限 / 其它 → 不入库
        out.push({ input, ok: false, reason: kind.text });
      }
    }
    return out;
  }

  /** 插入；撞唯一键（并发提交同一个码）时返回 null，由调用方提示"库里已有" */
  private insertWithRetry(input: Parameters<Repos["cdk"]["insert"]>[0]): CdkRow | null {
    try {
      return this.deps.repos.cdk.insert(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg)) return null;
      throw err;
    }
  }

  /* ---------------- 兑换 ---------------- */

  /**
   * 一键兑换。
   *
   * 码是按账号可重复领的，所以**不需要占位锁**：不同用户各自兑换互不影响。
   * 只有"这个码对当前账号已失效"时才动库：直接标记为 exhausted（自动移出列表）。
   */
  async claim(userId: string, accountId: string, id: string): Promise<ClaimOutcome> {
    this.requireOwnAccount(userId, accountId);
    const row = this.deps.repos.cdk.findById(id);
    if (!row) throw new HttpError(404, "CDK_NOT_FOUND", "这个码不在库里（可能已被移除）");
    if (row.status === "exhausted") return { ok: false, reason: row.last_error || "这个码已失效" };

    const rt = this.deps.registry.require(accountId);
    try {
      const data = await rt.redeemCdks([row.code]);
      const outcome = readRedeemOutcome(data, row.code);
      if (!outcome.ok) {
        // ★ 200 但没领到：接口对「本账号已领过」不报错。不能算成功（早期这里谎报成功），
        //   也不要动库 —— 这个码对别人可能仍然有效。
        return { ok: false, already: true, reason: "你的账号已经领过这个码了" };
      }
      this.deps.repos.cdk.markRedeemed(id, userId, outcome.reward);
      // 「未开始」的码现在领到了 → 状态回到可用
      if (row.status === "not_started") this.deps.repos.cdk.markStatus(id, "available", null);
      this.deps.logger.info("CDK", `兑换成功：${row.code}（账号 ${accountId}）`);
      return { ok: true, reward: outcome.reward };
    } catch (err) {
      const { code, message } = describeErr(err);
      const kind = classifyRedeemFailure(code, message);
      if (kind.kind === "already") {
        // 该账号已领过：码本身有效，保留在库里给其他人
        this.deps.repos.cdk.markStatus(id, row.status === "not_started" ? "not_started" : "available", kind.text);
        return { ok: false, already: true, reason: "你的账号已经领过这个码了" };
      }
      if (kind.kind === "not-started") {
        this.deps.repos.cdk.markStatus(id, "not_started", kind.text);
        return { ok: false, reason: kind.text };
      }
      if (kind.kind === "invalid") {
        // ★ 兑换时发现失效 → 自动移出库（按用户要求）
        this.deps.repos.cdk.markExhausted(id, kind.text);
        this.deps.logger.info("CDK", `码已失效并移出库：${row.code}（${kind.text}）`);
        return { ok: false, reason: `${kind.text}，已自动从库中移除`, removed: true };
      }
      return { ok: false, reason: kind.text };
    }
  }

  /** 删除自己提交的码 */
  remove(userId: string, id: string): boolean {
    return this.deps.repos.cdk.deleteOwned(id, userId);
  }

  /* ---------------- 后台（管理员） ---------------- */

  /**
   * 后台码库列表：**不打码**，并且把提交人解析成可读的人（邮箱 / 显示名）。
   *
   * 与用户页的区别只有这两点：用户看别人的码是打码的，管理员要能直接复制 / 核对。
   */
  adminList(
    opts: { status?: CdkStatus | "all"; search?: string; limit?: number; offset?: number } = {},
  ): { items: AdminCdkItem[]; counts: Record<CdkStatus, number>; total: number } {
    const filter = {
      status: opts.status ?? "all",
      ...(opts.search?.trim() ? { search: opts.search.trim() } : {}),
    };
    const rows = this.deps.repos.cdk.list({ ...filter, limit: opts.limit ?? 50, offset: opts.offset ?? 0 });
    return {
      items: rows.map((row) => this.toAdminItem(row)),
      counts: this.deps.repos.cdk.countByStatus(),
      total: this.deps.repos.cdk.count(filter),
    };
  }

  /**
   * 管理员手动添加码：**不试领验证**，直接入库（状态默认「可用」）。
   *
   * 为什么不做验证：管理员通常是从别处整批拿到的码，一个个试领既慢又会把码先领掉一份；
   * 真无效的码会在有人兑换时被自动标成「已失效」并移出列表（见 claim）。
   * 重复的码（归一化后同一个）会被跳过并说明，不会覆盖已有记录。
   */
  adminAdd(
    adminUserId: string,
    rawCodes: unknown[],
  ): { input: string; ok: boolean; reason?: string; id?: string }[] {
    const out: { input: string; ok: boolean; reason?: string; id?: string }[] = [];
    for (const raw of rawCodes.slice(0, 50)) {
      const input = String(raw ?? "").trim();
      if (!input) continue;
      const norm = normalizeCdk(input);
      if (!norm) {
        out.push({ input, ok: false, reason: "格式不对（只允许字母、数字、连字符与下划线）" });
        continue;
      }
      if (this.deps.repos.cdk.existsNormalized(norm.normalized)) {
        out.push({ input, ok: false, reason: "库里已经有这个码了" });
        continue;
      }
      const row = this.insertWithRetry({
        code: norm.display,
        normalized: norm.normalized,
        status: "available",
        submittedBy: adminUserId,
      });
      if (!row) {
        out.push({ input, ok: false, reason: "库里已经有这个码了" });
        continue;
      }
      out.push({ input, ok: true, id: row.id });
    }
    return out;
  }

  /** 管理员删除任意码（不限提交人） */
  adminDelete(id: string): { ok: boolean; code: string | null } {
    const row = this.deps.repos.cdk.findById(id);
    if (!row) return { ok: false, code: null };
    return { ok: this.deps.repos.cdk.deleteById(id), code: row.code };
  }

  private toAdminItem(row: CdkRow): AdminCdkItem {
    let reward: RewardSummary | null = null;
    if (row.reward_json) {
      try {
        reward = JSON.parse(row.reward_json) as RewardSummary;
      } catch {
        reward = null;
      }
    }
    const submitter = this.deps.repos.users.findById(row.submitted_by);
    return {
      id: row.id,
      code: row.code,
      status: row.status,
      reward,
      submittedBy: row.submitted_by,
      submitter: submitter ? `${submitter.display_name}（${submitter.email}）` : row.submitted_by,
      accountId: row.account_id,
      successCount: Number(row.success_count) || 0,
      lastError: row.last_error,
      submittedAt: Number(row.submitted_at),
      lastRedeemedAt: row.last_redeemed_at === null ? null : Number(row.last_redeemed_at),
    };
  }

  /**
   * 一键领取：把库里所有「可兑换」的码依次领一遍（每账号一次，领过的会跳过）。
   *
   * 一次最多处理 50 个，避免一个请求打太多游戏接口；结果汇总返回，逐条附带结论。
   */
  async claimAll(userId: string, accountId: string): Promise<{ ok: number; already: number; removed: number; failed: number }> {
    this.requireOwnAccount(userId, accountId);
    const rows = this.deps.repos.cdk.list({ status: "available", limit: 50 });
    const summary = { ok: 0, already: 0, removed: 0, failed: 0 };
    for (const row of rows) {
      const r = await this.claim(userId, accountId, row.id);
      if (r.ok) summary.ok++;
      else if (r.removed) summary.removed++;
      else if (r.already) summary.already++;
      else summary.failed++;
    }
    return summary;
  }

  /* ---------------- 辅助 ---------------- */

  private requireOwnAccount(userId: string, accountId: string): void {
    const row = this.deps.repos.accounts.findById(accountId);
    if (!row || row.user_id !== userId) {
      throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在或不属于你");
    }
  }
}

function describeErr(err: unknown): { code: string | null; message: string } {
  if (err instanceof GameClientError) return { code: err.code ?? null, message: err.message };
  return { code: null, message: err instanceof Error ? err.message : String(err) };
}
