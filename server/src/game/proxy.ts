// 代理：解析、Agent 构造、连通性探测、失败分类
//
// 设计要点：
//  1) **不改调用点**：所有游戏请求都通过 undici 的 dispatcher 走代理，
//     game/client.ts 里没有一处 `if (proxy)` 分支。
//  2) **每账号一个 Agent**：不同账号的代理互不串用，连接池也不共享。
//  3) 代理变更时重建 Agent，下一个请求立即生效（不需要重启账号）。
//  4) 失败要分类：用户需要知道「是代理坏了」还是「游戏侧问题」，否则没法排查。
import net from "node:net";
import tls from "node:tls";
import { Agent, type Dispatcher } from "undici";
import { SocksClient } from "socks";

export type ProxyProtocol = "http" | "https" | "socks5";

export type ProxyConfig = {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
};

/* ---------- 失败分类 ---------- */

export const PROXY_ERROR_CODES = [
  "PROXY_CONNECT_TIMEOUT",
  "PROXY_AUTH_FAILED",
  "PROXY_DNS_FAILED",
  "PROXY_TLS_FAILED",
  "PROXY_UNREACHABLE",
  "PROXY_BAD_CONFIG",
  "PROXY_ERROR",
] as const;

export type ProxyErrorCode = (typeof PROXY_ERROR_CODES)[number];

const PROXY_ERROR_MESSAGES: Record<ProxyErrorCode, string> = {
  PROXY_CONNECT_TIMEOUT: "连接代理超时：代理地址/端口不对，或代理未启动",
  PROXY_AUTH_FAILED: "代理认证失败：用户名或密码不正确",
  PROXY_DNS_FAILED: "DNS 解析失败：代理主机名拼写错误或本地 DNS 不可用",
  PROXY_TLS_FAILED: "TLS 握手失败：该端口可能不是 HTTPS 代理（试试 http 或 socks5）",
  PROXY_UNREACHABLE: "无法连接到代理：网络不通或代理拒绝连接",
  PROXY_BAD_CONFIG: "代理配置不合法",
  PROXY_ERROR: "代理连接出错",
};

export class ProxyError extends Error {
  readonly code: ProxyErrorCode;

  constructor(code: ProxyErrorCode, detail?: string) {
    super(detail ? `${PROXY_ERROR_MESSAGES[code]}（${detail}）` : PROXY_ERROR_MESSAGES[code]);
    this.name = "ProxyError";
    this.code = code;
  }

  static messageFor(code: ProxyErrorCode): string {
    return PROXY_ERROR_MESSAGES[code];
  }
}

/**
 * 把底层错误归类成可读的代理错误码。
 *
 * 关键点（真实踩过）：
 *  - undici 会把连接错误包成 `TypeError: fetch failed`，真实原因在 `.cause` 链上
 *  - 我们自己抛的 ProxyError 也会被包在链里 → 要先沿链找它
 *  - **`socks` 库抛的 `SocksClientError` 没有 `code` 字段**，只有一个
 *    message，如 "connect ECONNREFUSED 127.0.0.1:1080"。
 *    所以除了看 `code`，还必须匹配 message 文本，否则 SOCKS5 的失败会全部
 *    退化成笼统的 PROXY_ERROR（用户看不出是「代理没开」还是「密码错了」）。
 */
