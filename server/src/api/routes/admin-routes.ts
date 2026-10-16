// 管理路由：/api/admin/*
//
// 全部要求 role === "admin"。涉及管理员自身的操作有保护（不能自我降级/封禁，
// 不能把最后一个管理员移除），避免把自己锁在门外。
import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../../auth/service.ts";
import type { InvitesRepo } from "../../db/repositories/invites.ts";
import type { AuditRepo } from "../../db/repositories/audit.ts";
import type { Repos } from "../../db/repositories/index.ts";
import type { RunnerRegistry } from "../../game/runner-registry.ts";
import type { UpdateService } from "../../services/update-service.ts";
import type { SettingsService } from "../../services/settings-service.ts";
import type { CdkService } from "../../services/cdk-service.ts";
import { currentUser, requireAdmin } from "../../auth/middleware.ts";
import { body, query } from "../middleware/validate.ts";
import { clientIp, Limiters } from "../../auth/ratelimit.ts";
import { AUDIT_ACTIONS } from "../../db/repositories/audit.ts";
import { HttpError } from "../server.ts";
import { describeAudit } from "../../lib/audit-text.ts";
import { redactLogRow } from "../../lib/log-redact.ts";
import { getModule } from "../../modules/registry.ts";
import type { Env } from "../../env.ts";

const statusSchema = z.object({ status: z.enum(["pending", "approved", "banned"]) });
const roleSchema = z.object({ role: z.enum(["user", "admin"]) });

/** 管理员重置口令：长度下限与注册保持一致（8） */
const resetPasswordSchema = z.object({ password: z.string().min(8).max(200) });

const createUserSchema = z.object({
  /** 登录标识：用户名或邮箱（与自助注册同口径） */
  username: z.string().min(3, "用户名至少 3 个字符").max(32, "用户名最多 32 个字符"),
  displayName: z.string().max(40).optional(),
  password: z.string().min(8, "口令至少 8 个字符").max(200).optional(),
  role: z.enum(["user", "admin"]).optional(),
});

/** 管理员编辑用户：显示名、单独额度 */
const editUserSchema = z.object({
  displayName: z.string().min(1, "显示名不能为空").max(40).optional(),
  /** 数字 = 单独设置；null = 跟随全局默认 */
  quotaOverride: z.number().int().min(1).max(100).nullable().optional(),
});

/** 后台设置保存：键值由 SettingsService 自己校验 */
const settingsUpdateSchema = z.object({ patch: z.record(z.string(), z.unknown()) });

const inviteCreateSchema = z.object({
  code: z.string().max(64).optional(),
  maxUses: z.number().int().min(1).max(1000).nullish(),
  /** 有效天数；null = 永不过期 */
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
  note: z.string().max(200).optional(),
});

