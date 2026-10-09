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
import { currentUser, requireAdmin } from "../../auth/middleware.ts";
import { body, query } from "../middleware/validate.ts";
import { clientIp } from "../../auth/ratelimit.ts";
import { AUDIT_ACTIONS } from "../../db/repositories/audit.ts";
import type { Env } from "../../env.ts";

const statusSchema = z.object({ status: z.enum(["pending", "approved", "banned"]) });
const roleSchema = z.object({ role: z.enum(["user", "admin"]) });

const createUserSchema = z.object({
  email: z.string().email("邮箱格式不正确"),
  displayName: z.string().max(40).optional(),
  password: z.string().min(8, "口令至少 8 个字符").max(200).optional(),
  role: z.enum(["user", "admin"]).optional(),
});

const inviteCreateSchema = z.object({
  code: z.string().max(64).optional(),
  maxUses: z.number().int().min(1).max(1000).nullish(),
  /** 有效天数；null = 永不过期 */
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
  note: z.string().max(200).optional(),
});

const listUsersSchema = z.object({
  status: z.enum(["pending", "approved", "banned"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

const auditSchema = z.object({
  action: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

export function createAdminRouter(deps: {
  auth: AuthService;
  invites: InvitesRepo;
  audit: AuditRepo;
  repos: Repos;
  registry: RunnerRegistry;
  env: Pick<Env, "maxAccountsPerUser" | "maxRunningAccounts" | "allowRegistration" | "baseUrl" | "logRetentionDays">;
  version: string;
  startedAt: number;
}): Router {
  const router = Router();
  router.use(requireAdmin);

  /* ---------- 用户 ---------- */

  router.get("/users", query(listUsersSchema), (req, res) => {
    const q = res.locals.query as z.infer<typeof listUsersSchema>;
    const users = deps.auth.listUsers({
      ...(q.status ? { status: q.status } : {}),
      limit: q.limit ?? 100,
      offset: q.offset ?? 0,
    });
    res.json({
      users,
      counts: {
        total: deps.repos.users.countAll(),
        pending: deps.repos.users.countByStatus("pending"),
        approved: deps.repos.users.countByStatus("approved"),
        banned: deps.repos.users.countByStatus("banned"),
      },
    });
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

  /** 管理员直接建号（不走邀请码），返回一次性初始口令 */
  router.post("/users", body(createUserSchema), async (req, res) => {
    const admin = currentUser(req);
    const result = await deps.auth.createUserByAdmin({
      email: req.body.email,
      displayName: req.body.displayName ?? req.body.email,
      ...(req.body.password ? { password: req.body.password } : {}),
      ...(req.body.role ? { role: req.body.role } : {}),
      adminId: admin.id,
      ip: clientIp(req),
    });
    res.status(201).json(result);
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

  /* ---------- 审计 ---------- */

  router.get("/audit", query(auditSchema), (req, res) => {
    const q = res.locals.query as z.infer<typeof auditSchema>;
    res.json(
      deps.audit.list({
        ...(q.action ? { action: q.action } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
        limit: q.limit ?? 100,
        offset: q.offset ?? 0,
      }),
    );
  });

  return router;
}