export function classifyProxyError(err: unknown): ProxyErrorCode {
  const chain = [...walkCauses(err)];

  // 1) 自己抛的 ProxyError 优先（分类最准确）
  for (const e of chain) {
    if (e instanceof ProxyError) return e.code;
  }

  // 2) 沿链找 code 或 message 里的线索（从最深层往外）
  for (const e of chain.reverse()) {
    const cast = e as { code?: string; message?: string; statusCode?: number; errno?: number | string };
    const code = String(cast?.code ?? cast?.errno ?? "").toUpperCase();
    const msg = String(cast?.message ?? "").toLowerCase();

    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || msg.includes("getaddrinfo") || msg.includes("enotfound")) {
      return "PROXY_DNS_FAILED";
    }
    if (
      code === "ETIMEDOUT" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      msg.includes("timeout") ||
      msg.includes("etimedout") ||
      msg.includes("timed out")
    ) {
      return "PROXY_CONNECT_TIMEOUT";
    }
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH" ||
      code === "EPIPE" ||
      // socks 库把 errno 塞进 message 文本里，没有 code
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("ehostunreach") ||
      msg.includes("enetunreach") ||
      msg.includes("refused") // "connection refused" 之类的英文描述
    ) {
      return "PROXY_UNREACHABLE";
    }
    if (
      cast?.statusCode === 407 ||
      msg.includes("407") ||
      msg.includes("proxy authentication") ||
      msg.includes("authentication failed") ||
      msg.includes("auth failed")
    ) {
      return "PROXY_AUTH_FAILED";
    }
    if (
      msg.includes("certificate") ||
      msg.includes("self signed") ||
      msg.includes("self-signed") ||
      msg.includes("tls") ||
      msg.includes("ssl") ||
      msg.includes("wrong version number")
    ) {
      return "PROXY_TLS_FAILED";
    }
  }
  return "PROXY_ERROR";
}

/** 沿 .cause 链收集错误（含自身），最多 6 层防止环 */
function* walkCauses(err: unknown): Generator<unknown> {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur != null; i++) {
    yield cur;
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
}

/** 从错误链里取一段人类可读的原因文本（用于 UI 展示） */
export function describeProxyError(err: unknown): string {
  if (err instanceof ProxyError) return err.message;
  for (const e of walkCauses(err)) {
    if (e instanceof ProxyError) return e.message;
  }
  const deepest = [...walkCauses(err)].reverse();
  for (const e of deepest) {
    const msg = (e as { message?: string }).message;
    if (msg && msg !== "fetch failed") return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

/* ---------- 解析 ---------- */

export type ParseResult = { ok: true; config: ProxyConfig } | { ok: false; message: string };

/**
 * 解析多种写法：
 *   host:port
 *   http://host:port
 *   https://user:pass@host:port
 *   socks5://user:pass@host:port
 *   socks5h://host:port   （h = 由代理做远程 DNS，本项目等价处理）
 */
export function parseProxyUrl(input: string): ParseResult {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, message: "代理地址为空" };

  let protocol: ProxyProtocol = "http";
  let rest = raw;

  const schemeMatch = raw.match(/^([a-z0-9+.-]+):\/\//i);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    rest = raw.slice(schemeMatch[0].length);
    if (scheme === "http") protocol = "http";
    else if (scheme === "https") protocol = "https";
    else if (scheme === "socks5" || scheme === "socks5h" || scheme === "socks") protocol = "socks5";
    else return { ok: false, message: `不支持的代理协议：${scheme}（支持 http / https / socks5）` };
  }

  // 从右侧切出 host:port，避免 IPv6 字面量里的冒号干扰
  let credentialPart = "";
  let hostPort = rest;
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    credentialPart = rest.slice(0, at);
    hostPort = rest.slice(at + 1);
  }

  let host: string;
  let portStr: string;

  if (hostPort.startsWith("[")) {
    // [::1]:1080
    const end = hostPort.indexOf("]");
    if (end < 0) return { ok: false, message: "IPv6 地址缺少右中括号" };
    host = hostPort.slice(1, end);
    const after = hostPort.slice(end + 1);
    if (!after.startsWith(":")) return { ok: false, message: "缺少端口" };
    portStr = after.slice(1);
  } else {
    const idx = hostPort.lastIndexOf(":");
    if (idx <= 0) return { ok: false, message: "缺少端口，格式应为 host:port" };
    host = hostPort.slice(0, idx);
    portStr = hostPort.slice(idx + 1);
  }

  host = host.trim();
  if (!host) return { ok: false, message: "主机名为空" };

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: `端口不合法：${portStr}` };
  }

  let username: string | null = null;
  let password: string | null = null;
  if (credentialPart) {
    const sep = credentialPart.indexOf(":");
    if (sep < 0) {
      username = safeDecode(credentialPart);
    } else {
      username = safeDecode(credentialPart.slice(0, sep));
      password = safeDecode(credentialPart.slice(sep + 1));
    }
    if (username === "") username = null;
  }

  if (password && !username) return { ok: false, message: "只填了密码没填用户名" };

  return { ok: true, config: { protocol, host, port, username, password } };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 转成展示用的字符串（不含密码） */
