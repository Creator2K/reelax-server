// 代理路由：/api/proxies/*
//
// 注意路由顺序：/test 必须排在 /:id 之前，否则 "test" 会被当成代理 id。
import { Router } from "express";
import { z } from "zod";
import type { ProxyService } from "../../services/proxy-service.ts";
import type { AccountService } from "../../services/account-service.ts";
import { parseProxyInput } from "../../services/proxy-input.ts";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { body } from "../middleware/validate.ts";
import { clientIp, Limiters } from "../../auth/ratelimit.ts";
import { AUDIT_ACTIONS, type AuditRepo } from "../../db/repositories/audit.ts";
import { HttpError } from "../server.ts";

const createSchema = z
  .object({
    label: z.string().max(60).optional(),
    url: z.string().max(500).optional(),
    protocol: z.enum(["http", "https", "socks5"]).optional(),
    host: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().max(200).optional(),
    password: z.string().max(200).optional(),
  })
  .refine((v) => Boolean(v.url) || Boolean(v.host), { message: "请提供代理地址（url 或 host+port）" });

const updateSchema = z.object({
  label: z.string().max(60).optional(),
  protocol: z.enum(["http", "https", "socks5"]).optional(),
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(200).nullish(),
  password: z.string().max(200).optional(),
});

const testAdhocSchema = z
  .object({
    url: z.string().max(500).optional(),
    protocol: z.enum(["http", "https", "socks5"]).optional(),
    host: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().max(200).optional(),
    password: z.string().max(200).optional(),
  })
  .refine((v) => Boolean(v.url) || Boolean(v.host), { message: "请提供代理地址" });

export function createProxiesRouter(deps: {
  proxies: ProxyService;
  accounts: AccountService;
  audit: AuditRepo;
  limiters: Limiters;
}): Router {
  const router = Router();
  router.use(requireApproved);

  const guardTestRate = (userId: string) => {
    const rl = deps.limiters.proxyTest.hit(`proxy-test:${userId}`);
    if (!rl.allowed) {
      throw new HttpError(429, "RATE_LIMITED", `测试过于频繁，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后再试。`);
    }
  };

  router.get("/", (req, res) => {
    res.json(deps.proxies.listForUser(currentUserId(req)));
  });

  router.post("/", body(createSchema), (req, res) => {
    const userId = currentUserId(req);
    const parsed = parseProxyInput(req.body);
    const view = deps.proxies.create(userId, parsed);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.PROXY_CREATED,
      target: view.id,
      detail: { protocol: view.protocol, host: view.host, port: view.port },
      ip: clientIp(req),
    });
    res.status(201).json(view);
  });

  router.post("/test", body(testAdhocSchema), async (req, res) => {
    const userId = currentUserId(req);
    guardTestRate(userId);
    const parsed = parseProxyInput(req.body);
    res.json(
      await deps.proxies.testAdhoc(userId, {
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
      }),
    );
  });

  router.get("/:id", (req, res) => {
    res.json(deps.proxies.getForUser(req.params.id as string, currentUserId(req)));
  });

  router.patch("/:id", body(updateSchema), (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const view = deps.proxies.update(id, userId, req.body);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.PROXY_UPDATED,
      target: id,
      detail: { fields: Object.keys(req.body) },
      ip: clientIp(req),
    });
    res.json(view);
  });

  router.delete("/:id", (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    const result = deps.proxies.remove(id, userId);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.PROXY_DELETED,
      target: id,
      detail: { unboundAccounts: result.unboundAccounts },
      ip: clientIp(req),
    });
    res.json({ ok: true, ...result });
  });

  router.post("/:id/test", async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id as string;
    guardTestRate(userId);
    const result = await deps.proxies.test(id, userId);
    deps.audit.record({
      userId,
      action: AUDIT_ACTIONS.PROXY_TESTED,
      target: id,
      detail: { ok: result.ok, latencyMs: result.latencyMs, errorCode: result.errorCode },
      ip: clientIp(req),
    });
    res.json(result);
  });

  router.get("/:id/accounts", (req, res) => {
    const userId = currentUserId(req);
    const row = deps.proxies.requireOwned(req.params.id as string, userId);
    const bound = deps.proxies.listForUser(userId).find((p) => p.id === row.id);
    res.json({ proxyId: row.id, boundAccounts: bound?.boundAccounts ?? 0 });
  });

  return router;
}
