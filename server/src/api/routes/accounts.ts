// 账号路由：/api/accounts/*
//
// 所有路由都要求「已审批 + 资源归属」，归属校验在 AccountService 里统一做，
// 越权返回 404 而不是 403（不泄漏资源是否存在）。
import { Router } from "express";
import { z } from "zod";
import type { AccountService } from "../../services/account-service.ts";
import type { SwapService } from "../../services/swap-service.ts";
import type { RunnerRegistry } from "../../game/runner-registry.ts";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { body, query } from "../middleware/validate.ts";
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

const swapListSchema = z.object({
  /** 筛选：稀有度 / 目标地图 / 具体目标鱼 / 是否只要不降级（都不填 = 全部） */
  rarity: z.string().max(20).optional(),
  biomeId: z.string().max(80).optional(),
  targetFishId: z.string().max(120).optional(),
  onlyUpgrade: z.enum(["true", "false"]).optional(),
});

const swapExecuteSchema = z.object({
  /**
   * 要执行的一串交换步骤（正序）：每一步交出 requestFishId、获得 offerFishId。
   *
   * 直接收面板上看到的那条链 —— 服务端会重新确认每一步要交出的鱼还在背包里，
   * 被抢单 / 缺鱼都会停在那一步并如实返回（不会假装整条成功）。
   */
  hops: z
    .array(
      z.object({
        orderId: z.string().min(1).max(120),
        requestFishId: z.string().min(1).max(120),
        offerFishId: z.string().min(1).max(120),
      }),
    )
    .min(1)
    .max(8),
});

const swapRunSchema = z.object({
  /** 想换到几条（服务端还会按「目标还差几条」与上限再收一次） */
  quantity: z.number().int().min(1).max(10).optional(),
  /** 筛选：稀有度 / 目标地图 / 具体目标鱼 / 是否只要不降级（都不填 = 全部） */
  rarity: z.string().max(20).nullish(),
  biomeId: z.string().max(80).nullish(),
  targetFishId: z.string().max(120).nullish(),
  onlyUpgrade: z.boolean().optional(),
});

export function createAccountsRouter(deps: {
  accounts: AccountService;
  registry: RunnerRegistry;
  audit: AuditRepo;
  swap: SwapService;
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

  /* ---------- 交换助手（专精换鱼） ---------- */

  /** 当前扫描状态 + 按筛选收好的结果（列表 / 下拉候选 / 计数同源） */
  router.get("/:id/swap", query(swapListSchema), (req, res) => {
    const q = res.locals.query as z.infer<typeof swapListSchema>;
    res.json(
      deps.swap.state(currentUserId(req), req.params.id as string, {
        rarity: q.rarity ?? null,
        biomeId: q.biomeId ?? null,
        targetFishId: q.targetFishId ?? null,
        onlyUpgrade: q.onlyUpgrade === "true",
      }),
    );
  });

  /** 开始一次扫描（立刻返回，进度由上面的接口轮询） */
  router.post("/:id/swap/scan", (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const state = deps.swap.start(userId, id);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_SWAP_SCAN,
      target: id,
      ip: clientIp(req),
    });
    res.json(state);
  });

  /** 执行一条链（用户手动点的；会真的把鱼换出去） */
  router.post("/:id/swap/execute", body(swapExecuteSchema), async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const result = await deps.swap.execute(userId, id, req.body.hops);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_SWAP_EXECUTE,
      target: id,
      detail: {
        hops: req.body.hops.length,
        from: req.body.hops[0]?.requestFishId,
        to: req.body.hops[req.body.hops.length - 1]?.offerFishId,
        ok: result.ok,
        done: result.done,
      },
      ip: clientIp(req),
    });
    res.json(result);
  });

  /** 批量「换 N 条」：按筛选反复走能走通的链（后台跑，进度看上面的状态接口） */
  router.post("/:id/swap/run", body(swapRunSchema), (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const state = deps.swap.run(userId, id, {
      quantity: req.body.quantity ?? 1,
      rarity: req.body.rarity ?? null,
      biomeId: req.body.biomeId ?? null,
      targetFishId: req.body.targetFishId ?? null,
      onlyUpgrade: req.body.onlyUpgrade === true,
    });
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_SWAP_EXECUTE,
      target: id,
      detail: {
        mode: "batch",
        want: req.body.quantity ?? 1,
        plan: state.run.targetCount,
        rarity: req.body.rarity ?? null,
        biomeId: req.body.biomeId ?? null,
        targetFishId: req.body.targetFishId ?? null,
        onlyUpgrade: req.body.onlyUpgrade === true,
      },
      ip: clientIp(req),
    });
    res.json(state);
  });

  /** 停止批量执行（当前这一跳走完就停） */
  router.post("/:id/swap/stop", (req, res) => {
    res.json(deps.swap.stop(currentUserId(req), req.params.id as string));
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
