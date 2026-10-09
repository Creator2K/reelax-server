// 实时通道 Provider：全应用一条 WebSocket
//
// 两类数据分开处理，避免「一条日志导致整棵树重渲染」：
//  - 账号快照 → 直接写进 React Query 缓存（数据来自服务端，缓存是唯一真相）
//  - 日志流   → 独立的外部存储 + useSyncExternalStore 订阅，只有用日志的组件重渲染
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectWs, type WsClient } from "./ws.ts";
import { ACCOUNTS_QUERY_KEY } from "./queries.ts";

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
  children,
  onEvent,
}: {
  enabled: boolean;
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

    const client: WsClient = connectWs({
      onStatus: setConnected,
      onSnapshot: (data) => {
        qc.setQueryData(ACCOUNTS_QUERY_KEY, data);
      },
      onLog: (data) => {
        const e = data as LogEntry;
        if (e && typeof e.msg === "string") logStore.push(e);
      },
      onEvent: (data) => {
        if (!data?.event) return;
        setLastEvent(data);
        onEventRef.current?.(data);
        // 状态变化类事件需要刷新账号数据
        if (
          data.event === "account:status" ||
          data.event === "account:started" ||
          data.event === "account:stopped" ||
          data.event === "account:error" ||
          data.event === "fishing:sync"
        ) {
          refreshAccounts();
        }
      },
      onReconnect: refreshAccounts,
    });

    return () => {
      client.close();
      setConnected(false);
    };
  }, [enabled, qc, logStore]);

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
