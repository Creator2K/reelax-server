// 代理层单测 + 真实 CONNECT 隧道端到端验证
//
// 这里自己实现一个最小 HTTP CONNECT 代理：不依赖外部网络，能真正验证
// 「undici 的自定义 connect 工厂确实把流量送进了隧道」，而不是只测解析函数。
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProxyDispatcherHolder,
  ProxyError,
  classifyProxyError,
  checkProxy,
  connectHostname,
  connectTarget,
  createProxyDispatcher,
  describeProxyError,
  extractIp,
  formatProxy,
  parseGlobalProxy,
  parseProxyUrl,
  proxyFingerprint,
} from "../src/game/proxy.ts";

/* ---------------- 解析 ---------------- */

describe("parseProxyUrl", () => {
  it("裸 host:port 默认按 http", () => {
    const r = parseProxyUrl("1.2.3.4:8080");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toEqual({ protocol: "http", host: "1.2.3.4", port: 8080, username: null, password: null });
  });

  it("带协议前缀", () => {
    for (const [input, protocol] of [
      ["http://a.com:1", "http"],
      ["https://a.com:1", "https"],
      ["socks5://a.com:1", "socks5"],
      ["socks5h://a.com:1", "socks5"],
      ["SOCKS5://A.com:1", "socks5"],
    ] as const) {
      const r = parseProxyUrl(input);
      expect(r.ok, input).toBe(true);
      if (r.ok) expect(r.config.protocol).toBe(protocol);
    }
  });

  it("解析用户名口令（含 URL 编码）", () => {
    const r = parseProxyUrl("http://user%40name:p%3Ass@host.com:3128");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.username).toBe("user@name");
      expect(r.config.password).toBe("p:ss");
    }
  });

  it("没有口令时 password 为 null", () => {
    const r = parseProxyUrl("socks5://onlyuser@h:1080");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.username).toBe("onlyuser");
      expect(r.config.password).toBeNull();
    }
  });

  it("IPv6 字面量", () => {
    const r = parseProxyUrl("socks5://[::1]:1080");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.host).toBe("::1");
  });

  it("拒绝非法输入", () => {
    const cases: [string, RegExp][] = [
      ["", /为空/],
      ["justhost", /缺少端口/],
      ["host:abc", /端口不合法/],
      ["host:0", /端口不合法/],
      ["host:99999", /端口不合法/],
      ["ftp://host:21", /不支持的代理协议/],
      [":8080", /主机名为空|缺少端口/],
      ["http://user:pass@:8080", /主机名为空|缺少端口|只填了密码/],
    ];
    for (const [input, pattern] of cases) {
      const r = parseProxyUrl(input);
      expect(r.ok, input).toBe(false);
      if (!r.ok) expect(r.message).toMatch(pattern);
    }
  });

  it("formatProxy 不包含口令", () => {
    const r = parseProxyUrl("http://user:secret@h:8080");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(formatProxy(r.config)).toBe("http://h:8080");
      expect(formatProxy(r.config)).not.toContain("secret");
    }
  });

  it("parseGlobalProxy：空值 / 非法值给 null", () => {
    expect(parseGlobalProxy("")).toBeNull();
    expect(parseGlobalProxy("   ")).toBeNull();
    expect(parseGlobalProxy("垃圾")).toBeNull();
    expect(parseGlobalProxy("socks5://127.0.0.1:1080")?.protocol).toBe("socks5");
  });
});

describe("connectTarget（undici v7 的 host 已带端口，不能重复拼接）", () => {
  it("host 已含端口时原样保留", () => {
    expect(connectTarget("127.0.0.1:53396", "53396")).toBe("127.0.0.1:53396");
    expect(connectTarget("reelax.cn:443", "443")).toBe("reelax.cn:443");
  });

  it("host 不含端口时补上", () => {
    expect(connectTarget("reelax.cn", "443")).toBe("reelax.cn:443");
    expect(connectTarget("127.0.0.1", 8080)).toBe("127.0.0.1:8080");
  });

  it("IPv6 补中括号", () => {
    expect(connectTarget("::1", "443")).toBe("[::1]:443");
    expect(connectTarget("[::1]", "443")).toBe("[::1]:443");
    expect(connectTarget("[::1]:443", "443")).toBe("[::1]:443");
  });

  it("connectHostname 取出纯主机名（用于 TLS SNI）", () => {
    expect(connectHostname("reelax.cn:443")).toBe("reelax.cn");
    expect(connectHostname("reelax.cn")).toBe("reelax.cn");
    expect(connectHostname("127.0.0.1:8080")).toBe("127.0.0.1");
    expect(connectHostname("[::1]:443")).toBe("::1");
    expect(connectHostname("::1")).toBe("::1");
  });

  it("回归：绝不产生 host:port:port", () => {
    // 这是真实踩到的 bug —— undici v7 给的 host 已含端口
    const target = connectTarget("127.0.0.1:53396", "53396");
    expect(target).not.toContain(":53396:53396");
    expect(target.split(":")).toHaveLength(2);
  });
});

