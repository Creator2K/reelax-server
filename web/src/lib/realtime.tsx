// 实时通道 Provider：全应用一条 WebSocket
//
// 两类数据分开处理，避免「一条日志导致整棵树重渲染」：
//  - 账号快照 → 直接写进 React Query 缓存（数据来自服务端，缓存是唯一真相）
//  - 日志流   → 独立的外部存储 + useSyncExternalStore 订阅，只有用日志的组件重渲染
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectWs, type WsClient } from "./ws.ts";
import { ACCOUNTS_QUERY_KEY } from "./queries.ts";
import { SESSION_QUERY_KEY } from "./session-cache.ts";

export type LogEntry = {
  t: number;
  level: "debug" | "info" | "warn" | "error";
  userId: string | null;
  accountId: string | null;
  moduleId: string | null;
  tag: string;
  msg: string;
};

/* ---------- 日志外部存储（订阅式，不进 React state） ---------- */

export class LogStore {
  private entries: LogEntry[] = [];
  private listeners = new Set<() => void>();
  private snapshotCache: LogEntry[] = this.entries;
  private dirty = false;

  constructor(private limit = 1000) {}

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    this.dirty = true;
    for (const l of this.listeners) l();
  }

  /**
   * 用服务端最近日志回填（★ 刷新页面后不该什么都看不到）。
   *
   * 细节：
   *  - **去重**：回填请求返回之前可能已经通过 WebSocket 收到同一条（键 = 时间+标签+内容）。
   *  - **顺序**：统一按时间升序，实时条目天然在后面。
   *  - **上限**：仍然只保留最近 `limit` 条（默认 1000，每个用户各自一份页面缓冲）。
   */
  seed(entries: LogEntry[]): void {
    if (!entries.length) return;
    const keyOf = (e: LogEntry) => `${e.t}|${e.tag}|${e.msg}`;
    const seen = new Set(this.entries.map(keyOf));
    const merged = [...entries.filter((e) => !seen.has(keyOf(e))), ...this.entries];
    merged.sort((a, b) => a.t - b.t);
    this.entries = merged.slice(-this.limit);
    this.dirty = true;
    for (const l of this.listeners) l();
  }

  /** 清空（切换用户 / 退出登录时调用） */
  clear(): void {
    this.entries = [];
    this.dirty = true;
    for (const l of this.listeners) l();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /** useSyncExternalStore 要求 getSnapshot 返回稳定引用 —— 仅在真的变了之后换新数组 */
  getSnapshot = (): LogEntry[] => {
    if (this.dirty) {
      this.snapshotCache = this.entries.slice();
      this.dirty = false;
    }
    return this.snapshotCache;
  };
}

/* ---------- Context ---------- */

type RealtimeCtx = {
  connected: boolean;
  logStore: LogStore;
  /** 最近一次实时事件（events 页/账号页可用它做轻量提示） */
  lastEvent: { event: string } & Record<string, unknown>;
};

const Ctx = createContext<RealtimeCtx | null>(null);

export type RealtimeEventHandlers = {
  /** 收到钓鱼结算等业务事件时回调（可选，用于 toast） */
  onEvent?: (data: { event: string } & Record<string, unknown>) => void;
};

export function RealtimeProvider({
  enabled,
  userId,
  children,
  onEvent,
}: {
  enabled: boolean;
  userId: string;
  children: ReactNode;
  onEvent?: RealtimeEventHandlers["onEvent"];
}) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<{ event: string } & Record<string, unknown>>({ event: "" });
  const logStoreRef = useRef<LogStore | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  if (!logStoreRef.current) logStoreRef.current = new LogStore();
  const logStore = logStoreRef.current;

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }

    const refreshAccounts = () => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
    };
    const belongsToCurrentSession = () => qc.getQueryData<{ id: string } | null>(SESSION_QUERY_KEY)?.id === userId;

    const client: WsClient = connectWs({
      onStatus: setConnected,
      onSnapshot: (data) => {
        if (!belongsToCurrentSession()) return;
        qc.setQueryData(ACCOUNTS_QUERY_KEY, data);
      },
      onLog: (data) => {
        if (!belongsToCurrentSession()) return;
        const e = data as LogEntry;
        if (e && typeof e.msg === "string") logStore.push(e);
      },
      onEvent: (data) => {
        if (!data?.event || !belongsToCurrentSession()) return;
        setLastEvent(data);
        onEventRef.current?.(data);
        // 服务端会紧接着推送完整快照，无需每次结算再发 HTTP 查询。
      },
      onReconnect: refreshAccounts,
      onSessionExpired: () => { void qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY }); },
    });

    return () => {
      client.close();
      setConnected(false);
    };
  }, [enabled, userId, qc, logStore]);

  // 退出登录时清掉日志缓冲，避免下一个用户看到上一个的日志
  useEffect(() => {
    if (!enabled) logStore.clear();
  }, [enabled, logStore]);

  const value = useMemo<RealtimeCtx>(() => ({ connected, logStore, lastEvent }), [connected, logStore, lastEvent]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRealtime 必须在 <RealtimeProvider> 内使用");
  return ctx;
}
