// REST 客户端
//
// 鉴权走 HttpOnly cookie（同源，无需手动带 token），因此 credentials: "include"。
// 错误统一抛 ApiError，页面按 err.status / err.code 分支。
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  /** 未审批 / 未授权 */
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

type ReqOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** 查询参数，undefined / "" 会被丢弃 */
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
};

function buildUrl(path: string, query?: ReqOptions["query"]): string {
  if (!query) return path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(path: string, opts: ReqOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let resp: Response;
  try {
    resp = await fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: "include",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", "网络不可达：请确认服务是否在运行。");
  }

  // 204 / 空响应
  const text = await resp.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!resp.ok) {
    const e = data as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      resp.status,
      e?.error?.code ?? "ERROR",
      e?.error?.message ?? `请求失败（HTTP ${resp.status}）`,
      e?.error?.details,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: ReqOptions["query"], signal?: AbortSignal) =>
    request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export { request };
