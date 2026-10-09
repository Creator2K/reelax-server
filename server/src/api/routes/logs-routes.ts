// 日志路由：/api/logs
//
// 两条数据源：
//  - 内存环形缓冲（Logger）：实时、够快，用于「运行日志」页的默认视图
//  - 数据库（logs 表）：可按时间回溯、支持条件筛选，用于历史查询
// 默认走内存（毫秒级），带 `history=1` 时查库。
import { Router } from "express";
import { z } from "zod";
import type { Logger } from "../../lib/logger.ts";
import type { LogsRepo } from "../../db/repositories/logs.ts";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { query } from "../middleware/validate.ts";
import { MODULES } from "../../modules/registry.ts";

const querySchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  moduleId: z.string().max(64).optional(),
  accountId: z.string().max(64).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
  /** 1 = 查数据库历史（支持 offset 翻页） */
  history: z.coerce.number().int().min(0).max(1).optional(),
  /** 只取该时间点之前的记录（用于「加载更早」） */
  before: z.coerce.number().int().positive().optional(),
});

export function createLogsRouter(deps: { logger: Logger; logs: LogsRepo }): Router {
  const router = Router();
  router.use(requireApproved);

  router.get("/", query(querySchema), (req, res) => {
    const userId = currentUserId(req);
    const q = res.locals.query as z.infer<typeof querySchema>;
    const limit = q.limit ?? 300;

    if (q.history) {
      const rows = deps.logs.query(userId, {
        accountId: q.accountId ?? null,
        moduleId: q.moduleId ?? null,
        minLevel: q.level ?? null,
        search: q.search ?? "",
        limit,
        offset: q.offset ?? 0,
        ...(q.before ? { before: q.before } : {}),
      });
      // 数据库返回「新 → 旧」，前端展示要「旧 → 新」
      res.json(rows.reverse().map(rowToEntry));
      return;
    }

    const entries = deps.logger.recent({
      userId,
      accountId: q.accountId ?? null,
      moduleId: q.moduleId ?? null,
      minLevel: q.level ?? "debug",
      search: q.search ?? "",
      limit,
    });
    res.json(entries);
  });

  /** 给筛选下拉用的元信息（有哪些模块 / 日志级别含义） */
  router.get("/meta", (_req, res) => {
    res.json({
      levels: [
        { value: "debug", label: "调试" },
        { value: "info", label: "信息" },
        { value: "warn", label: "警告" },
        { value: "error", label: "错误" },
      ],
      modules: MODULES.map((m) => ({ id: m.id, name: m.name })),
    });
  });

  return router;
}

function rowToEntry(row: {
  id: number;
  user_id: string | null;
  account_id: string | null;
  level: string;
  module_id: string | null;
  tag: string;
  msg: string;
  created_at: number;
}) {
  return {
    t: Number(row.created_at),
    level: row.level,
    userId: row.user_id,
    accountId: row.account_id,
    moduleId: row.module_id,
    tag: row.tag,
    msg: row.msg,
    /** 历史记录才有 id（内存缓冲没有） */
    id: Number(row.id),
  };
}