export function formatProxy(config: ProxyConfig): string {
  return `${config.protocol}://${config.host}:${config.port}`;
}

/** 代理唯一标识：配置变化时用于判断是否需要重建 Agent */
export function proxyFingerprint(config: ProxyConfig | null): string {
  if (!config) return "direct";
  return `${config.protocol}://${config.host}:${config.port}:${config.username ?? ""}`;
}

/* ---------- Agent 构造 ---------- */

export type ProxyConnectOptions = {
  /**
   * 目标主机。
   * ★ undici v7 传进来的 host **已经带端口**（如 "127.0.0.1:443"），
   *   同时还会单独给一个 port。直接 `${host}:${port}` 会拼成 "127.0.0.1:443:443"。
   *   用 connectTarget() 统一处理。
   */
  host: string;
  port: string | number;
  timeout?: number;
  /** 目标是否 TLS（https 目标为 true） */
  tls: boolean;
  servername?: string;
  alpnProtocols?: string[];
  signal?: AbortSignal;
};

/**
 * 把 undici 给的 host/port 归一成 "host:port"。
 * 兼容三种形态：
 *   host="1.2.3.4:443", port="443"   → "1.2.3.4:443"（undici v7 的实际形态）
 *   host="1.2.3.4",     port="443"   → "1.2.3.4:443"
 *   host="::1",         port="443"   → "[::1]:443"
 */
export function connectTarget(host: string, port: string | number): string {
  const raw = String(host);
  const p = String(port);

  // 裸 IPv6（多于一个冒号且没有中括号）→ 补括号
  if (!raw.startsWith("[") && (raw.match(/:/g)?.length ?? 0) > 1) {
    return `[${raw}]:${p}`;
  }
  // 带中括号但没写端口
  if (raw.startsWith("[") && !raw.includes("]:")) {
    return `${raw}:${p}`;
  }
  // 已经是 host:port 形态
  const lastColon = raw.lastIndexOf(":");
  if (lastColon > 0) {
    const tail = raw.slice(lastColon + 1);
    if (/^\d+$/.test(tail)) return raw;
  }
  return `${raw}:${p}`;
}

/** 从 connect 选项里取出纯净的目标主机名（用于 TLS SNI） */
export function connectHostname(host: string): string {
  const raw = String(host);
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw;
  }
  // 裸 IPv6：整体就是主机名
  if ((raw.match(/:/g)?.length ?? 0) > 1) return raw;
  const lastColon = raw.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(raw.slice(lastColon + 1))) return raw.slice(0, lastColon);
  return raw;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * HTTP/HTTPS 代理：用 CONNECT 隧道。
 * - 代理本身是 https 时，先与代理做 TLS 再发 CONNECT
 * - 隧道建立后，若目标是 https 再在隧道上做 TLS（ALPN、SNI 都要传下去）
 */
