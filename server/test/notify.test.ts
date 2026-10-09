// 推送通道测试：Server酱适配器 + 路由 + 日报前置条件
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendServerChan } from "../src/services/notify-service.ts";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";

/* ---------------- Server酱 HTTP 契约 ---------------- */

type Call = { url: string; method: string; body: string | undefined };

function fakeFetch(script: (call: Call) => { status?: number; body?: unknown; throwError?: unknown }) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body == null ? undefined : String(init.body),
    };
    calls.push(call);
    const r = script(call);
    if (r.throwError) throw r.throwError;
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  return { impl, calls };
}

describe("sendServerChan", () => {
  it("★ 用官方契约：POST https://sctapi.ftqq.com/<key>.send，body 为 {title,desp}", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { code: 0, message: "OK" } }));
    const r = await sendServerChan("SCT123abc", "标题", "正文", { fetchImpl: impl });

    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://sctapi.ftqq.com/SCT123abc.send");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: "标题", desp: "正文" });
  });

  it("SC3（sctp 开头）的 key 走不同域名", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { code: 0, message: "OK" } }));
    await sendServerChan("sctp123tabc", "t", "d", { fetchImpl: impl });
    expect(calls[0]?.url).toBe("https://sctp123tabc.push.ft07.com/send");
  });

  it("code 非 0 时返回失败并带上服务端 message", async () => {
    const { impl } = fakeFetch(() => ({ body: { code: 40001, message: "错误的key" } }));
    const r = await sendServerChan("bad", "t", "d", { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(40001);
    expect(r.message).toBe("错误的key");
  });

  it("HTTP 层错误（500）也算失败", async () => {
    const { impl } = fakeFetch(() => ({ status: 500, body: { message: "server error" } }));
    const r = await sendServerChan("k", "t", "d", { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("server error");
  });

  it("网络异常不抛错，转为失败结果", async () => {
    const { impl } = fakeFetch(() => ({ throwError: new Error("boom") }));
    const r = await sendServerChan("k", "t", "d", { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("boom");
  });

  it("空 SendKey 直接失败，不发请求", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { code: 0 } }));
    const r = await sendServerChan("", "t", "d", { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("非 JSON 响应不会崩", async () => {
    const { impl } = fakeFetch(() => ({ body: "<html>502</html>", status: 502 }));
    const r = await sendServerChan("k", "t", "d", { fetchImpl: impl });
    expect(r.ok).toBe(false);
  });

  it("title 与 desp 支持中文与换行（UTF-8）", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { code: 0 } }));
    await sendServerChan("k", "收益日报 · 2026-10-09", "净收益 +1.2 万\n鱼获 3,456 条", { fetchImpl: impl });
    const sent = JSON.parse(calls[0]!.body!) as { title: string; desp: string };
    expect(sent.title).toContain("收益日报");
    expect(sent.desp).toContain("净收益");
    expect(sent.desp).toContain("\n");
  });
});

/* ---------------- 路由与日报前置条件 ---------------- */

let app: FullApp;
let admin: { jar: ReturnType<FullApp["seedApprovedUser"]>["jar"]; id: string };
let accountId: string;

beforeAll(async () => {
  app = await buildFullApp();
  admin = app.seedApprovedUser("notify-admin@example.com", "admin");
  accountId = app.seedAccount(admin.id, "推送测试账号");
});
afterAll(async () => {
  await app.close();
});

describe("推送通道路由", () => {
  it("初始没有通道，且日报不可配置", async () => {
    const list = await app.get<unknown[]>("/api/notify", admin.jar);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(0);

    const av = await app.get<{ hasUsableChannel: boolean; hint: string | null }>("/api/notify/availability", admin.jar);
    expect(av.body.hasUsableChannel).toBe(false);
    expect(av.body.hint).toBeTruthy();
  });

  it("创建 Server酱通道时会先校验 SendKey（校验失败则拒绝创建）", async () => {
    // 测试环境里 fetch 打不到真实网络，所以创建会因校验失败被拒 —— 这是有意的：
    // 不允许存一个永远发不出去的 key
    const r = await app.post("/api/notify", { kind: "serverchan", sendkey: "invalid-key-for-test" }, admin.jar);
    expect(r.status).toBe(400);
    // 可能因为网络不可达或 key 无效，错误码二者之一
    expect(["SENDKEY_INVALID", "SENDKEY_REQUIRED"]).toContain(r.body.error.code);
  });

  it("缺 sendkey 时明确报错", async () => {
    const r = await app.post("/api/notify", { kind: "serverchan" }, admin.jar);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("SENDKEY_REQUIRED");
  });

  it("未知推送类型被拒", async () => {
    const r = await app.post("/api/notify", { kind: "telegram" }, admin.jar);
    expect(r.status).toBe(400);
  });

  it("未登录 → 401", async () => {
    expect((await app.get("/api/notify")).status).toBe(401);
  });

  it("★ 通道归属隔离：别人看不到、改不了、删不了", async () => {
    const other = app.seedApprovedUser("other-notify@example.com");
    // 直接建通道（跳过 Server酱 校验）
    const row = app.repos.notify.create({ userId: admin.id, kind: "serverchan", label: "我的通道" });

    expect((await app.get(`/api/notify/${row.id}`, other.jar)).status).toBe(404);
    expect((await app.patch(`/api/notify/${row.id}`, { label: "hacked" }, other.jar)).status).toBe(404);
    expect((await app.del(`/api/notify/${row.id}`, other.jar)).status).toBe(404);
    expect(app.repos.notify.findById(row.id)?.label).toBe("我的通道");
    expect((await app.get<unknown[]>("/api/notify", other.jar)).body).toHaveLength(0);
  });
});

describe("日报的推送前置条件", () => {
  it("没有可用通道时：日报在清单里带 unavailable 原因", async () => {
    app.setNotifyAvailable(false);
    const mods = await app.get<{ id: string; requiresNotification: boolean; unavailable: string | null }[]>(
      "/api/modules",
      admin.jar,
    );
    const digest = mods.body.find((m) => m.id === "daily-digest");
    expect(digest?.requiresNotification).toBe(true);
    expect(digest?.unavailable).toBeTruthy();
    expect(digest?.unavailable).toContain("推送");
  });

  it("★ 没有可用通道时：启用日报被服务端拒绝（不只是前端拦）", async () => {
    app.setNotifyAvailable(false);
    const r = await app.patch(`/api/accounts/${accountId}/modules/daily-digest`, { enabled: true }, admin.jar);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("NOTIFICATION_REQUIRED");
    // 确认真的没写进数据库
    expect(app.repos.modules.find(accountId, "daily-digest")).toBeNull();
  });

  it("有可用通道后：清单不再标 unavailable，且可以启用", async () => {
    app.setNotifyAvailable(true);
    const mods = await app.get<{ id: string; unavailable: string | null }[]>("/api/modules", admin.jar);
    expect(mods.body.find((m) => m.id === "daily-digest")?.unavailable).toBeNull();

    const r = await app.patch(`/api/accounts/${accountId}/modules/daily-digest`, { enabled: true }, admin.jar);
    expect(r.status).toBe(200);
    expect(app.repos.modules.find(accountId, "daily-digest")?.enabled).toBe(true);
    app.setNotifyAvailable(false);
  });
});
