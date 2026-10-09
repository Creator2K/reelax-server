// 认证中间件：cookie 解析、requireUser / requireApproved / requireAdmin
//
// 鉴权边界说明：
//  - requireUser     只要有有效会话
//  - requireApproved 额外要求 status === "approved"（pending 用户被挡在业务接口之外）
//  - requireAdmin    额外要求 role === "admin"
// 业务层还必须再做「资源归属」判断（见每个路由里的 userId 过滤），
// 越权时统一返回 404 而不是 403 —— 不泄漏资源是否存在。
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthService, ApiUser } from "./service.ts";
import type { UserRow } from "../db/repositories/users.ts";
import { forbidden, unauthorized } from "../api/server.ts";

export const SESSION_COOKIE = "reelax_session";

export type RequestAuth = {
  user: UserRow;
  sessionId: string;
  expiresAt: number;
  token: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: RequestAuth;
    }
  }
}

/** 极简 cookie 解析（只取需要的那个键，不引 cookie-parser） */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    const v = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

export type CookieOptions = {
  /** 强制加 Secure；不传则由「本次请求是否 HTTPS」决定 */
  secure?: boolean;
  maxAgeMs: number;
};

export function serializeSessionCookie(token: string, opts: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** 清 cookie 不需要 Secure（浏览器无论如何都会覆盖掉同名 cookie） */
export function clearSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"].join("; ");
}

/**
 * 组装 cookie 策略。
 * @param forceSecure 显式设置 COOKIE_SECURE 时用它；undefined 表示按请求协议自动判断
 */
export function makeCookieStrategy(forceSecure: boolean | undefined, ttlMs: number) {
  const effective = { forceSecure, maxAgeMs: ttlMs };
  return {
    /** 下发会话 cookie（自动判断本次请求是否 HTTPS） */
    set(res: Response, req: Request, token: string): void {
      res.append("Set-Cookie", serializeSessionCookie(token, cookieOptionsFor(req, effective)));
    },
    /** 清除会话 cookie */
    clear(res: Response): void {
      res.append("Set-Cookie", clearSessionCookie());
    },
    /** 覆盖 maxAge（例如滑动续期时想用同一套逻辑） */
    get maxAgeMs(): number {
      return ttlMs;
    },
  };
}

export type CookieStrategy = ReturnType<typeof makeCookieStrategy>;

/**
 * 判断本次请求是否走 HTTPS。
 *
 * ★ 为什么按请求判断而不是按 NODE_ENV：
 *   早期实现是「production 就加 Secure」，结果在
 *   「Nginx 只做 80 端口反代」或「局域网 IP 直接访问」的部署里，
 *   浏览器拿到 Secure cookie 后在 http:// 下不会回传 —— 表现为
 *   「登录接口返回 200，但立刻又是未登录」，非常难排查。
 *
 *   Express 在 `trust proxy` 打开时会依据 X-Forwarded-Proto 设置 req.secure，
 *   所以反代场景也能正确识别。
 */
export function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers["x-forwarded-proto"];
  const first = Array.isArray(proto) ? proto[0] : proto;
  return typeof first === "string" && first.split(",")[0]?.trim() === "https";
}

/**
 * 解析本次请求该用的 cookie 选项。
 * 三态语义：forceSecure === true / false 时以它为准；undefined 时按协议自动判断。
 * （不能写成 `forceSecure ? true : isHttps(...)` —— 那样显式的 false 会被当成「未设置」。）
 */
export function cookieOptionsFor(req: Request, deps: { forceSecure?: boolean; maxAgeMs: number }): CookieOptions {
  const secure = deps.forceSecure === undefined ? isHttpsRequest(req) : deps.forceSecure;
  return { maxAgeMs: deps.maxAgeMs, secure };
}

/** 从 cookie 解析当前用户（不做拦截，允许匿名） */
export function attachAuth(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) {
      next();
      return;
    }
    const resolved = auth.resolveSession(token);
    if (resolved) {
      req.auth = { user: resolved.user, sessionId: resolved.sessionId, expiresAt: resolved.expiresAt, token };
      // 滑动续期（内部会判断是否需要写库）
      auth.maybeExtend(resolved.sessionId, resolved.expiresAt);
    }
    next();
  };
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) {
    next(unauthorized("请先登录", "UNAUTHORIZED"));
    return;
  }
  next();
}

export function requireApproved(req: Request, _res: Response, next: NextFunction): void {
  const u = req.auth?.user;
  if (!u) {
    next(unauthorized("请先登录", "UNAUTHORIZED"));
    return;
  }
  if (u.status !== "approved") {
    next(forbidden("账号尚未通过管理员审批", "NOT_APPROVED"));
    return;
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const u = req.auth?.user;
  if (!u) {
    next(unauthorized("请先登录", "UNAUTHORIZED"));
    return;
  }
  if (u.role !== "admin") {
    next(forbidden("需要管理员权限", "ADMIN_ONLY"));
    return;
  }
  next();
}

/** 便捷取值：已通过 requireUser 之后调用 */
export function currentUser(req: Request): UserRow {
  const u = req.auth?.user;
  if (!u) throw unauthorized("请先登录", "UNAUTHORIZED");
  return u;
}

export function currentUserId(req: Request): string {
  return currentUser(req).id;
}

export function toApiUserShape(u: UserRow, extra?: Partial<ApiUser>): ApiUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    status: u.status,
    createdAt: Number(u.created_at),
    lastLoginAt: u.last_login_at == null ? null : Number(u.last_login_at),
    ...extra,
  };
}
