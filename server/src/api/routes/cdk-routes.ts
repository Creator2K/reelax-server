// CDK 公共库路由：/api/cdk
//
//  - GET    /api/cdk                 列表（别人的码打码）
//  - POST   /api/cdk/submit          提交（先用指定账号试领，逐条返回结论）
//  - POST   /api/cdk/:id/claim       一键兑换
//  - DELETE /api/cdk/:id             删除自己提交的码
import { Router } from "express";
import { z } from "zod";
import type { CdkService } from "../../services/cdk-service.ts";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { body, query } from "../middleware/validate.ts";
import { HttpError } from "../server.ts";

const listSchema = z.object({
  /** all = 不过滤状态；默认也只按状态筛 */
  status: z.enum(["all", "available", "not_started", "exhausted"]).optional(),
  search: z.string().max(80).optional(),
  /** 1 = 只看我提交的 */
  mine: z.coerce.number().int().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

const submitSchema = z.object({
  accountId: z.string().min(1).max(64),
  codes: z.array(z.string().min(1).max(80)).min(1, "至少填一个码").max(50, "一次最多 50 个"),
});

const claimSchema = z.object({
  accountId: z.string().min(1).max(64),
});

export function createCdkRouter(deps: { cdk: CdkService }): Router {
  const router = Router();
  router.use(requireApproved);

  router.get("/", query(listSchema), (req, res) => {
    const q = res.locals.query as z.infer<typeof listSchema>;
    res.json(
      deps.cdk.list(currentUserId(req), {
        status: q.status ?? "all",
        ...(q.search ? { search: q.search } : {}),
        mineOnly: q.mine === 1,
        limit: q.limit ?? 50,
        offset: q.offset ?? 0,
      }),
    );
  });

  /** 一键领取：把库里所有「可兑换」的码依次领一遍（逐条结论汇总返回） */
  router.post("/claim-all", body(claimSchema), async (req, res) => {
    const userId = currentUserId(req);
    const { accountId } = req.body as z.infer<typeof claimSchema>;
    res.json(await deps.cdk.claimAll(userId, accountId));
  });

  router.post("/submit", body(submitSchema), async (req, res) => {
    const userId = currentUserId(req);
    const { accountId, codes } = req.body as z.infer<typeof submitSchema>;
    res.json({ results: await deps.cdk.submit(userId, accountId, codes) });
  });

  router.post("/:id/claim", body(claimSchema), async (req, res) => {
    const userId = currentUserId(req);
    const { accountId } = req.body as z.infer<typeof claimSchema>;
    res.json(await deps.cdk.claim(userId, accountId, String(req.params.id)));
  });

  router.delete("/:id", (req, res) => {
    const removed = deps.cdk.remove(currentUserId(req), String(req.params.id));
    if (!removed) throw new HttpError(404, "CDK_NOT_FOUND", "只能删除自己提交的码");
    res.json({ ok: true });
  });

  return router;
}
