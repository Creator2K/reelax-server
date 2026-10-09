// WebSocket 客户端：实时账号快照 / 日志 / 事件
//
// 服务端按登录用户分组推送，因此只需一条连接。
// 重连用指数退避（1.5s → ×1.6 → 上限 10s），重连成功后由调用方拉一次 REST 补齐。
export type WsMessage =
  | { type: "hello"; data: { serverTime: number } }
  | { type: "snapshot"; data: unknown }
  | { type: "log"; data: unknown }
  | { type: "event"; data: { event: string } & Record<string, unknown> };

export type WsHandlers = {
  onSnapshot?: (data: unknown) => void;
  onLog?: (data: unknown) => void;
  onEvent?: (data: { event: string } & Record<string, unknown>) => void;
  /** 连接状态变化（用于侧边栏指示） */
  onStatus?: (connected: boolean) => void;
  /** 每次重连成功都会调用（用于重新拉取 REST 快照） */
  onReconnect?: () => void;
};

export type WsClient = { close: () => void };

const BASE_RETRY_MS = 1500;
const MAX_RETRY_MS = 10_000;

export function connectWs(handlers: WsHandlers): WsClient {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = BASE_RETRY_MS;
  let everConnected = false;
  let retryTimer: number | null = null;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      retryMs = BASE_RETRY_MS;
      handlers.onStatus?.(true);
      // 首次连接由页面自己拉数据；之后每次重连都补齐一次，避免断开期间的变更丢失
      if (everConnected) handlers.onReconnect?.();
      everConnected = true;
    };

    ws.onmessage = (ev) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsMessage;
      } catch {
        return; // 忽略坏帧
      }
      switch (msg.type) {
        case "snapshot":
          handlers.onSnapshot?.(msg.data);
          break;
        case "log":
          handlers.onLog?.(msg.data);
          break;
        case "event":
          handlers.onEvent?.(msg.data);
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      handlers.onStatus?.(false);
      if (closed) return;
      retryTimer = window.setTimeout(open, retryMs);
      retryMs = Math.min(Math.round(retryMs * 1.6), MAX_RETRY_MS);
    };

    ws.onerror = () => {
      // onclose 会紧随其后，交给它统一处理重连
      ws?.close();
    };
  };

  open();

  return {
    close: () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      ws?.close();
    },
  };
}
