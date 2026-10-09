// Express 应用：REST + 静态托管（web/dist）+ SPA 回退
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Logger } from "../lib/logger.ts";

export type HttpDeps = {
  logger: Logger;
  /** 前端产物目录；不存在时返回提示页 */
  webDist?: string;
  /** 生产环境隐藏内部错误细节 */
  isProduction: boolean;
  trustProxy: boolean;
  version: string;
  startedAt: number;
  /** 挂载业务路由的钩子（Phase 3+ 注入） */
  mount?: (app: Express) => void;
};

export function createApp(deps: HttpDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  if (deps.trustProxy) app.set("trust proxy", true);

  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  /* ---------- 健康检查（Docker healthcheck 用，不需要鉴权） ---------- */
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      version: deps.version,
      uptime: Date.now() - deps.startedAt,
    });
  });

  // 业务路由
  deps.mount?.(app);

  /* ---------- 静态资源 + SPA 回退 ---------- */
  const dist = deps.webDist;
  const hasDist = Boolean(dist && fs.existsSync(path.join(dist, "index.html")));

  if (hasDist && dist) {
    app.use(
      express.static(dist, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
          else res.setHeader("Cache-Control", "public, max-age=86400");
        },
      }),
    );
  }

  // 未匹配的 /api/* 视为 404（不要落到 SPA 回退，否则前端会拿到一坨 HTML）
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "接口不存在" } });
  });

  if (hasDist && dist) {
    app.get(/.*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(dist, "index.html"));
    });
  } else {
    app.get(/.*/, (_req, res) => {
      res.status(200).type("html").send(
        "<!doctype html><meta charset=utf-8><title>Reelax</title>" +
          "<body style=\"font-family:system-ui;padding:2rem;max-width:40rem\">" +
          "<h1>Reelax 服务器</h1><p>前端尚未构建。开发时请直接访问 Vite 端口；" +
          "生产请先执行 <code>npm run build</code>。</p>",
      );
    });
  }

  /* ---------- 统一错误处理 ---------- */
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const e = err as { statusCode?: number; status?: number; code?: string; message?: string; expose?: boolean };
    const status = e?.statusCode ?? e?.status ?? 500;
    if (status >= 500) {
      deps.logger.error("HTTP", `${req.method} ${req.originalUrl} 失败：${e?.message ?? String(err)}`);
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    const message =
      status >= 500 && deps.isProduction && !e?.expose ? "服务器内部错误" : (e?.message ?? "请求失败");
    res.status(status).json({ error: { code: e?.code ?? "ERROR", message } });
  });

  return app;
}

/** 业务错误：带 HTTP 状态码与机器可读 code */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(statusCode: number, code: string, message: string, expose = true) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") => new HttpError(400, code, message);
export const unauthorized = (message = "未登录", code = "UNAUTHORIZED") => new HttpError(401, code, message);
export const forbidden = (message: string, code = "FORBIDDEN") => new HttpError(403, code, message);
/** 越权一律返回 404（不泄漏资源是否存在） */
export const notFound = (message = "资源不存在", code = "NOT_FOUND") => new HttpError(404, code, message);
export const conflict = (message: string, code = "CONFLICT") => new HttpError(409, code, message);
