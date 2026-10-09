// 账号路由：/api/accounts/*
//
// 所有路由都要求「已审批 + 资源归属」，归属校验在 AccountService 里统一做，
// 越权返回 404 而不是 403（不泄漏资源是否存在）。
import { Router } from "express";
import { z } from "zod";
import type { AccountService } from "../../services/account-service.ts";
import type { RunnerRegistry } from "../../game/runner-registry.ts";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { body } from "../middleware/validate.ts";
import { clientIp } from "../../auth/ratelimit.ts";
import { AUDIT_ACTIONS, type AuditRepo } from "../../db/repositories/audit.ts";

const createSchema = z.object({
  label: z.string().max(60).optional(),
  authType: z.enum(["credentials", "cookie"]).optional(),
  email: z.string().max(200).optional(),
  password: z.string().max(200).optional(),
  cookie: z.string().max(4000).optional(),
  baseUrl: z.string().max(300).optional(),
  proxyId: z.string().max(64).nullish(),
  autoStart: z.boolean().optional(),
});

const updateSchema = z.object({
  label: z.string().max(60).optional(),
  email: z.string().max(200).optional(),
  password: z.string().max(200).optional(),
  cookie: z.string().max(4000).optional(),
  authType: z.enum(["credentials", "cookie"]).optional(),
  autoStart: z.boolean().optional(),
  proxyId: z.string().max(64).nullish(),
});

const modulePatchSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export function createAccountsRouter(deps: {
  accounts: AccountService;
  registry: RunnerRegistry;
  audit: AuditRepo;
}): Router {
  const router = Router();
  router.use(requireApproved);

  /* ---------- 列表 / 创建 ---------- */

  router.get("/", (req, res) => {
    const userId = currentUserId(req);
    res.json(deps.accounts.listForUser(userId));
  });

  router.post("/", body(createSchema), (req, res) => {
    const userId = currentUserId(req);
    const view = deps.accounts.create(userId, req.body);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_CREATED,
      target: view.id,
      detail: { label: view.label, authType: view.authType, proxyId: view.proxyId },
      ip: clientIp(req),
    });
    res.status(201).json(view);
  });

  /* ---------- 单个账号 ---------- */

  router.get("/:id", (req, res) => {
    res.json(deps.accounts.getForUser(req.params.id as string, currentUserId(req)));
  });

  router.patch("/:id", body(updateSchema), (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const view = deps.accounts.update(id, userId, req.body);
    deps.audit.record({
      userId,
      action:
        req.body.password !== undefined || req.body.cookie !== undefined
          ? AUDIT_ACTIONS.ACCOUNT_CREDENTIALS_UPDATED
          : AUDIT_ACTIONS.ACCOUNT_UPDATED,
      target: id,
      detail: { fields: Object.keys(req.body) },
      ip: clientIp(req),
    });
    res.json(view);
  });

  router.delete("/:id", async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    await deps.accounts.remove(id, userId);
    deps.audit.record({ userId, action: AUDIT_ACTIONS.ACCOUNT_DELETED, target: id, ip: clientIp(req) });
    res.json({ ok: true });
  });

  /* ---------- 启停 ---------- */

  router.post("/:id/start", async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const view = await deps.accounts.start(id, userId);
    deps.audit.record({ userId, action: AUDIT_ACTIONS.ACCOUNT_STARTED, target: id, ip: clientIp(req) });
    res.json(view);
  });

  router.post("/:id/stop", async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const view = await deps.accounts.stop(id, userId);
    deps.audit.record({ userId, action: AUDIT_ACTIONS.ACCOUNT_STOPPED, target: id, ip: clientIp(req) });
    res.json(view);
  });

  /* ---------- 模块（内置功能） ---------- */

  router.get("/:id/modules", (req, res) => {
    res.json(deps.accounts.moduleStates(req.params.id as string, currentUserId(req)));
  });

  router.patch("/:id/modules/:moduleId", body(modulePatchSchema), async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const moduleId = req.params.moduleId as string;
    const result = await deps.accounts.updateModule(id, userId, moduleId, req.body);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.MODULE_UPDATED,
      target: `${id}:${moduleId}`,
      detail: { enabled: req.body.enabled, keys: req.body.config ? Object.keys(req.body.config) : [] },
      ip: clientIp(req),
    });
    res.json(result);
  });

  router.post("/:id/modules/:moduleId/reset", async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const moduleId = req.params.moduleId as string;
    const states = await deps.accounts.resetModule(id, userId, moduleId);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.MODULE_UPDATED,
      target: `${id}:${moduleId}`,
      detail: { reset: true },
      ip: clientIp(req),
    });
    res.json({ states });
  });

  return router;
}