function makeHttpProxyConnect(config: ProxyConfig) {
  const authHeader =
    config.username != null
      ? `Proxy-Authorization: Basic ${Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64")}\r\n`
      : "";
  const proxyIsTls = config.protocol === "https";

  return function connect(options: ProxyConnectOptions, callback: (err: Error | null, socket?: net.Socket) => void): void {
    const timeout = options.timeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let settled = false;
    let socket: net.Socket | null = null;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* 忽略 */
      }
      callback(err);
    };

    const onAbort = () => fail(new ProxyError("PROXY_UNREACHABLE", "请求已取消"));
    if (options.signal) {
      if (options.signal.aborted) return onAbort();
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (sock: net.Socket) => {
      if (settled) {
        sock.destroy();
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      callback(null, sock);
    };

    /** 隧道建好后，按目标协议决定是否再套 TLS（与 SOCKS5 路径共用 maybeWrapTls） */
    const afterTunnel = (raw: net.Socket) => {
      raw.setNoDelay(true);
      maybeWrapTls(raw, options, (err, sock) => {
        if (err || !sock) {
          fail(err ?? new ProxyError("PROXY_ERROR", "未能建立连接"));
          return;
        }
        finish(sock);
      }, timeout);
    };

    /** 发送 CONNECT 并解析响应头 */
    const sendConnect = (transport: net.Socket) => {
      transport.setTimeout(timeout, () => fail(new ProxyError("PROXY_CONNECT_TIMEOUT")));
      transport.once("error", (err) => fail(new ProxyError(classifyProxyError(err), err.message)));
      transport.once("close", () => fail(new ProxyError("PROXY_UNREACHABLE", "代理提前关闭了连接")));

      const target = connectTarget(options.host, options.port);
      transport.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authHeader}Proxy-Connection: keep-alive\r\n\r\n`,
      );

      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          if (buffer.length > 16 * 1024) fail(new ProxyError("PROXY_ERROR", "CONNECT 响应头过长"));
          return;
        }
        transport.off("data", onData);
        transport.setTimeout(0);
        transport.removeAllListeners("close");

        const head = buffer.subarray(0, headerEnd).toString("latin1");
        const statusLine = head.split("\r\n")[0] ?? "";
        const status = Number(statusLine.split(" ")[1]);

        if (status === 407) {
          fail(new ProxyError("PROXY_AUTH_FAILED"));
          return;
        }
        if (!Number.isFinite(status) || status < 200 || status >= 300) {
          fail(new ProxyError("PROXY_UNREACHABLE", `代理返回 ${statusLine || "无状态码"}`));
          return;
        }

        // CONNECT 响应之后可能已经跟着目标数据，这些字节要交还给上层
        const rest = buffer.subarray(headerEnd + 4);
        if (rest.length) transport.unshift(rest);
        afterTunnel(transport);
      };

      transport.on("data", onData);
    };

    // 先连代理
    if (proxyIsTls) {
      const proxyTls = tls.connect({ host: config.host, port: config.port, servername: config.host });
      socket = proxyTls;
      proxyTls.setTimeout(timeout, () => fail(new ProxyError("PROXY_CONNECT_TIMEOUT")));
      proxyTls.once("secureConnect", () => {
        proxyTls.setTimeout(0);
        sendConnect(proxyTls);
      });
      proxyTls.once("error", (err) => fail(new ProxyError(classifyProxyError(err), err.message)));
    } else {
      const plain = net.connect({ host: config.host, port: config.port });
      socket = plain;
      plain.setTimeout(timeout, () => fail(new ProxyError("PROXY_CONNECT_TIMEOUT")));
      plain.once("connect", () => {
        plain.setTimeout(0);
        sendConnect(plain);
      });
      plain.once("error", (err) => fail(new ProxyError(classifyProxyError(err), err.message)));
    }
  };
}

/** SOCKS5：直接用 socks 的 SocksClient（socks-proxy-agent v8 只适配 http.Agent，不能给 undici 用） */
function makeSocksConnect(config: ProxyConfig) {
  return function connect(opts: ProxyConnectOptions, callback: (err: Error | null, socket?: net.Socket) => void): void {
    const timeout = opts.timeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const targetHost = connectHostname(opts.host);

    SocksClient.createConnection({
      proxy: {
        host: config.host,
        port: config.port,
        type: 5,
        ...(config.username ? { userId: config.username } : {}),
        ...(config.password ? { password: config.password } : {}),
      },
      command: "connect",
      destination: { host: targetHost, port: Number(opts.port) },
      timeout,
    })
      .then(({ socket }) => {
        if (opts.signal?.aborted) {
          socket.destroy();
          callback(new ProxyError("PROXY_UNREACHABLE", "请求已取消"));
          return;
        }
        socket.setNoDelay(true);
        maybeWrapTls(socket, opts, callback, timeout);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // socks 把认证失败报成 "Socks5 Authentication failed"
        if (/auth/i.test(msg)) {
          callback(new ProxyError("PROXY_AUTH_FAILED", msg));
          return;
        }
        callback(new ProxyError(classifyProxyError(err), msg));
      });
  };
}

/**
 * 目标是 https 时，在已建立的隧道套接字上再做一次 TLS 握手。
 * HTTP CONNECT 与 SOCKS5 两条路径共用，避免 ALPN / SNI 处理写两遍。
 */
function maybeWrapTls(
  raw: net.Socket,
  opts: ProxyConnectOptions,
  callback: (err: Error | null, socket?: net.Socket) => void,
  timeout: number,
): void {
  if (!opts.tls) {
    callback(null, raw);
    return;
  }

  const tlsSocket = tls.connect({
    socket: raw,
    servername: opts.servername ?? connectHostname(opts.host),
    ALPNProtocols: opts.alpnProtocols ?? ["http/1.1"],
  });

  let settled = false;
  const onSecure = () => {
    if (settled) return;
    settled = true;
    tlsSocket.setTimeout(0);
    callback(null, tlsSocket);
  };
  const onError = (err: Error) => {
    if (settled) return;
    settled = true;
    try {
      tlsSocket.destroy();
      raw.destroy();
    } catch {
      /* 忽略 */
    }
    callback(new ProxyError("PROXY_TLS_FAILED", err.message));
  };

  tlsSocket.once("secureConnect", onSecure);
  tlsSocket.once("error", onError);
  tlsSocket.setTimeout(timeout, () => onError(new Error("TLS 握手超时")));
}

/**
 * 按代理配置造一个 dispatcher。
 * 无代理时返回 undefined —— 调用方此时应使用全局默认 dispatcher（直连）。
 */
export function createProxyDispatcher(config: ProxyConfig | null): Dispatcher | undefined {
  if (!config) return undefined;

  const connect = config.protocol === "socks5" ? makeSocksConnect(config) : makeHttpProxyConnect(config);

  // undici 的 Agent 在运行时支持 `connect` 工厂，但类型定义里没有 —— 走 unknown 绕过
  const options = {
    connect,
    pipelining: 1,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
    connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
  } as unknown as ConstructorParameters<typeof Agent>[0];

  return new Agent(options);
}

/**
 * 每账号的 dispatcher 持有者。
 *
 * 为什么按账号缓存：不同账号可能有不同代理，连接池不能共享；
 * 同时代理没变时不该每次请求都新建 Agent（会耗尽 fd）。
 *
 * 代理变更 → `set()` 检测到指纹变了就重建，并销毁旧 Agent 的连接池，
 * 下一个请求立即走新代理（不需要重启账号）。
 */
export class ProxyDispatcherHolder {
  private dispatcher: Dispatcher | undefined;
  private fingerprint = "direct";
  private rebuiltCount = 0;
  private log: ((msg: string) => void) | undefined;

  constructor(log?: (msg: string) => void) {
    this.log = log;
  }

  /** 更新代理配置。返回是否发生了重建。 */
  set(config: ProxyConfig | null): boolean {
    const next = proxyFingerprint(config);
    if (next === this.fingerprint && this.dispatcher !== undefined) return false;
    if (next === this.fingerprint && !config) return false;

    const previous = this.dispatcher;
    this.fingerprint = next;

    if (!config) {
      this.dispatcher = undefined;
    } else {
      this.dispatcher = createProxyDispatcher(config);
    }

    // 异步销毁旧连接池，不阻塞当前请求
    if (previous) {
      void (previous as unknown as { close?: () => Promise<void> }).close?.().catch(() => {});
    }
    this.rebuiltCount++;
    this.log?.(`代理已${previous ? "切换" : "启用"}：${next}`);
    return true;
  }

  get current(): Dispatcher | undefined {
    return this.dispatcher;
  }

  get currentFingerprint(): string {
    return this.fingerprint;
  }

  get rebuilds(): number {
    return this.rebuiltCount;
  }

  async close(): Promise<void> {
    const d = this.dispatcher;
    this.dispatcher = undefined;
    if (d) await (d as unknown as { close?: () => Promise<void> }).close?.().catch(() => {});
  }
}

/* ---------- 连通性探测 ---------- */

export type ProxyCheckOutcome = {
  ok: boolean;
  latencyMs: number | null;
  exitIp: string | null;
  status: number | null;
  errorCode: ProxyErrorCode | null;
  error: string | null;
};

/**
 * 探测代理连通性。
 *  - 先经代理请求一个轻量端点（默认游戏的 /api/meta/frontend-release，免签名）
 *  - 再（可选）经代理请求出口 IP 回显服务
 *
 * 注意：出口 IP 只在国内可用的回显服务上取，且只在用户主动点「测试」时发起，
 * 不会在后台定时探测 —— 避免把服务器自身 IP 泄漏给第三方。
 */
export async function checkProxy(config: ProxyConfig, opts: {
  probeUrl: string;
  echoUrl?: string;
  timeoutMs?: number;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
}): Promise<ProxyCheckOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  let dispatcher: Dispatcher | undefined;
  try {
    dispatcher = createProxyDispatcher(config);
  } catch (err) {
    return {
      ok: false,
      latencyMs: null,
      exitIp: null,
      status: null,
      errorCode: "PROXY_BAD_CONFIG",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const started = Date.now();
  try {
    const resp = await doFetch(opts.probeUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: Dispatcher });

    const latencyMs = Date.now() - started;
    if (!resp.ok) {
      return {
        ok: false,
        latencyMs,
        exitIp: null,
        status: resp.status,
        errorCode: "PROXY_ERROR",
        error: `经代理请求返回 HTTP ${resp.status}`,
      };
    }
    // 读掉响应体，避免连接悬挂
    await resp.text().catch(() => "");

    let exitIp: string | null = null;
    if (opts.echoUrl) {
      try {
        const echoResp = await doFetch(opts.echoUrl, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs),
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit & { dispatcher?: Dispatcher });
        if (echoResp.ok) {
          const text = (await echoResp.text()).trim();
          exitIp = extractIp(text);
        }
      } catch {
        /* 出口 IP 拿不到不算测试失败（回显服务可能被墙） */
      }
    }

    return { ok: true, latencyMs, exitIp, status: resp.status, errorCode: null, error: null };
  } catch (err) {
    // 自定义 connect 抛出的 ProxyError 会被 undici 包在 cause 链里，
    // classifyProxyError / describeProxyError 会沿链找到它
    return {
      ok: false,
      latencyMs: null,
      exitIp: null,
      status: null,
      errorCode: classifyProxyError(err),
      error: describeProxyError(err),
    };
  } finally {
    // Agent 用完要关，否则会留下活动的套接字
    if (dispatcher && "close" in dispatcher) {
      void (dispatcher as unknown as { close: () => Promise<void> }).close().catch(() => {});
    }
  }
}

/** 从回显服务的响应里抠出 IP（兼容纯文本与 JSON 两种） */
export function extractIp(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // JSON: {"ip":"1.2.3.4"}
  const jsonMatch = trimmed.match(/"ip"\s*:\s*"([^"]+)"/i);
  if (jsonMatch?.[1]) return jsonMatch[1];
  // 纯文本
  const v4 = trimmed.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  if (v4?.[1]) return v4[1];
  const v6 = trimmed.match(/\b([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})\b/i);
  if (v6?.[1]) return v6[1];
  return null;
}

/** 从环境变量解析全局兜底代理（没有则返回 null） */
export function parseGlobalProxy(value: string): ProxyConfig | null {
  const raw = value.trim();
  if (!raw) return null;
  const parsed = parseProxyUrl(raw);
  return parsed.ok ? parsed.config : null;
}
