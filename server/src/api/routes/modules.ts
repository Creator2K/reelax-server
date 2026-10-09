// 内置功能清单：/api/modules
//
// 前端用它渲染功能卡片与配置表单（configSchema 驱动），不需要硬编码任何字段。
//
// ★ 依赖推送通道的功能（收益日报）在用户没有可用通道时，会带一个
//   `unavailable` 原因，前端据此禁用开关并显示提示。
import { Router } from "express";
import { moduleCatalog } from "../../modules/registry.ts";
import { buildModulePreview, hasPreview } from "../../modules/preview.ts";
import { currentUserId, requireUser } from "../../auth/middleware.ts";
import type { NotifyService } from "../../services/notify-service.ts";

/**
 * @param notify 用于判定推送通道可用性
 * @param hasUsableChannel 可选覆盖（测试注入用；不传则走 notify 的真实判定）
 */
export function createModulesRouter(deps: {
  notify: NotifyService;
  hasUsableChannel?: (userId: string) => boolean;
}): Router {
  const router = Router();
  router.use(requireUser);

  // 与 AccountService 的启用校验共用同一个判定，避免两处口径不一致
  const hasNotify = (userId: string): boolean =>
    deps.hasUsableChannel ? deps.hasUsableChannel(userId) : deps.notify.hasUsableChannel(userId);

  const reason = (userId: string) => (hasNotify(userId) ? null : "需要先配置推送通道（Server酱 或微信机器人）：收益日报的价值在于推送到手机，没有通道时它只会写一条日志。");

  router.get("/", (req, res) => {
    const userId = currentUserId(req);
    const r = reason(userId);
    res.json(
      moduleCatalog({
        unavailableReason: (def) => (def.requiresNotification ? r : null),
      }),
    );
  });

  router.get("/:id", (req, res) => {
    const userId = currentUserId(req);
    const r = reason(userId);
    const found = moduleCatalog({
      unavailableReason: (def) => (def.requiresNotification ? r : null),
    }).find((m) => m.id === req.params.id);
    if (!found) {
      res.status(404).json({ error: { code: "MODULE_NOT_FOUND", message: "功能不存在" } });
      return;
    }
    res.json(found);
  });

  /**
   * 配置预览。
   *
   * 有些配置光看文字想象不出效果（日报包含哪些内容、标题里加变量），
   * 所以让模块自己在服务端算出预览文本，前端在表单旁边实时显示。
   *
   * POST 而不是 GET：配置对象可能不小，放 query 里不合适。
   * 这里**不校验配置合法性** —— 预览要能一边编辑一边看，
   * 非法值由保存时的校验拦（预览对垃圾输入会优雅地返回 null）。
   */
  router.post("/:id/preview", (req, res) => {
    const moduleId = req.params.id as string;
    const config = (req.body ?? {}) as Record<string, unknown>;
    const preview = buildModulePreview(moduleId, config);
    res.json({ preview, supported: hasPreview(moduleId) });
  });

  return router;
}
