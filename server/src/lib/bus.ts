// 极简事件总线
//
// 事件是类型化对象的通道（例如 daily-digest 产出结构化 digest 事件），
// 不再依赖「用 emoji 或字符串匹配识别某条日志」这种脆弱做法。
export type Handler<T = unknown> = (payload: T) => void;

export class Bus {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<T = unknown>(event: string, handler: Handler<T>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  once<T = unknown>(event: string, handler: Handler<T>): () => void {
    const off = this.on<T>(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(event: string, handler: Handler<any>): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit<T = unknown>(event: string, payload: T): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // 复制一份再遍历：处理函数里 on/off 不应影响本次派发
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] "${event}" 的处理函数抛错：`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 某事件的订阅数（测试用） */
  count(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}

/* ---------- 事件名与负载类型（集中声明，避免字符串散落） ---------- */

export const EVENTS = {
  /** 账号状态变化 */
  ACCOUNT_STATUS: "account:status",
  /** 账号启动 / 停止 */
  ACCOUNT_STARTED: "account:started",
  ACCOUNT_STOPPED: "account:stopped",
  /** 账号级错误 */
  ACCOUNT_ERROR: "account:error",
  /** 一次钓鱼同步结算（keep-online 触发） */
  FISHING_SYNC: "fishing:sync",
  /** 某模块运行期错误 */
  MODULE_ERROR: "module:error",
  /** 结构化日报（daily-digest 触发），供通知渠道消费 */
  DIGEST: "digest",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export type AccountStatusEvent = { accountId: string; userId: string; status: string; detail?: string | null };
export type DigestEvent = {
  accountId: string;
  userId: string;
  accountLabel: string;
  date: string;
  lines: string[];
};
