import { Router } from "express";
import { z } from "zod";
import type { AccountService } from "../../services/account-service.ts";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { body } from "../middleware/validate.ts";
import { clientIp } from "../../auth/ratelimit.ts";
import { AUDIT_ACTIONS, type AuditRepo } from "../../db/repositories/audit.ts";
import { buildGameLaunchExtensionZip } from "../../services/game-launch-extension.ts";

const ticketSchema = z.object({
  accountId: z.string().min(1).max(64),
  mode: z.enum(["cookie", "credentials"]).default("cookie"),
});

const redeemSchema = z.object({
  ticket: z.string().min(20).max(300),
});

function requestOrigin(req: { protocol: string; get(name: string): string | undefined }): string {
  const forwardedProto = String(req.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();
  const host = String(req.get("x-forwarded-host") ?? req.get("host") ?? "").split(",")[0]?.trim();
  return `${forwardedProto || req.protocol}://${host}`;
}

export function createGameLaunchRouter(deps: {
  accounts: AccountService;
  audit: AuditRepo;
  gameOrigin: string;
}): Router {
  const router = Router();
  const gameOrigin = new URL(deps.gameOrigin).origin;

  // Bookmarklet fallback runs on the game origin and needs CORS. Tickets are single-use.
  router.use("/redeem", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", gameOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  router.post("/redeem", body(redeemSchema), async (req, res) => {
    res.json(await deps.accounts.redeemGameLaunchTicket(req.body.ticket));
  });

  router.use(requireApproved);

  router.post("/tickets", body(ticketSchema), (req, res) => {
    const userId = currentUserId(req);
    const result = deps.accounts.createGameLaunchTicket(req.body.accountId, userId, req.body.mode);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.ACCOUNT_GAME_LAUNCH,
      target: req.body.accountId,
      detail: { mode: req.body.mode },
      ip: clientIp(req),
    });
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json(result);
  });

  router.get("/extension.zip", (req, res) => {
    const serverOrigin = requestOrigin(req);
    const zip = buildGameLaunchExtensionZip({ serverOrigin, gameOrigin });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="reelax-game-login-extension.zip"');
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.send(zip);
  });

  return router;
}
