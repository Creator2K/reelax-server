// 限流：固定窗口计数器（进程内存）
//
// 为什么用内存而不是数据库：登录/注册限流是「防爆破」的第一道闸，
// 进程重启丢掉计数完全可以接受（重启本身就把攻击节奏打断了）。
// 多实例部署时它是按实例计数的 —— 本项目是单进程常驻服务，符合预期。
export type RateLimitRule = {
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 窗口内允许的最大次数 */
  max: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** 剩余可用次数（含本次） */
  remaining: number;
  /** 距离窗口重置的毫秒数（被拒时用于 Retry-After） */
  retryAfterMs: number;
};

type Bucket = { count: number; resetAt: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;
  private rule: RateLimitRule;

  constructor(rule: RateLimitRule) {
    this.rule = rule;
  }

  /** 记录一次尝试并返回判定结果 */
  hit(key: string, at = Date.now()): RateLimitResult {
    this.maybeSweep(at);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= at) {
      this.buckets.set(key, { count: 1, resetAt: at + this.rule.windowMs });
      return { allowed: true, remaining: this.rule.max - 1, retryAfterMs: 0 };
    }
    if (b.count >= this.rule.max) {
      return { allowed: false, remaining: 0, retryAfterMs: b.resetAt - at };
    }
    b.count += 1;
    return { allowed: true, remaining: this.rule.max - b.count, retryAfterMs: 0 };
  }

  /** 只查询不计数（用于 UI 提示还剩几次） */
  peek(key: string, at = Date.now()): RateLimitResult {
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= at) return { allowed: true, remaining: this.rule.max, retryAfterMs: 0 };
    const remaining = Math.max(0, this.rule.max - b.count);
    return { allowed: remaining > 0, remaining, retryAfterMs: Math.max(0, b.resetAt - at) };
  }

  /** 成功后清空（例如登录成功就清掉失败计数，不惩罚正常用户） */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 立即封禁：把计数推到上限 */
  block(key: string, at = Date.now()): void {
    this.buckets.set(key, { count: this.rule.max, resetAt: at + this.rule.windowMs });
  }

  private maybeSweep(at: number): void {
    // 每 5 分钟扫一次过期桶，避免内存无界增长
    if (at - this.lastSweep < 5 * 60_000) return;
    this.lastSweep = at;
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= at) this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }
}

/**
 * 一组限流器（登录、注册、代理测试等）。
 * 便于集中配置与在测试里重置。
 */
export class Limiters {
  /** 登录失败：按 IP+邮箱，5 次 / 15 分钟 */
  login: RateLimiter;
  /** 登录失败：按 IP，20 次 / 15 分钟（防止换邮箱刷） */
  loginByIp: RateLimiter;
  /** 注册：按 IP，5 次 / 小时 */
  register: RateLimiter;
  /** 邀请码尝试：按 IP，10 次 / 小时（防止暴力猜码） */
  inviteGuess: RateLimiter;
  /** 代理连通性测试：按用户，10 次 / 分钟（防止拿它做端口扫描） */
  proxyTest: RateLimiter;
  /** 改口令：按用户，5 次 / 小时 */
  passwordChange: RateLimiter;

  constructor() {
    this.login = new RateLimiter({ windowMs: 15 * 60_000, max: 5 });
    this.loginByIp = new RateLimiter({ windowMs: 15 * 60_000, max: 20 });
    this.register = new RateLimiter({ windowMs: 60 * 60_000, max: 5 });
    this.inviteGuess = new RateLimiter({ windowMs: 60 * 60_000, max: 10 });
    this.proxyTest = new RateLimiter({ windowMs: 60_000, max: 10 });
    this.passwordChange = new RateLimiter({ windowMs: 60 * 60_000, max: 5 });
  }

  clear(): void {
    for (const l of Object.values(this)) {
      if (l instanceof RateLimiter) l.clear();
    }
  }
}

/** 从请求里取客户端 IP（trust proxy 已由 Express 处理） */
export function clientIp(req: {
  ip?: string;
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/** 秒级 Retry-After 头 */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
