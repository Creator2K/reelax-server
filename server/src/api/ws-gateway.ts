// WebSocket 网关：/ws
//
// 与原版的关键区别：**按用户分组推送**。
//   - 升级请求用同一个会话 cookie 鉴权（不能用 query token —— 会进访问日志与 Referer）
//   - 用户只收到自己账号的 snapshot / log / event
//   - snapshot 只在内容变化时推送（避免每 2 秒无谓重渲染）
//
// 消息格式（与 web/src/lib/ws.ts 对应）：
//   { type: "hello",    data: { serverTime } }
//   { type: "snapshot", data: AccountView[] }
//   { type: "log",      data: LogEntry }
//   { type: "event",    data: { event, ...payload } }
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AuthService } from "../auth/service.ts";
import { parseCookie, SESSION_COOKIE } from "../auth/middleware.ts";
import type { AccountService, AccountView } from "../services/account-service.ts";
import type { Logger, LogEntry } from "../lib/logger.ts";
import type { Bus } from "../lib/bus.ts";
import { EVENTS } from "../lib/bus.ts";

type Client = {
  ws: WebSocket;
  userId: string;
  isAlive: boolean;
};

export type WsGatewayDeps = {
  server: Server;
  auth: AuthService;
  accounts: AccountService;
  logger: Logger;
  bus: Bus;
};

/** 快照推送间隔（内容变了才真发） */
const SNAPSHOT_INTERVAL_MS = 2000;
/** 心跳间隔 */
const HEARTBEAT_MS = 30_000;

export class WsGateway {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private deps: WsGatewayDeps;
  /** userId → 上次推送内容的指纹（用于去重） */
  private lastFingerprint = new Map<string, string>();
  private snapshotTimer: NodeJS.Timeout;
  private heartbeatTimer: NodeJS.Timeout;
  private unsubscribers: (() => void)[] = [];

  constructor(deps: WsGatewayDeps) {
    this.deps = deps;
    this.wss = new WebSocketServer({ noServer: true });

    deps.server.on("upgrade", (req, socket, head) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      const user = this.authenticate(req);
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, user.userId);
      });
    });

    this.wss.on("error", (err) => {
      deps.logger.warn("WS", `服务端错误：${err instanceof Error ? err.message : String(err)}`);
    });

    /* ---------- 日志实时推送 ---------- */
    this.unsubscribers.push(
      deps.logger.subscribe((entry) => {
        if (!entry.userId) return; // 无归属的系统日志不推（避免每个用户都看到一份重复）
        this.sendTo(entry.userId, "log", entry);
      }),
    );

    /* ---------- 业务事件推送 ---------- */
    for (const evt of [
      EVENTS.ACCOUNT_STATUS,
      EVENTS.ACCOUNT_STARTED,
      EVENTS.ACCOUNT_STOPPED,
      EVENTS.ACCOUNT_ERROR,
      EVENTS.MODULE_ERROR,
      EVENTS.FISHING_SYNC,
      EVENTS.DIGEST,
    ]) {
      this.unsubscribers.push(
        deps.bus.on(evt, (payload: unknown) => {
          const p = payload as { userId?: string; accountId?: string } | null;
          if (!p?.userId) return;
          this.sendTo(p.userId, "event", { event: evt, ...p });
          // 状态类事件立刻刷一次快照（前端不必等定时器）
          if (
            evt === EVENTS.ACCOUNT_STATUS ||
            evt === EVENTS.ACCOUNT_STARTED ||
            evt === EVENTS.ACCOUNT_STOPPED ||
            evt === EVENTS.ACCOUNT_ERROR ||
            evt === EVENTS.FISHING_SYNC
          ) {
            this.pushSnapshot(p.userId, true);
          }
        }),
      );
    }

    /* ---------- 定时全量快照 ---------- */
    this.snapshotTimer = setInterval(() => {
      for (const userId of this.userIds()) this.pushSnapshot(userId, false);
    }, SNAPSHOT_INTERVAL_MS);

    /* ---------- 心跳 ---------- */
    this.heartbeatTimer = setInterval(() => {
      for (const c of this.clients) {
        if (!c.isAlive) {
          c.ws.terminate();
          this.clients.delete(c);
          continue;
        }
        c.isAlive = false;
        try {
          c.ws.ping();
        } catch {
          /* 忽略 */
        }
      }
    }, HEARTBEAT_MS);
  }

  /** 升级鉴权：读同一个会话 cookie */
  private authenticate(req: IncomingMessage): { userId: string } | null {
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) return null;
    const resolved = this.deps.auth.resolveSession(token);
    if (!resolved) return null;
    // 未审批用户不推送业务数据（能连上但收不到账号信息）
    if (resolved.user.status !== "approved") return null;
    return { userId: resolved.user.id };
  }

  private onConnection(ws: WebSocket, userId: string): void {
    const client: Client = { ws, userId, isAlive: true };
    this.clients.add(client);

    ws.on("pong", () => {
      client.isAlive = true;
    });
    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => this.clients.delete(client));

    this.send(ws, "hello", { serverTime: Date.now() });
    // 连上即推一次自己的快照
    this.pushSnapshotTo(ws, userId, false);
  }

  /** 某用户当前的全部快照内容 */
  private snapshotFor(userId: string): AccountView[] {
    try {
      return this.deps.accounts.listForUser(userId);
    } catch {
      return [];
    }
  }

  /** 推快照；force=false 时内容没变就不发 */
  private pushSnapshot(userId: string, force: boolean): void {
    const targets = [...this.clients].filter((c) => c.userId === userId && c.ws.readyState === WebSocket.OPEN);
    if (!targets.length) return;
    const views = this.snapshotFor(userId);
    const json = JSON.stringify(views);
    if (!force && this.lastFingerprint.get(userId) === json) return;
    this.lastFingerprint.set(userId, json);
    for (const c of targets) this.send(c.ws, "snapshot", views);
  }

  private pushSnapshotTo(ws: WebSocket, userId: string, force: boolean): void {
    const views = this.snapshotFor(userId);
    const json = JSON.stringify(views);
    if (!force && this.lastFingerprint.get(userId) === json) {
      // 即使内容与上次相同，新连接也必须收到一份（否则前端空白）
      this.send(ws, "snapshot", views);
      return;
    }
    this.lastFingerprint.set(userId, json);
    this.send(ws, "snapshot", views);
  }

  private sendTo(userId: string, type: string, data: unknown): void {
    for (const c of this.clients) {
      if (c.userId === userId && c.ws.readyState === WebSocket.OPEN) {
        this.send(c.ws, type, data);
      }
    }
  }

  private send(ws: WebSocket, type: string, data: unknown): void {
    try {
      ws.send(JSON.stringify({ type, data, t: Date.now() }));
    } catch {
      /* 发送失败由 close 事件清理 */
    }
  }

  private userIds(): Set<string> {
    const out = new Set<string>();
    for (const c of this.clients) out.add(c.userId);
    return out;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    clearInterval(this.snapshotTimer);
    clearInterval(this.heartbeatTimer);
    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        /* 忽略 */
      }
    }
    this.unsubscribers = [];
    for (const c of this.clients) {
      try {
        c.ws.terminate();
      } catch {
        /* 忽略 */
      }
    }
    this.clients.clear();
    this.wss.close();
  }
}

export type { LogEntry };
