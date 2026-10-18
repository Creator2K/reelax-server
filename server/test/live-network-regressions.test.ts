// 真实测试账号暴露的连接池初始化问题，以及按网络故障特征复现的断流/启停回归。
// 所有测试使用本地 HTTP 或假 fetch，不读取真实账号，也不连接游戏。
import http from "node:http";
import { describe, expect, it } from "vitest";
import { GameClient } from "../src/game/client.ts";
import { ProxyDispatcherHolder } from "../src/game/proxy.ts";

const PROOF = `${Buffer.from(JSON.stringify({ expiresAt: Date.now() + 3_600_000 })).toString("base64url")}.test`;

async function withServer(handler: http.RequestListener, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try { await run(`http://127.0.0.1:${port}`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("直连连接池生命周期", () => {
  it("初次直连要建立专用连接池，关闭后再次启用要重建", async () => {
    const holder = new ProxyDispatcherHolder();
    try {
      expect(holder.set(null)).toBe(true);
      const first = holder.current;
      expect(first).toBeDefined();
      expect(holder.set(null)).toBe(false);
      await holder.close();
      expect(holder.set(null)).toBe(true);
      expect(holder.current).toBeDefined();
      expect(holder.current).not.toBe(first);
    } finally { await holder.close(); }
  });

  it("从代理切回直连，停止再启动后仍能完成真实 HTTP 请求", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("x-arcane-request-proof", PROOF);
      res.end(JSON.stringify({ player: { nickname: "本地测试" } }));
    }, async (baseUrl) => {
      const holder = new ProxyDispatcherHolder();
      const client = new GameClient({ baseUrl, cookie: "local-test=1" });
      try {
        holder.set({ protocol: "http", host: "127.0.0.1", port: 1 });
        holder.set(null);
        client.setDispatcher(holder.current, false);
        expect((await client.ensureSession()).player.nickname).toBe("本地测试");
        await holder.close();
        expect(holder.set(null)).toBe(true);
        client.setDispatcher(holder.current, false);
        expect((await client.ensureSession()).player.nickname).toBe("本地测试");
      } finally { await holder.close(); }
    });
  });

  it("关闭连接池立即中断在飞请求，不能一直等慢响应结束", async () => {
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => { entered = resolve; });
    await withServer((_req, _res) => { entered(); }, async (baseUrl) => {
      const holder = new ProxyDispatcherHolder();
      holder.set(null);
      const client = new GameClient({ baseUrl, dispatcher: holder.current, proxyConfigured: false });
      client.setProof(PROOF);
      const pending = client.request("/slow").then(() => null, (err: unknown) => err);
      let timeout: NodeJS.Timeout | undefined;
      try {
        await requested;
        await Promise.race([
          holder.close(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("关闭连接池仍在等待慢响应")), 1000);
          }),
        ]);
        expect(await pending).toMatchObject({ code: "NETWORK" });
      } finally {
        clearTimeout(timeout);
        await holder.close();
      }
    });
  });
});

describe("响应体读取也属于请求", () => {
  it.each(["request", "refreshProof"] as const)("%s：200 响应头之后的读取超时必须报错", async (method) => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      res.write('{"player":');
      // 故意不结束响应体，模拟真实链路中断/卡住。
    }, async (baseUrl) => {
      const holder = new ProxyDispatcherHolder();
      holder.set(null);
      const client = new GameClient({ baseUrl, dispatcher: holder.current, proxyConfigured: false, timeoutMs: 100 });
      client.setProof(PROOF);
      try {
        const response = method === "request" ? client.request("/slow-body", { timeoutMs: 80 }) : client.refreshProof();
        await expect(response).rejects.toMatchObject({ code: "TIMEOUT" });
      } finally { await holder.close(); }
    });
  });

  it("响应体断流不能被当成成功的 null", async () => {
    const client = new GameClient({ baseUrl: "https://example.invalid", fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("stream connection terminated")); },
    }), { status: 200 }) });
    client.setProof(PROOF);
    await expect(client.request("/body")).rejects.toMatchObject({ code: "NETWORK" });
  });

  it.each([false, true])("同一个底层错误按实际代理配置分类（proxyConfigured=%s）", async (proxied) => {
    const holder = new ProxyDispatcherHolder();
    holder.set(null);
    const client = new GameClient({
      baseUrl: "https://example.invalid", dispatcher: holder.current, proxyConfigured: proxied,
      fetchImpl: async () => { throw Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }); },
    });
    client.setProof(PROOF);
    try {
      await expect(client.request("/probe")).rejects.toMatchObject({ code: proxied ? "PROXY_UNREACHABLE" : "NETWORK" });
    } finally { await holder.close(); }
  });
});
