// 日志：内存环形缓冲 + 订阅推送 + 落库钩子
//
// 设计要点：
//  - 内存保留最近 N 条供「运行日志」实时页，通过 subscribe 推给 WS 网关
//  - 落库由外部 sink 负责（LogRepository），Logger 本身不碰数据库，
//    这样单元测试可以直接用 Logger 而不需要起 SQLite
import type { Env } from "../env.ts";

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export type LogEntry = {
  t: number;
  level: LogLevel;
  /** 归属用户（落库与 WS 路由按它过滤） */
  userId: string | null;
  /** 归属游戏账号 */
  accountId: string | null;
  /** 归属内置模块（如 "keep-online"） */
  moduleId: string | null;
  /** 自由标签，展示在日志行开头 */
  tag: string;
  msg: string;
};

export type LogMeta = {
  userId?: string | null;
  accountId?: string | null;
  moduleId?: string | null;
  tag?: string;
};

type Subscriber = (entry: LogEntry) => void;

export class Logger {
  private buffer: LogEntry[] = [];
  private subs = new Set<Subscriber>();
  private sinks = new Set<Subscriber>();
  private minLevel: number;
  private limit: number;

  /**
   * @param opts.limit    内存环形缓冲条数
   * @param opts.minLevel 最低记录级别；低于它的日志会被**直接丢弃**（连订阅者都收不到）
   *
   * 用命名参数而不是位置参数：早期写成 `new Logger(500, "error")` 时极易被误读成
   * 「保留 500 条错误日志」，实际含义是「只记 error 及以上」—— 会把 info 日志整片吞掉。
   */
  constructor(opts: { limit?: number; minLevel?: LogLevel } = {}) {
    this.limit = opts.limit ?? 5000;
    this.minLevel = LEVELS[opts.minLevel ?? "debug"];
  }

  push(level: LogLevel, tag: string, msg: string, meta: LogMeta = {}): LogEntry | null {
    if (LEVELS[level] < this.minLevel) return null;
    const entry: LogEntry = {
      t: Date.now(),
      level,
      userId: meta.userId ?? null,
      accountId: meta.accountId ?? null,
      moduleId: meta.moduleId ?? null,
      tag,
      msg: String(msg),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.limit) this.buffer.splice(0, this.buffer.length - this.limit);
    for (const sub of this.subs) {
      try {
        sub(entry);
      } catch {
        /* 订阅方异常不影响日志 */
      }
    }
    for (const sink of this.sinks) {
      try {
        sink(entry);
      } catch {
        /* 落库失败不影响主流程 */
      }
    }
    return entry;
  }

  debug(tag: string, msg: string, meta?: LogMeta) {
    return this.push("debug", tag, msg, meta);
  }
  info(tag: string, msg: string, meta?: LogMeta) {
    return this.push("info", tag, msg, meta);
  }
  warn(tag: string, msg: string, meta?: LogMeta) {
    return this.push("warn", tag, msg, meta);
  }
  error(tag: string, msg: string, meta?: LogMeta) {
    return this.push("error", tag, msg, meta);
  }

  /** 带固定上下文的子日志（账号 / 模块维度） */
  child(meta: LogMeta): ChildLogger {
    return new ChildLogger(this, meta);
  }

  /** 实时订阅（WS 推送用）。返回取消订阅函数。 */
  subscribe(cb: Subscriber): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** 落库钩子（LogRepository 用）。落库失败不影响主流程。 */
  addSink(cb: Subscriber): () => void {
    this.sinks.add(cb);
    return () => this.sinks.delete(cb);
  }

  recent(opts: {
    userId?: string | null;
    accountId?: string | null;
    moduleId?: string | null;
    minLevel?: LogLevel;
    search?: string;
    limit?: number;
  } = {}): LogEntry[] {
    const min = LEVELS[opts.minLevel ?? "debug"];
    let out = this.buffer;
    if (opts.userId) {
      // 带上 userId 时同时返回「该用户自己的」与「无归属的系统级」日志
      // （服务启动、数据库迁移这类日志没有归属，对所有用户都该可见）。
      // 关键：绝不会返回**其他用户**的日志。
      out = out.filter((e) => e.userId === opts.userId || e.userId === null);
    }
    if (opts.accountId) out = out.filter((e) => e.accountId === opts.accountId);
    if (opts.moduleId) out = out.filter((e) => e.moduleId === opts.moduleId);
    if (min > LEVELS.debug) out = out.filter((e) => LEVELS[e.level] >= min);
    if (opts.search) {
      const needle = opts.search.toLowerCase();
      out = out.filter((e) => (e.tag + " " + e.msg).toLowerCase().includes(needle));
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 500), 2000);
    return out.slice(-limit);
  }

  clear() {
    this.buffer = [];
  }
}

export class ChildLogger {
  private parent: Logger;
  private meta: LogMeta;

  constructor(parent: Logger, meta: LogMeta) {
    this.parent = parent;
    this.meta = meta;
  }

  child(extra: LogMeta): ChildLogger {
    return new ChildLogger(this.parent, { ...this.meta, ...extra });
  }

  debug(tag: string, msg: string) {
    return this.parent.debug(tag, msg, this.meta);
  }
  info(tag: string, msg: string) {
    return this.parent.info(tag, msg, this.meta);
  }
  warn(tag: string, msg: string) {
    return this.parent.warn(tag, msg, this.meta);
  }
  error(tag: string, msg: string) {
    return this.parent.error(tag, msg, this.meta);
  }
}

export function createLogger(env: Pick<Env, "logLevel">): Logger {
  return new Logger({ limit: 5000, minLevel: env.logLevel });
}

/** 控制台镜像：把 warn/error 也打到 stdout，便于 docker logs 排查 */
export function mirrorToConsole(logger: Logger): () => void {
  return logger.subscribe((e) => {
    if (e.level === "debug") return;
    const who = [e.tag, e.moduleId, e.accountId?.slice(0, 8)].filter(Boolean).join(" ");
    const line = `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${who} ${e.msg}`;
    if (e.level === "error") console.error(line);
    else if (e.level === "warn") console.warn(line);
    else console.log(line);
  });
}
