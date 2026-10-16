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

const travelSchema = z.object({
  biomeId: z.string().min(1).max(80),
  /** solo = 只自己过去；party = 把整条船开过去（需船长 / 舵手权限） */
  mode: z.enum(["solo", "party"]).default("solo"),
});

const partyJoinSchema = z.object({
  /** 船队邀请码（游戏里的「加入船队」用同一个码） */
  code: z.string().trim().min(1).max(40),
});

const partyInvitationSchema = z.object({
  action: z.enum(["accept", "reject"]),
});

const partyMemberSchema = z.object({
  /** remove = 移出船队；role = 任命/撤销舵手；captain = 转让船长 */
  action: z.enum(["remove", "role", "captain"]),
  /** action = role 时必填 */
  role: z.enum(["helmsman", "crew"]).optional(),
});

const barterSpecSchema = z.object({
  /** 地图 id（b_002） */
  biomeId: z.string().min(1).max(80),
  /** 稀有度：以物易物只支持神话 / 奇异 / 奥秘（服务端还会再校验一次） */
  rarity: z.string().min(1).max(20),
});

const barterTaskSchema = z.object({
  /** 起点侧：这些地图上的任意同稀有度鱼都可以拿去换（1~5 项） */
  fromSpecs: z.array(barterSpecSchema).min(1).max(5),
  /** 目标侧：换到其中任意一种都算达成（1~5 项） */
  targetSpecs: z.array(barterSpecSchema).min(1).max(5),
  /** 想换到几条 */
  quantity: z.number().int().min(1).max(99),
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

  /* ---------- 地图与天气 / 手动换图 ---------- */

  /** 面板数据：全部地图（天气、鱼价值、比赛标记、解锁信息）+ 当前地图 + 船队状态 */
  router.get("/:id/maps", async (req, res) => {
    res.json(await deps.accounts.maps(req.params.id as string, currentUserId(req)));
  });

  /** 手动切换地图（个人换图 / 带队换图） */
  router.post("/:id/travel", body(travelSchema), async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const result = await deps.accounts.travel(id, userId, req.body);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_TRAVEL,
      target: id,
      detail: { biomeId: result.biomeId, mapName: result.name, mode: result.mode },
      ip: clientIp(req),
    });
    res.json(result);
  });

  /* ---------- 船队（组队） ---------- */

  /** 船队状态 + 待处理邀请 */
  router.get("/:id/party", async (req, res) => {
    res.json(await deps.accounts.party(req.params.id as string, currentUserId(req)));
  });

  /** 用邀请码加入船队 */
  router.post("/:id/party/join", body(partyJoinSchema), async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const result = await deps.accounts.joinParty(id, userId, req.body.code);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_PARTY_JOIN,
      target: id,
      detail: { by: "code" },
      ip: clientIp(req),
    });
    res.json(result);
  });

  /** 离开船队 */
  router.post("/:id/party/leave", async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const result = await deps.accounts.leaveParty(id, userId);
    deps.audit.record({ userId, action: AUDIT_ACTIONS.ACCOUNT_PARTY_LEAVE, target: id, ip: clientIp(req) });
    res.json(result);
  });

  /** 接受 / 拒绝一条组队邀请 */
  router.post("/:id/party/invitations/:invitationId", body(partyInvitationSchema), async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const result = await deps.accounts.respondPartyInvitation(
      id,
      userId,
      req.params.invitationId as string,
      req.body.action,
    );
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_PARTY_INVITATION,
      target: id,
      detail: { action: req.body.action },
      ip: clientIp(req),
    });
    res.json(result);
  });

  /* ---------- 船队成员管理（仅船长） ---------- */

  router.post("/:id/party/members/:publicId", body(partyMemberSchema), async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const publicId = req.params.publicId as string;
    const result = await deps.accounts.managePartyMember(id, userId, publicId, req.body.action, req.body.role);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_PARTY_MEMBER,
      target: id,
      detail: { action: result.action, member: publicId },
      ip: clientIp(req),
    });
    res.json(result);
  });

  /* ---------- 以物易物（交换任务） ---------- */

  /** 交换任务面板：队列 + 可作为起点的鱼 + 目标鱼候选 + 队首任务的路径预览 */
  router.get("/:id/barter", async (req, res) => {
    res.json(await deps.accounts.barter(req.params.id as string, currentUserId(req)));
  });

  /** 新增一条交换任务（定好「拿什么换什么」并排队） */
  router.post("/:id/barter/tasks", body(barterTaskSchema), async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const task = await deps.accounts.createBarterTask(id, userId, {
      fromSpecs: req.body.fromSpecs,
      targetSpecs: req.body.targetSpecs,
      quantity: req.body.quantity,
    });
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_BARTER_TASK,
      target: id,
      detail: {
        op: "create",
        taskId: task.id,
        from: task.fromText,
        to: task.targetText,
        quantity: task.quantity,
      },
      ip: clientIp(req),
    });
    res.status(201).json(task);
  });

  /** 取消一条交换任务（已经换到的鱼留在背包里） */
  router.delete("/:id/barter/tasks/:taskId", async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const taskId = req.params.taskId as string;
    const result = await deps.accounts.cancelBarterTask(id, userId, taskId);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_BARTER_TASK,
      target: id,
      detail: { op: "cancel", taskId, from: result.from, to: result.to },
      ip: clientIp(req),
    });
    res.json(result);
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
