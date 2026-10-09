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
 * 简单串行任务队列：保证同一账号的定时任务不会重入
 * （旧引擎用 `ctx.state.running` 手写这个判断，多个模块各写一遍，容易漏）
 */
export class SerialRunner {
  private running = false;
  private onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void = () => {}) {
    this.onError = onError;
  }

  get isRunning(): boolean {
    return this.running;
  }

  run(task: () => unknown | Promise<unknown>): boolean {
    if (this.running) return false;
    this.running = true;
    void Promise.resolve()
      .then(task)
      .catch((err) => this.onError(err))
      .finally(() => {
        this.running = false;
      });
    return true;
  }
}

/** 按间隔节流：距上次执行不足 intervalMs 则跳过 */
export class Throttle {
  private lastAt = 0;
  private intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  /** 返回 true 表示允许执行（并记录时间） */
  tryPass(now = Date.now()): boolean {
    if (now - this.lastAt < this.intervalMs) return false;
    this.lastAt = now;
    return true;
  }

  reset(): void {
    this.lastAt = 0;
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
