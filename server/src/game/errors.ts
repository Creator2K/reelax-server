// 错误类型与错误码
//
// 全部错误码集中在这里：模块靠 code 分支，UI 靠 code 加中文文案，
// 避免在代码里散落字符串比较。

export const GAME_ERROR_CODES = {
  /** 缺少登录凭证 */
  NO_CREDENTIALS: "NO_CREDENTIALS",
  /** 网络不可达 */
  NETWORK: "NETWORK",
  /** 会话失效且无法自动重登（Cookie 过期） */
  SESSION_EXPIRED: "SESSION_EXPIRED",
  /** 连接超时（代理或游戏侧） */
  TIMEOUT: "TIMEOUT",
  /** 游戏侧限流 */
  RATE_LIMITED: "RATE_LIMITED",
  /** 代理问题（细分见 PROXY_*） */
  PROXY: "PROXY",
  /** 服务端返回的业务错误 */
  GAME_ERROR: "GAME_ERROR",
} as const;

export type GameErrorCode = (typeof GAME_ERROR_CODES)[keyof typeof GAME_ERROR_CODES];

export class GameClientError extends Error {
  readonly status: number;
  readonly code: string;
  /** 原始响应（调试用，注意可能含敏感信息，不要直接回给前端） */
  readonly payload?: unknown;

  constructor(message: string, opts: { status?: number; code?: string; payload?: unknown } = {}) {
    super(message);
    this.name = "GameClientError";
    this.status = opts.status ?? 0;
    this.code = opts.code ?? GAME_ERROR_CODES.GAME_ERROR;
    this.payload = opts.payload;
  }

  /**
   * 会话类错误：引擎应挂起等待用户处理，而不是继续退避重试。
   *
   * 注意要同时认 REQUEST_SIGNATURE_INVALID —— 重试已用尽的签名失败就是「这个会话没救了」，
   * 它的 HTTP 状态也是 403（见 client.ts 的重试逻辑）。
   */
  get isSessionFatal(): boolean {
    return (
      this.code === GAME_ERROR_CODES.SESSION_EXPIRED ||
      this.code === GAME_ERROR_CODES.NO_CREDENTIALS ||
      this.code === "REQUEST_SIGNATURE_INVALID" ||
      this.status === 401
    );
  }

  /** 值得退避重试的临时错误 */
  get isRetryable(): boolean {
    return (
      this.code === GAME_ERROR_CODES.NETWORK ||
      this.code === GAME_ERROR_CODES.TIMEOUT ||
      this.status === 429 ||
      this.status >= 500
    );
  }

  /** 是否需要重建会话（proof 过期 / Cookie 失效） */
  get isAuthIssue(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** 把 HTTP 状态码映射成更具体的错误码 */
export function codeForStatus(status: number, serverCode?: string): string {
  if (serverCode) return serverCode;
  if (status === 401 || status === 403) return GAME_ERROR_CODES.SESSION_EXPIRED;
  if (status === 429) return GAME_ERROR_CODES.RATE_LIMITED;
  if (status >= 500) return GAME_ERROR_CODES.NETWORK;
  return GAME_ERROR_CODES.GAME_ERROR;
}

/** 判断响应体是否「签名/会话」类问题（用于触发续期重试） */
export function looksLikeSignatureIssue(status: number, bodyText: string, message: string): boolean {
  if (status === 401 || status === 403) return true;
  if (/SIGNATURE/i.test(bodyText)) return true;
  if (/签名/.test(message)) return true;
  return false;
}
