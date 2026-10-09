// 推送路由：/api/notify/*
//
// 用户级的推送配置（每个用户管自己的通道）。
// 「收益日报」是否可配置，由这里的 hasUsableChannel 决定（见 /availability）。
import { Router } from "express";
import { z } from "zod";
import type { NotifyService } from "../../services/notify-service.ts";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { body } from "../middleware/validate.ts";
import { clientIp, Limiters } from "../../auth/ratelimit.ts";
import type { AuditRepo } from "../../db/repositories/audit.ts";
import { HttpError } from "../server.ts";

const createSchema = z.object({
  kind: z.enum(["serverchan", "wechat"]),
  label: z.string().max(60).optional(),
  /** 仅 Server酱 需要 */
  sendkey: z.string().max(200).optional(),
});

const updateSchema = z.object({
  label: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
});

export function createNotifyRouter(deps: {
  notify: NotifyService;
  audit: AuditRepo;
  limiters: Limiters;
}): Router {
  const router = Router();
  router.use(requireApproved);

  /**
   * 当前用户是否具备配置「收益日报」的前置条件。
   * 前端据此禁用/隐藏日报配置项（任务要求：没配推送就不让配日报）。
   */
  router.get("/availability", (req, res) => {
    const userId = currentUserId(req);
    const channels = deps.notify.listForUser(userId);
    const usable = channels.filter((c) => c.enabled && c.usable);
    res.json({
      hasUsableChannel: usable.length > 0,
      usableCount: usable.length,
      total: channels.length,
      /** 给 UI 的提示文案 */
      hint:
        usable.length > 0
          ? null
          : channels.length === 0
            ? "还没有配置推送通道。先去「推送」添加 Server酱 或微信机器人，才能启用收益日报。"
            : "推送通道还没有就绪（Server酱 需填写 SendKey；微信需扫码登录并绑定接收人）。",
    });
  });

  router.get("/", (req, res) => {
    res.json(deps.notify.listForUser(currentUserId(req)));
  });

  router.post("/", body(createSchema), async (req, res) => {
    const userId = currentUserId(req);
    const view = await deps.notify.create(userId, {
      kind: req.body.kind,
      ...(req.body.label !== undefined ? { label: req.body.label } : {}),
      ...(req.body.sendkey !== undefined ? { sendkey: req.body.sendkey } : {}),
    });
    deps.audit.record({
      userId,
      action: "notify.created",
      target: view.id,
      detail: { kind: view.kind },
      ip: clientIp(req),
    });
    res.status(201).json(view);
  });

  router.get("/:id", (req, res) => {
    res.json(deps.notify.getForUser(req.params.id as string, currentUserId(req)));
  });

  router.patch("/:id", body(updateSchema), (req, res) => {
    const userId = currentUserId(req);
    const view = deps.notify.update(req.params.id as string, userId, req.body);
    deps.audit.record({
      userId,
      action: "notify.updated",
      target: view.id,
      detail: { fields: Object.keys(req.body) },
      ip: clientIp(req),
    });
    res.json(view);
  });

  router.delete("/:id", async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    await deps.notify.remove(id, userId);
    deps.audit.record({ userId, action: "notify.deleted", target: id, ip: clientIp(req) });
    res.json({ ok: true });
  });

  /** 发一条测试消息（限流，避免被当成短信轰炸工具） */
  router.post("/:id/test", async (req, res) => {
    const userId = currentUserId(req);
    const rl = deps.limiters.proxyTest.hit(`notify-test:${userId}`);
    if (!rl.allowed) {
      throw new HttpError(429, "RATE_LIMITED", `测试过于频繁，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后再试。`);
    }
    const result = await deps.notify.test(req.params.id as string, userId);
    res.json(result);
  });

  /**
   * 通道特有动作：
   *   微信 —— login（重新扫码）/ reconnect（用已保存凭证重连）/ retry / unbind
   *
   * 注意：Express 5 用的 path-to-regexp v8 不再支持内联正则参数
   * （`:action(login|unbind|retry)` 会直接抛 "Unexpected ( at index …"），
   * 所以这里用普通参数 + 手工白名单校验。
   */
  const ALLOWED_ACTIONS = new Set(["login", "reconnect", "retry", "unbind"]);
  router.post("/:id/:action", async (req, res) => {
    const userId = currentUserId(req);
    const { id, action } = req.params as { id: string; action: string };
    if (!ALLOWED_ACTIONS.has(action)) {
      throw new HttpError(404, "UNKNOWN_ACTION", `不支持的操作：${action}`);
    }
    const view = await deps.notify.action(id, userId, action);
    res.json(view);
  });

  return router;
}
