// 认证路由：/api/auth/*
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthService } from "../../auth/service.ts";
import { currentUser, makeCookieStrategy, parseCookie, requireUser, SESSION_COOKIE } from "../../auth/middleware.ts";
import { body } from "../middleware/validate.ts";
import { clientIp } from "../../auth/ratelimit.ts";
import type { Env } from "../../env.ts";
import type { Logger } from "../../lib/logger.ts";

const registerSchema = z.object({
  email: z.string().email("邮箱格式不正确"),
  password: z.string().min(8, "口令至少 8 个字符").max(200, "口令过长"),
  displayName: z.string().min(1, "请填写显示名").max(40, "显示名最多 40 个字符"),
  inviteCode: z.string().max(64).optional(),
});

const loginSchema = z.object({
  email: z.string().min(1, "请输入邮箱"),
  password: z.string().min(1, "请输入口令"),
});

const profileSchema = z.object({
  displayName: z.string().min(1, "请填写显示名").max(40, "显示名最多 40 个字符"),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "请输入当前口令"),
  newPassword: z.string().min(8, "新口令至少 8 个字符").max(200, "口令过长"),
});

export function createAuthRouter(deps: {
  auth: AuthService;
  env: Pick<Env, "cookieSecure" | "sessionTtlDays"> & { version: string; baseUrl: string };
  logger: Logger;
}): Router {
  const router = Router();
  // cookie 的 Secure 按请求协议自动判断；COOKIE_SECURE 显式设置时才强制
  const cookies = makeCookieStrategy(deps.env.cookieSecure, deps.env.sessionTtlDays * 86_400_000);
  /** header 可能是 string[]，统一归一为 string | undefined */
  const ua = (req: Request): string | undefined => {
    const v = req.headers["user-agent"];
    return typeof v === "string" ? v : undefined;
  };

  /** 公开信息：注册开关、是否已有用户（登录页/注册页据此决定要不要显示邀请码） */
  router.get("/system", (_req: Request, res: Response) => {
    res.json({
      version: deps.env.version,
      baseUrl: deps.env.baseUrl,
      ...deps.auth.publicSystemInfo(),
    });
  });

  router.post("/register", body(registerSchema), async (req, res) => {
    const result = await deps.auth.registerAsync({
      email: req.body.email,
      password: req.body.password,
      displayName: req.body.displayName,
      inviteCode: req.body.inviteCode,
      ip: clientIp(req),
      userAgent: ua(req),
    });
    cookies.set(res, req, result.token.token);
    res.status(201).json({ user: result.user, becameAdmin: result.becameAdmin });
  });

  router.post("/login", body(loginSchema), async (req, res) => {
    const result = await deps.auth.login({
      email: req.body.email,
      password: req.body.password,
      ip: clientIp(req),
      userAgent: ua(req),
    });
    cookies.set(res, req, result.token.token);
    res.json({ user: result.user });
  });

  router.post("/logout", (req, res) => {
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    deps.auth.logout(token, req.auth?.user.id, clientIp(req));
    cookies.clear(res);
    res.json({ ok: true });
  });

  /** 当前用户。未登录返回 401（前端据此跳登录页） */
  router.get("/me", requireUser, (req, res) => {
    res.json({ user: deps.auth.toApi(currentUser(req)) });
  });

  router.patch("/profile", requireUser, body(profileSchema), (req, res) => {
    const user = deps.auth.updateProfile(currentUser(req).id, req.body.displayName, clientIp(req));
    res.json({ user });
  });

  router.post("/password", requireUser, body(passwordSchema), async (req, res) => {
    await deps.auth.changePassword({
      userId: currentUser(req).id,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
      ip: clientIp(req),
    });
    // 改口令后所有会话作废，当前会话也没了 → 清除 cookie
    cookies.clear(res);
    res.json({ ok: true, message: "口令已更新，请重新登录" });
  });

  /** 注销自己的全部会话（换设备/怀疑泄漏时用） */
  router.post("/logout-all", requireUser, (req, res) => {
    const user = currentUser(req);
    const n = deps.auth.logoutAll(user.id);
    cookies.clear(res);
    deps.logger.info("认证", `用户 ${user.email} 注销了全部 ${n} 个会话`, { userId: user.id });
    res.json({ ok: true, removed: n });
  });

  return router;
}
