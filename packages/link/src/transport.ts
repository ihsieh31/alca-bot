// Device-side transport: one WebSocket = one channel to the core, through
// the relay (claim a nameplate / dial a mailbox) or straight to the core's
// LAN listener (same `dial` opening). Works with the browser WebSocket and
// Node's built-in one.
import { LinkError, type LinkErrorCode } from "./errors.ts";
import { RELAY_VERSION } from "./relay-protocol.ts";
import { QueueWire, type WireMessage } from "./wire.ts";

export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    handler: (ev: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export function defaultWebSocket(): WebSocketCtor {
  const W = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (!W) throw new Error("no WebSocket implementation available");
  return W as WebSocketCtor;
}

export type Opening =
  | { op: "claim"; nameplate: string }
  | { op: "dial"; mailbox: string }
  /** P10: a device signed in with the computer's Google account asks to enroll. */
  | { op: "connect"; mailbox: string; idToken: string };

const RELAY_CODES: Record<string, LinkErrorCode> = {
  no_such_code: "no_such_code",
  offline: "offline",
  rate_limited: "rate_limited",
  bad_token: "bad_token",
  no_such_computer: "no_such_computer",
};

export interface DeviceWire extends QueueWire {
  readonly socket: WebSocketLike;
}

export function openDeviceWire(
  url: string,
  opening: Opening,
  o: { WebSocketImpl?: WebSocketCtor; timeoutMs?: number } = {},
): Promise<DeviceWire> {
  const W = o.WebSocketImpl ?? defaultWebSocket();
  return new Promise((resolve, reject) => {
    let ws: WebSocketLike;
    try {
      ws = new W(url);
    } catch (e) {
      return reject(new LinkError("offline", e instanceof Error ? e.message : "cannot connect"));
    }
    let opened = false;
    const wire = new QueueWire(
      (m) => ws.send(JSON.stringify({ op: "msg", d: m })),
      () => ws.close(1000, "bye"),
    ) as DeviceWire;
    Object.defineProperty(wire, "socket", { value: ws });
    const timer = setTimeout(() => {
      if (opened) return;
      reject(new LinkError("timeout", "relay did not answer"));
      ws.close();
    }, o.timeoutMs ?? 10_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ ...opening, v: RELAY_VERSION })));
    ws.addEventListener("message", (ev) => {
      let m: WireMessage;
      try {
        m = JSON.parse(String(ev.data)) as WireMessage;
      } catch {
        return;
      }
      if (m.op === "open" && !opened) {
        opened = true;
        clearTimeout(timer);
        return resolve(wire);
      }
      if (m.op === "error") {
        const code = RELAY_CODES[String(m.code)] ?? "relay";
        const err = new LinkError(code, String(m.message ?? m.code));
        if (!opened) {
          clearTimeout(timer);
          return reject(err);
        }
        return wire.end(code);
      }
      if (m.op === "msg" && m.d && typeof m.d === "object") wire.push(m.d as WireMessage);
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      if (!opened) reject(new LinkError("offline", ev.reason || "connection closed"));
      wire.end(ev.reason || "closed");
    });
    ws.addEventListener("error", () => undefined);
  });
}

/**
 * Ask a relay whether a mailbox is listening there right now, without
 * opening a channel: `true` / `false`, or `undefined` when the relay could
 * not be reached or did not answer in time. Used by the core's self-check
 * and the phone's 診斷.
 */
export function probeRelay(
  url: string,
  mailbox: string,
  o: { WebSocketImpl?: WebSocketCtor; timeoutMs?: number } = {},
): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    let ws: WebSocketLike;
    try {
      ws = new (o.WebSocketImpl ?? defaultWebSocket())(url);
    } catch {
      return resolve(undefined);
    }
    let done = false;
    const finish = (v: boolean | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
    const timer = setTimeout(() => finish(undefined), o.timeoutMs ?? 8000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ op: "probe", v: RELAY_VERSION, mailbox })));
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as WireMessage;
        if (m.op === "probe") return finish(m.online === true);
        if (m.op === "error") return finish(undefined);
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener("close", () => finish(undefined));
    ws.addEventListener("error", () => finish(undefined));
  });
}
