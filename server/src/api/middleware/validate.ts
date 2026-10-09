// 通用中间件：zod 请求体/查询校验
import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { HttpError } from "../server.ts";

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, "VALIDATION_ERROR", message);
    if (details !== undefined) {
      (this as { details?: unknown }).details = details;
    }
  }
}

/** 校验 req.body，成功时把解析结果写回 req.body */
export function body<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join(".") || "请求体";
      next(new ValidationError(`${path}：${first?.message ?? "参数不合法"}`, parsed.error.issues));
      return;
    }
    req.body = parsed.data;
    next();
  };
}

/** 校验 req.query，结果挂在 res.locals.query */
export function query<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.query ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      next(new ValidationError(`${first?.path.join(".") || "查询参数"}：${first?.message ?? "参数不合法"}`));
      return;
    }
    res.locals.query = parsed.data;
    next();
  };
}

export function getQuery<T>(res: { locals: Record<string, unknown> }): T {
  return res.locals.query as T;
}