const listUsersSchema = z.object({
  status: z.enum(["pending", "approved", "banned"]).optional(),
  role: z.enum(["user", "admin"]).optional(),
  /** 搜索词：匹配用户名或显示名 */
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

/** 批量操作：一次对多个用户做同一件事 */
const bulkUsersSchema = z.object({
  userIds: z.array(z.string().min(1).max(64)).min(1, "至少选择一个用户").max(200, "一次最多 200 个"),
  action: z.enum(["ban", "unban", "promote", "demote"]),
});

const auditSchema = z.object({
  action: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

const adminCdkListSchema = z.object({
  status: z.enum(["all", "available", "not_started", "exhausted"]).optional(),
  search: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

const adminCdkAddSchema = z.object({
  codes: z.array(z.string().min(1).max(80)).min(1, "至少填一个码").max(50, "一次最多 50 个"),
});

export function createAdminRouter(deps: {
  auth: AuthService;
  invites: InvitesRepo;
  audit: AuditRepo;
  repos: Repos;
  registry: RunnerRegistry;
  cdk: CdkService;
  update: UpdateService;
  settings: SettingsService;
  limiters: Limiters;
  env: Pick<Env, "maxAccountsPerUser" | "maxRunningAccounts" | "allowRegistration" | "baseUrl" | "logRetentionDays">;
  version: string;
  startedAt: number;
}): Router {
  const router = Router();
  router.use(requireAdmin);

  /* ---------- 用户 ---------- */

  router.get("/users", query(listUsersSchema), (req, res) => {
    const q = res.locals.query as z.infer<typeof listUsersSchema>;
    const filter = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.role ? { role: q.role } : {}),
      ...(q.q?.trim() ? { q: q.q.trim() } : {}),
    };
    const users = deps.auth.listUsers({ ...filter, limit: q.limit ?? 100, offset: q.offset ?? 0 });
    res.json({
      users,
      /** 当前筛选条件下的总数（前端分页用） */
      filtered: deps.auth.countUsers(filter),
      counts: {
        total: deps.repos.users.countAll(),
        pending: deps.repos.users.countByStatus("pending"),
        approved: deps.repos.users.countByStatus("approved"),
        banned: deps.repos.users.countByStatus("banned"),
        // 供概览直接展示：不能靠分页返回的 ≤100 行去数（会静默少算）
        admins: deps.repos.users.countAdmins(),
        activeRecently: deps.repos.users.countActiveSince(Date.now() - 7 * 86_400_000),
      },
    });
  });

  /** 批量操作：封禁 / 解封 / 提升 / 降级。单条失败不影响其余 */
  router.post("/users/bulk", body(bulkUsersSchema), (req, res) => {
    const admin = currentUser(req);
    const result = deps.auth.bulkUpdate({
      userIds: req.body.userIds,
      action: req.body.action,
      adminId: admin.id,
      ip: clientIp(req),
    });
    deps.audit.record({
      userId: admin.id,
      action: "admin.users.bulk",
      target: req.body.action,
      detail: { updated: result.updated.length, failed: result.failed.length },
      ip: clientIp(req),
    });
    // ★ 批量封禁也要立刻停机：账号由 RunnerRegistry 驱动、与登录态无关，
    //   不停的话被封禁的人继续挂机、继续占用全局并发额度。
    //   单条改状态的接口一直有这一步，批量操作漏了。
    if (req.body.action === "ban") {
      for (const userId of result.updated) {
        void deps.registry.stopAllForUser(userId);
      }
    }
    res.json(result);
  });

  router.post("/users/:id/approve", (req, res) => {
    const admin = currentUser(req);
    const user = deps.auth.approve(req.params.id as string, admin.id, clientIp(req));
    res.json({ user });
  });

  router.post("/users/:id/reject", (req, res) => {
    const admin = currentUser(req);
    const user = deps.auth.reject(req.params.id as string, admin.id, clientIp(req));
    res.json({ user });
  });

  router.patch("/users/:id/status", body(statusSchema), (req, res) => {
    const admin = currentUser(req);
    const user = deps.auth.setUserStatus(req.params.id as string, req.body.status, admin.id, clientIp(req));
    // 被封禁的用户：停掉他的全部账号，别让引擎继续替他挂机
    if (req.body.status !== "approved") {
      void deps.registry.stopAllForUser(user.id);
    }
    res.json({ user });
  });

  router.patch("/users/:id/role", body(roleSchema), (req, res) => {
    const admin = currentUser(req);
    const user = deps.auth.setUserRole(req.params.id as string, req.body.role, admin.id, clientIp(req));
    res.json({ user });
  });

  /**
   * 编辑用户：显示名、单独额度。
   * 角色与状态仍是各自的接口（那边有「不能封最后一个管理员」这类约束）。
   */
  router.patch("/users/:id", body(editUserSchema), (req, res) => {
    const admin = currentUser(req);
    const user = deps.auth.adminUpdateUser(req.params.id as string, req.body, admin.id, clientIp(req));
    res.json({ user });
  });

  /** 管理员直接建号（不走邀请码），返回一次性初始口令 */
  router.post("/users", body(createUserSchema), async (req, res) => {
    const admin = currentUser(req);
    const result = await deps.auth.createUserByAdmin({
      username: req.body.username,
      ...(req.body.displayName ? { displayName: req.body.displayName } : {}),
      ...(req.body.password ? { password: req.body.password } : {}),
      ...(req.body.role ? { role: req.body.role } : {}),
      adminId: admin.id,
      ip: clientIp(req),
    });
    res.status(201).json(result);
  });

  /**
   * 管理员重置任意用户的口令（含自己）。
   *
   * 为什么要「管理员可改」：部署时生成的随机初始口令只出现过一次，
   * 机主改完忘了就得有找回途径，否则只能去删数据库。
   * 重置后该用户的所有登录态失效（防止旧会话继续可用）。
   */
  router.post("/users/:id/password", body(resetPasswordSchema), async (req, res) => {
    const admin = currentUser(req);
    const targetId = req.params.id as string;
    await deps.auth.resetUserPassword(targetId, req.body.password);
    deps.audit.record({
      userId: admin.id,
      action: "admin.user.password_reset",
      target: targetId,
      ip: clientIp(req),
    });
    res.json({ ok: true });
  });

  /* ---------- 邀请码 ---------- */

  router.get("/invites", (_req, res) => {
    res.json(deps.invites.list());
  });

  router.post("/invites", body(inviteCreateSchema), (req, res) => {
    const admin = currentUser(req);
    const invite = deps.invites.create({
      ...(req.body.code ? { code: req.body.code } : {}),
      maxUses: req.body.maxUses ?? null,
      expiresAt: req.body.expiresInDays ? Date.now() + req.body.expiresInDays * 86_400_000 : null,
      createdBy: admin.id,
      ...(req.body.note ? { note: req.body.note } : {}),
    });
    deps.audit.record({
      userId: admin.id,
      action: AUDIT_ACTIONS.INVITE_CREATED,
      target: invite.id,
      detail: { code: invite.code, maxUses: invite.max_uses },
      ip: clientIp(req),
    });
    res.status(201).json(invite);
  });

  router.delete("/invites/:id", (req, res) => {
    const admin = currentUser(req);
    const id = req.params.id as string;
    const ok = deps.invites.delete(id);
    if (!ok) {
      res.status(404).json({ error: { code: "INVITE_NOT_FOUND", message: "邀请码不存在" } });
      return;
    }
    deps.audit.record({ userId: admin.id, action: AUDIT_ACTIONS.INVITE_DELETED, target: id, ip: clientIp(req) });
    res.json({ ok: true });
  });

  /* ---------- CDK 码库 ---------- */

  /** 码库列表：不打码（管理员要能核对 / 复制），带提交人、提交时间、成功次数与最近错误 */
  router.get("/cdk", query(adminCdkListSchema), (req, res) => {
    const q = res.locals.query as z.infer<typeof adminCdkListSchema>;
    res.json(
      deps.cdk.adminList({
        status: q.status ?? "all",
        ...(q.search ? { search: q.search } : {}),
        limit: q.limit ?? 50,
        offset: q.offset ?? 0,
      }),
    );
  });

  /** 手动加码：一次最多 50 条，逐条返回结论（重复的会跳过并说明） */
  router.post("/cdk", body(adminCdkAddSchema), (req, res) => {
    const admin = currentUser(req);
    const results = deps.cdk.adminAdd(admin.id, req.body.codes);
    const added = results.filter((r) => r.ok);
    if (added.length) {
      deps.audit.record({
        userId: admin.id,
        action: AUDIT_ACTIONS.ADMIN_CDK_ADDED,
        target: null,
        detail: { count: added.length, sample: added[0]?.input ?? null },
        ip: clientIp(req),
      });
    }
    res.json({ results });
  });

  /** 删除任意码（不限提交人） */
  router.delete("/cdk/:id", (req, res) => {
    const admin = currentUser(req);
    const id = req.params.id as string;
    const removed = deps.cdk.adminDelete(id);
    if (!removed.ok) {
      res.status(404).json({ error: { code: "CDK_NOT_FOUND", message: "这个码不在库里（可能已被移除）" } });
      return;
    }
    deps.audit.record({
      userId: admin.id,
      action: AUDIT_ACTIONS.ADMIN_CDK_DELETED,
      target: id,
      detail: { code: removed.code },
      ip: clientIp(req),
    });
    res.json({ ok: true });
  });

  /* ---------- 系统信息 ---------- */

  router.get("/system", (_req, res) => {
    const capacity = deps.registry.capacity;
    res.json({
      version: deps.version,
      startedAt: deps.startedAt,
      uptime: Date.now() - deps.startedAt,
      baseUrl: deps.env.baseUrl,
      limits: {
        maxAccountsPerUser: deps.env.maxAccountsPerUser,
        maxRunningAccounts: deps.env.maxRunningAccounts,
        allowRegistration: deps.env.allowRegistration,
        logRetentionDays: deps.env.logRetentionDays,
      },
      runtime: {
        runningAccounts: capacity.running,
        capacity: capacity.max,
        available: capacity.available,
        totalAccounts: deps.repos.accounts.listAll().length,
      },
      storage: {
        logs: deps.repos.logs.countAll(),
        auditEvents: deps.audit.countAll(),
      },
    });
  });

  /* ---------- 后台设置（在线修改，立即生效） ---------- */

  router.get("/settings", (_req, res) => {
    res.json({ items: deps.settings.describe() });
  });

  router.patch("/settings", body(settingsUpdateSchema), (req, res) => {
    const admin = currentUser(req);
    let changed: string[];
    try {
      changed = deps.settings.update(req.body.patch, admin.id);
    } catch (err) {
      throw new HttpError(400, "INVALID_SETTING", err instanceof Error ? err.message : String(err));
    }
    deps.audit.record({
      userId: admin.id,
      action: "admin.settings.updated",
      target: "settings",
      detail: { changed },
      ip: clientIp(req),
    });
    res.json({ changed, items: deps.settings.describe() });
  });

  /* ---------- 审计 ---------- */

  router.get("/audit", query(auditSchema), (req, res) => {
    const q = res.locals.query as z.infer<typeof auditSchema>;
    const rows = deps.audit.list({
      ...(q.action ? { action: q.action } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      limit: q.limit ?? 100,
      offset: q.offset ?? 0,
    });

    // ★ 顺带把每条记录翻译成人话：账号标签 / 功能名 / 用户显示名只有服务端拿得到。
    //   前端此前自己维护映射表，键名与 AUDIT_ACTIONS 对不上，界面上大多显示成
    //   account.module.updated 这类原始码。
    const accountLabels = new Map<string, string | null>();
    const accountLabel = (id: string): string | null => {
      if (!accountLabels.has(id)) accountLabels.set(id, deps.repos.accounts.findById(id)?.label ?? null);
      return accountLabels.get(id) ?? null;
    };
    const userNames = new Map<string, string | null>();
    const userName = (id: string): string | null => {
      if (!userNames.has(id)) {
        const u = deps.repos.users.findById(id);
        userNames.set(id, u ? u.display_name || u.email : null);
      }
      return userNames.get(id) ?? null;
    };

    res.json(
      rows.map((row) => ({
        ...row,
        text: describeAudit(row, { accountLabel, moduleName: (id) => getModule(id)?.name ?? null, userName }),
      })),
    );
  });

  /* ---------- 运行日志（跨用户 + 脱敏） ---------- */

  const adminLogsSchema = z.object({
    userId: z.string().max(64).optional(),
    accountId: z.string().max(64).optional(),
    moduleId: z.string().max(64).optional(),
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    search: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    offset: z.coerce.number().int().min(0).max(100000).optional(),
  });

  /**
   * 管理员日志页：看**所有人**的运行日志（最新在最前）。
   *
   * ★ 用 `queryAll`（不叠加 user_id 约束）—— 这个调用点是它唯一允许出现的地方。
   * ★ 返回前一律过 `redactLogRow`：密码 / token / cookie / 签名 / 邮箱会被遮掉，
   *   但错误原文、出口 IP、`host:port`、模块与地图 id 都保留（否则排查就没意义）。
   *   数据源是数据库（每人保留策略见 settings.logRetentionDays），落库有秒级延迟。
   */
  router.get("/logs", query(adminLogsSchema), (req, res) => {
    const q = res.locals.query as z.infer<typeof adminLogsSchema>;
    const rows = deps.repos.logs.queryAll({
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.accountId ? { accountId: q.accountId } : {}),
      ...(q.moduleId ? { moduleId: q.moduleId } : {}),
      ...(q.level ? { minLevel: q.level } : {}),
      ...(q.search?.trim() ? { search: q.search.trim() } : {}),
      limit: q.limit ?? 200,
      offset: q.offset ?? 0,
    });
    res.json({
      // 仓储返回「新 → 旧」，页面就是最新在最上面，不需要再反转
      entries: rows.map(redactLogRow),
      totalInDb: deps.repos.logs.countAll(),
    });
  });

  /* ---------- 在线更新 ---------- */

  /** 检查是否有新版本（对比当前提交与远端最新提交） */
  router.get("/update/check", async (_req, res) => {
    res.json(await deps.update.check());
  });

  /** 更新进度（前端轮询显示） */
  router.get("/update/status", async (_req, res) => {
    res.json(await deps.update.status());
  });

  /**
   * 应用更新。
   * 有 updater 时让它去重建容器；否则按 allowLocalUpdate 决定是否本地 git pull。
   * 限流：更新会重启服务，不能连点。
   */
  router.post("/update/apply", async (req, res) => {
    const admin = currentUser(req);
    const rl = deps.limiters.updateApply.hit(`update:${admin.id}`);
    if (!rl.allowed) {
      throw new HttpError(429, "RATE_LIMITED", `更新操作过于频繁，请 ${Math.ceil(rl.retryAfterMs / 60000)} 分钟后再试。`);
    }

    const result = await deps.update.apply({ reason: `admin ${admin.email} 手动触发` });
    deps.audit.record({
      userId: admin.id,
      action: "admin.update.applied",
      target: "update",
      detail: { ok: result.ok, restarting: result.restarting },
      ip: clientIp(req),
    });
    res.json(result);
  });

  return router;
}
