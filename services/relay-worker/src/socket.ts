// A Workers WebSocket (the server half of a WebSocketPair) as the relay
// hub's `WsConnection`.
import type { WsConnection } from "@alca/link/ws";
import type { CfWebSocket } from "./cf-types.ts";

/** Workers cap one WebSocket message at 1 MiB; the hub sees nothing larger. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export function adaptSocket(ws: CfWebSocket, remoteAddress: string): WsConnection {
  const onMsg: Array<(t: string) => void> = [];
  const onClose: Array<() => void> = [];
  let open = true;
  const gone = () => {
    if (!open) return;
    open = false;
    for (const h of onClose) h();
  };
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return ws.close(1003, "text only");
    if (e.data.length > MAX_MESSAGE_BYTES) return ws.close(1009, "too big");
    for (const h of onMsg) h(e.data);
  });
  ws.addEventListener("close", gone);
  ws.addEventListener("error", gone);
  return {
    send: (t) => {
      if (open) ws.send(t);
    },
    close: (code, reason) => {
      try {
        ws.close(code ?? 1000, reason ?? "");
      } catch {
        /* already closed */
      }
      gone();
    },
    onMessage: (h) => void onMsg.push(h),
    onClose: (h) => void onClose.push(h),
    bufferedAmount: 0,
    remoteAddress,
    get open() {
      return open;
    },
  };
}
