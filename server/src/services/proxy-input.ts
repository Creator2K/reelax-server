// 代理输入解析与校验
//
// 独立成模块（而不是挂在 AccountService 上）：路由层要用它，但它是纯函数，
// 不该因此把整个 AccountService 拖进依赖图。
import { HttpError } from "../api/server.ts";
import { parseProxyUrl } from "../game/proxy.ts";

export type ProxyProtocol = "http" | "https" | "socks5";

export type ParsedProxyInput = {
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};

export type ProxyInputShape = {
  label?: string;
  /** 粘贴整串：http://user:pass@host:port / socks5://host:port / host:port */
  url?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
};

/**
 * 解析代理输入。优先用 url 形式（用户从机场面板复制的就是整串），
 * 否则用分字段形式。
 */
export function parseProxyInput(input: ProxyInputShape): ParsedProxyInput {
  if (input.url && input.url.trim()) {
    const parsed = parseProxyUrl(input.url);
    if (!parsed.ok) throw new HttpError(400, "INVALID_PROXY", parsed.message);
    const c = parsed.config;
    return {
      label: (input.label ?? "").trim() || `${c.protocol}://${c.host}:${c.port}`,
      protocol: c.protocol,
      host: c.host,
      port: c.port,
      username: c.username ?? null,
      password: c.password ?? null,
    };
  }

  const protocol = String(input.protocol ?? "http").toLowerCase();
  if (protocol !== "http" && protocol !== "https" && protocol !== "socks5") {
    throw new HttpError(400, "INVALID_PROXY", "代理协议必须是 http / https / socks5");
  }

  const host = (input.host ?? "").trim();
  if (!host) throw new HttpError(400, "INVALID_PROXY", "代理主机不能为空");
  if (host.length > 255) throw new HttpError(400, "INVALID_PROXY", "代理主机名过长");

  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, "INVALID_PROXY", "代理端口不合法（1~65535）");
  }

  const username = (input.username ?? "").trim() || null;
  const password = input.password ? input.password : null;
  if (password && !username) throw new HttpError(400, "INVALID_PROXY", "填了口令就必须填用户名");

  return {
    label: (input.label ?? "").trim() || `${protocol}://${host}:${port}`,
    protocol: protocol as ProxyProtocol,
    host,
    port,
    username,
    password,
  };
}

/** 校验并归一游戏 baseUrl（只保留 origin） */
export function parseBaseUrl(value: string | undefined, fallback = "https://reelax.cn"): string {
  const raw = (value ?? "").trim();
  if (!raw) return fallback;
  try {
    return new URL(raw).origin;
  } catch {
    throw new HttpError(400, "INVALID_BASE_URL", "游戏地址不是合法 URL");
  }
}
