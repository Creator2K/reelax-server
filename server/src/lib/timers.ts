// 受管定时器：账号停止时统一清理，模块停止时按「归属」清理
//
// 与旧引擎的 ctx.every / ctx.schedule 语义一致：异步错误自动捕获，
// 不让一个定时任务的异常把整个账号运行时打挂。
//
// ★ 为什么要有 owner：定时器原本只有账号级的 clear()，于是「关掉某个模块」时
//   它注册的 every/schedule 还活得好好的 —— 模块虽然从实例表里删掉了，
//   回调仍拿着旧配置继续干活（例如自动切图关掉后还在按天气换图，
//   自动换饵关掉后还在买饵），必须停止账号才消停。owner = 模块 id，
//   模块停止时调 clearOwner(id) 就能精确清掉它的定时器，且不影响别人。

export type ManagedTimerKind = "interval" | "timeout";

export type ManagedTimer = {
  kind: ManagedTimerKind;
  handle: NodeJS.Timeout;
  /** 定时器归属（模块 id）；账号级定时器没有 owner */
  owner?: string;
};

export class TimerPool {
  private timers = new Set<ManagedTimer>();
  private onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void = () => {}) {
    this.onError = onError;
  }

  every(ms: number, fn: () => unknown | Promise<unknown>, owner?: string): NodeJS.Timeout {
    const handle = setInterval(() => {
      this.invoke(fn);
    }, Math.max(1, ms));
    const t: ManagedTimer = { kind: "interval", handle, ...(owner ? { owner } : {}) };
    this.timers.add(t);
    return handle;
  }

  schedule(ms: number, fn: () => unknown | Promise<unknown>, owner?: string): NodeJS.Timeout {
    const handle = setTimeout(() => {
      this.deleteByHandle(handle);
      this.invoke(fn);
    }, Math.max(0, ms));
    this.timers.add({ kind: "timeout", handle, ...(owner ? { owner } : {}) });
    return handle;
  }

  /** 只清掉某个归属（模块）的定时器；账号级定时器不受影响 */
  clearOwner(owner: string): void {
    for (const t of [...this.timers]) {
      if (t.owner !== owner) continue;
      this.clearOne(t);
    }
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

  private deleteByHandle(handle: NodeJS.Timeout): void {
    for (const t of this.timers) {
      if (t.handle === handle) this.timers.delete(t);
    }
  }

  private clearOne(t: ManagedTimer): void {
    if (t.kind === "interval") clearInterval(t.handle);
    else clearTimeout(t.handle);
    this.timers.delete(t);
  }

  clear(): void {
    for (const t of [...this.timers]) this.clearOne(t);
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
  private loaded = false;
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
    if (!force && this.loaded && now - this.at < this.ttlMs) return this.value as T;
    // 并发合并：同一时刻多个调用只发一次请求
    if (this.loading) return this.loading;
    this.loading = loader()
      .then((v) => {
        this.value = v;
        this.loaded = true;
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
    this.loaded = false;
    this.at = 0;
  }
}