/* ---------------- 指纹与失败分类 ---------------- */

describe("proxyFingerprint", () => {
  it("配置变化时指纹变化（用于判断是否重建 Agent）", () => {
    const base = { protocol: "http" as const, host: "h", port: 1, username: null, password: null };
    expect(proxyFingerprint(base)).toBe("http://h:1:");
    expect(proxyFingerprint(null)).toBe("direct");
    expect(proxyFingerprint({ ...base, port: 2 })).not.toBe(proxyFingerprint(base));
    expect(proxyFingerprint({ ...base, username: "u" })).not.toBe(proxyFingerprint(base));
    // 口令变化不算指纹变化（不会为了换密码重建连接池，但 set 时仍会带上新口令）
    expect(proxyFingerprint({ ...base, password: "x" })).toBe(proxyFingerprint(base));
  });
});

describe("classifyProxyError", () => {
  it("映射常见底层错误码", () => {
    expect(classifyProxyError({ code: "ENOTFOUND" })).toBe("PROXY_DNS_FAILED");
    expect(classifyProxyError({ code: "ETIMEDOUT" })).toBe("PROXY_CONNECT_TIMEOUT");
    expect(classifyProxyError({ code: "ECONNREFUSED" })).toBe("PROXY_UNREACHABLE");
    expect(classifyProxyError({ statusCode: 407 })).toBe("PROXY_AUTH_FAILED");
    expect(classifyProxyError(new Error("self signed certificate"))).toBe("PROXY_TLS_FAILED");
    expect(classifyProxyError(new Error("whatever"))).toBe("PROXY_ERROR");
  });

  it("每种错误码都有可读文案", () => {
    for (const code of ["PROXY_CONNECT_TIMEOUT", "PROXY_AUTH_FAILED", "PROXY_DNS_FAILED"] as const) {
      expect(ProxyError.messageFor(code).length).toBeGreaterThan(5);
    }
  });

  it("★ 只有 message、没有 code 的错误也能分类（socks 库就是这种形状）", () => {
    // SocksClientError 没有 code / errno，errno 文本只出现在 message 里。
    // 早期实现只看 code，导致 SOCKS5 的失败全部退化成 PROXY_ERROR。
    expect(classifyProxyError(new Error("connect ECONNREFUSED 127.0.0.1:1080"))).toBe("PROXY_UNREACHABLE");
    expect(classifyProxyError(new Error("connect ETIMEDOUT 1.2.3.4:1080"))).toBe("PROXY_CONNECT_TIMEOUT");
    expect(classifyProxyError(new Error("getaddrinfo ENOTFOUND proxy.invalid"))).toBe("PROXY_DNS_FAILED");
    expect(classifyProxyError(new Error("Socks5 Authentication failed"))).toBe("PROXY_AUTH_FAILED");
    expect(classifyProxyError(new Error("read ECONNRESET"))).toBe("PROXY_UNREACHABLE");
    expect(classifyProxyError(new Error("connection refused"))).toBe("PROXY_UNREACHABLE");
    expect(classifyProxyError(new Error("self-signed certificate in certificate chain"))).toBe("PROXY_TLS_FAILED");
    expect(classifyProxyError(new Error("wrong version number"))).toBe("PROXY_TLS_FAILED");
  });

  it("errno 是数字时也能用", () => {
    expect(classifyProxyError({ errno: "ECONNREFUSED" })).toBe("PROXY_UNREACHABLE");
  });

  it("沿 cause 链找到最内层线索", () => {
    const inner = new Error("connect ECONNREFUSED 127.0.0.1:1");
    const outer = new TypeError("fetch failed");
    (outer as { cause?: unknown }).cause = inner;
    expect(classifyProxyError(outer)).toBe("PROXY_UNREACHABLE");
  });

  it("自己抛的 ProxyError 在链里时优先采用它的分类", () => {
    const own = new ProxyError("PROXY_AUTH_FAILED");
    const outer = new TypeError("fetch failed");
    (outer as { cause?: unknown }).cause = own;
    expect(classifyProxyError(outer)).toBe("PROXY_AUTH_FAILED");
  });

  it("★ 真实的 SocksClientError 形状（无 code 字段）", async () => {
    // 直接引 socks 库制造一个真实的错误对象，避免只测「我猜的形状」
    const { SocksClient } = await import("socks");
    let caught: unknown = null;
    try {
      await SocksClient.createConnection({
        // 端口 1 几乎肯定没人监听
        proxy: { host: "127.0.0.1", port: 1, type: 5 },
        command: "connect",
        destination: { host: "example.com", port: 443 },
        timeout: 2000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // 确认它真的没有 code（这正是当初漏掉的原因）
    expect((caught as { code?: string }).code).toBeUndefined();
    // 但仍必须被正确分类
    expect(classifyProxyError(caught)).toBe("PROXY_UNREACHABLE");
    expect(describeProxyError(caught)).toContain("ECONNREFUSED");
  }, 15_000);
});

describe("extractIp", () => {
  it("兼容 JSON 与纯文本", () => {
    expect(extractIp('{"ip":"1.2.3.4"}')).toBe("1.2.3.4");
    expect(extractIp("1.2.3.4\n")).toBe("1.2.3.4");
    expect(extractIp('{"origin":"5.6.7.8"}')).toBe("5.6.7.8");
    expect(extractIp("2001:db8::1")).toBe("2001:db8::1");
    expect(extractIp("not an ip")).toBeNull();
  });
});

/* ---------------- 真实 CONNECT 隧道 ---------------- */

/** 最小 HTTP CONNECT 代理；记录收到的 CONNECT 目标与认证头 */
function startConnectProxy(opts: { requireAuth?: { user: string; pass: string } } = {}) {
  const seen: { target: string; auth: string | undefined }[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });

  server.on("connect", (req, clientSocket, head) => {
    seen.push({ target: req.url ?? "", auth: req.headers["proxy-authorization"] });

    if (opts.requireAuth) {
      const expected = "Basic " + Buffer.from(`${opts.requireAuth.user}:${opts.requireAuth.pass}`).toString("base64");
      if (req.headers["proxy-authorization"] !== expected) {
        clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
        clientSocket.destroy();
        return;
      }
    }

    const [host, portStr] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(portStr), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  return { server, seen };
}

/** 一个只回 JSON 的目标服务器 */
function startTarget(payload: unknown) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return server;
}

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

describe("真实 CONNECT 隧道（end-to-end）", () => {
  let proxy: ReturnType<typeof startConnectProxy>;
  let proxyPort = 0;
  let target: http.Server;
  let targetPort = 0;

  beforeAll(async () => {
    proxy = startConnectProxy();
    proxyPort = await listen(proxy.server);
    target = startTarget({ hello: "via-proxy" });
    targetPort = await listen(target);
  });

  afterAll(async () => {
    await new Promise<void>((r) => proxy.server.close(() => r()));
    await new Promise<void>((r) => target.close(() => r()));
  });

  it("HTTP 代理：请求确实穿过隧道到达目标", async () => {
    const dispatcher = createProxyDispatcher({
      protocol: "http",
      host: "127.0.0.1",
      port: proxyPort,
      username: null,
      password: null,
    });
    expect(dispatcher).toBeDefined();

    const resp = await fetch(`http://127.0.0.1:${targetPort}/probe`, {
      dispatcher,
    } as RequestInit & { dispatcher: typeof dispatcher });
    const body = (await resp.json()) as { hello: string };

    expect(resp.status).toBe(200);
    expect(body.hello).toBe("via-proxy");
    // 关键：代理真的收到了 CONNECT，且目标是我们的 target
    expect(proxy.seen.length).toBeGreaterThan(0);
    expect(proxy.seen.at(-1)?.target).toBe(`127.0.0.1:${targetPort}`);

    await (dispatcher as unknown as { close: () => Promise<void> }).close();
  });

  it("带认证的代理：会带上 Proxy-Authorization 并可成功", async () => {
    const authProxy = startConnectProxy({ requireAuth: { user: "bob", pass: "s3cret" } });
    const authPort = await listen(authProxy.server);
    try {
      const dispatcher = createProxyDispatcher({
        protocol: "http",
        host: "127.0.0.1",
        port: authPort,
        username: "bob",
        password: "s3cret",
      });
      const resp = await fetch(`http://127.0.0.1:${targetPort}/auth`, {
        dispatcher,
      } as RequestInit & { dispatcher: typeof dispatcher });
      expect(resp.status).toBe(200);
      await resp.text();

      const expected = "Basic " + Buffer.from("bob:s3cret").toString("base64");
      expect(authProxy.seen.at(-1)?.auth).toBe(expected);
      await (dispatcher as unknown as { close: () => Promise<void> }).close();
    } finally {
      await new Promise<void>((r) => authProxy.server.close(() => r()));
    }
  });

  it("口令错误时失败（代理回 407）", async () => {
    const authProxy = startConnectProxy({ requireAuth: { user: "bob", pass: "s3cret" } });
    const authPort = await listen(authProxy.server);
    try {
      const dispatcher = createProxyDispatcher({
        protocol: "http",
        host: "127.0.0.1",
        port: authPort,
        username: "bob",
        password: "wrong",
      });
      await expect(
        fetch(`http://127.0.0.1:${targetPort}/nope`, {
          dispatcher,
        } as RequestInit & { dispatcher: typeof dispatcher }),
      ).rejects.toThrow();
      await (dispatcher as unknown as { close: () => Promise<void> }).close();
    } finally {
      await new Promise<void>((r) => authProxy.server.close(() => r()));
    }
  });

  it("代理端口不通时抛错（分类为不可达）", async () => {
    // 找一个几乎肯定没监听的端口
    const dispatcher = createProxyDispatcher({
      protocol: "http",
      host: "127.0.0.1",
      port: 1,
      username: null,
      password: null,
    });
    let caught: unknown = null;
    try {
      await fetch(`http://127.0.0.1:${targetPort}/x`, {
        dispatcher,
      } as RequestInit & { dispatcher: typeof dispatcher });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(classifyProxyError(caught)).toBe("PROXY_UNREACHABLE");
    // 错误文案要能说清确实是代理连不上，而不是一句 fetch failed
    expect(describeProxyError(caught)).not.toBe("fetch failed");
    await (dispatcher as unknown as { close: () => Promise<void> }).close();
  });

  it("checkProxy：不可达代理返回结构化失败结果", async () => {
    const outcome = await checkProxy(
      { protocol: "http", host: "127.0.0.1", port: 1, username: null, password: null },
      { probeUrl: `http://127.0.0.1:${targetPort}/probe`, timeoutMs: 4000 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe("PROXY_UNREACHABLE");
    expect(outcome.error).toBeTruthy();
    expect(outcome.latencyMs).toBeNull();
  });

  it("checkProxy：可达代理返回 ok + 延迟", async () => {
    const outcome = await checkProxy(
      { protocol: "http", host: "127.0.0.1", port: proxyPort, username: null, password: null },
      { probeUrl: `http://127.0.0.1:${targetPort}/probe`, timeoutMs: 8000 },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

/* ---------------- Dispatcher 持有者 ---------------- */

describe("ProxyDispatcherHolder", () => {
  it("无代理时 current 为 undefined", () => {
    const h = new ProxyDispatcherHolder();
    h.set(null);
    expect(h.current).toBeUndefined();
    expect(h.currentFingerprint).toBe("direct");
  });

  it("相同配置重复 set 不会重建", () => {
    const h = new ProxyDispatcherHolder();
    const cfg = { protocol: "http" as const, host: "127.0.0.1", port: 8080, username: null, password: null };
    expect(h.set(cfg)).toBe(true);
    expect(h.set({ ...cfg })).toBe(false);
    expect(h.rebuilds).toBe(1);
  });

  it("配置变化时重建并记录日志", () => {
    const logs: string[] = [];
    const h = new ProxyDispatcherHolder((m) => logs.push(m));
    const cfg = { protocol: "http" as const, host: "127.0.0.1", port: 8080, username: null, password: null };
    h.set(cfg);
    expect(h.set({ ...cfg, port: 9090 })).toBe(true);
    expect(h.rebuilds).toBe(2);
    expect(logs.some((l) => l.includes("切换"))).toBe(true);
  });

  it("从有代理切回直连会清空并关闭旧 Agent", async () => {
    const h = new ProxyDispatcherHolder();
    h.set({ protocol: "http", host: "127.0.0.1", port: 8080, username: null, password: null });
    expect(h.current).toBeDefined();
    expect(h.set(null)).toBe(true);
    expect(h.current).toBeUndefined();
    await h.close();
  });

  it("close 是幂等的", async () => {
    const h = new ProxyDispatcherHolder();
    await expect(h.close()).resolves.toBeUndefined();
    await expect(h.close()).resolves.toBeUndefined();
  });
});
