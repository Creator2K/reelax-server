// 受管定时器：账号停止时统一清理，避免定时任务泄漏
//
// 与旧引擎的 ctx.every / ctx.schedule 语义一致：异步错误自动捕获，
// 不让一个定时任务的异常把整个账号运行时打挂。

export type ManagedTimerKind = "interval" | "timeout";

export type ManagedTimer = {
  kind: ManagedTimerKind;
  handle: NodeJS.Timeout;
};

export class TimerPool {
  private timers = new Set<ManagedTimer>();
  private onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void = () => {}) {
    this.onError = onError;
  }

  every(ms: number, fn: () => unknown | Promise<unknown>): NodeJS.Timeout {
    const handle = setInterval(() => {
      this.invoke(fn);
    }, Math.max(1, ms));
    const t: ManagedTimer = { kind: "interval", handle };
    this.timers.add(t);
    return handle;
  }

  schedule(ms: number, fn: () => unknown | Promise<unknown>): NodeJS.Timeout {
    const handle = setTimeout(() => {
      for (const t of this.timers) {
        if (t.handle === handle) this.timers.delete(t);
      }
      this.invoke(fn);
    }, Math.max(0, ms));
    this.timers.add({ kind: "timeout", handle });
    return handle;
  }

  /** 立即执行一次，并吞掉异步异常（用于「启动检查」这类一次性任务） */
  private invoke(fn: () => unknown | Promise<unknown>): void {
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch((err) => this.onError(err));
      }
    } catch (err) {
      this.onError(err);
    }
  }

  clear(): void {
    for (const t of this.timers) {
      if (t.kind === "interval") clearInterval(t.handle);
      else clearTimeout(t.handle);
    }
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }
}

/**
 * TTL 缓存：避免高频重复拉取展示数据（地图表 5 分钟、鱼饵 90 秒）
 * `get(loader)` 在缓存有效时返回缓存，否则调用 loader 并缓存。
 */
export class TtlCache<T> {
  private value: T | null = null;
  private at = 0;
  private loading: Promise<T> | null = null;
  private ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  peek(): T | null {
    return this.value;
  }

  ageMs(now = Date.now()): number {
    return this.at === 0 ? Number.POSITIVE_INFINITY : now - this.at;
  }

  async get(loader: () => Promise<T>, force = false, now = Date.now()): Promise<T> {
    if (!force && this.value !== null && now - this.at < this.ttlMs) return this.value;
    // 并发合并：同一时刻多个调用只发一次请求
    if (this.loading) return this.loading;
    this.loading = loader()
      .then((v) => {
        this.value = v;
        this.at = Date.now();
        return v;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  invalidate(): void {
    this.value = null;
    this.at = 0;
  }
}
