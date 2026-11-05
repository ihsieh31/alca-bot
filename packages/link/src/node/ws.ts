// A small RFC 6455 WebSocket server endpoint (text messages, ping/pong,
// close, fragmentation) so the relay and the LAN listener need no
// dependency. Clients use the platform WebSocket.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsConnection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(h: (text: string) => void): void;
  onClose(h: () => void): void;
  /** Bytes queued in the socket and not yet written. */
  readonly bufferedAmount: number;
  readonly remoteAddress: string;
  readonly open: boolean;
}

export interface AcceptOptions {
  /** Largest message (after reassembly) in bytes. */
  maxMessageBytes?: number;
  /** Seconds between server pings; a connection that misses two is dropped. */
  pingSec?: number;
}

function reject(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Complete the upgrade handshake; returns undefined (and answers the request) when it is not a valid one. */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  o: AcceptOptions = {},
): WsConnection | undefined {
  const key = req.headers["sec-websocket-key"];
  if (
    String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" ||
    req.headers["sec-websocket-version"] !== "13" ||
    typeof key !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key)
  ) {
    reject(socket, 400, "Bad Request");
    return undefined;
  }
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const max = o.maxMessageBytes ?? 4 * 1024 * 1024;
  const msgHandlers: Array<(t: string) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let buf: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragBytes = 0;
  let open = true;
  let missed = 0;

  const shut = () => {
    if (!open) return;
    open = false;
    clearInterval(ping);
    for (const h of closeHandlers) h();
  };
  const close = (code = 1000, reason = "") => {
    if (!open) return;
    const r = Buffer.from(reason.slice(0, 120));
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    try {
      socket.write(frame(0x8, p));
      socket.end();
    } catch {
      // socket already gone
    }
    shut();
    setTimeout(() => socket.destroy(), 1000).unref();
  };
  const ping = setInterval(
    () => {
      if (++missed > 2) return close(1011, "ping timeout");
      if (open) socket.write(frame(0x9, Buffer.alloc(0)));
    },
    (o.pingSec ?? 20) * 1000,
  );
  ping.unref();

  const onData = (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (open) {
      if (buf.length < 2) return;
      const b0 = buf[0] as number;
      const b1 = buf[1] as number;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (b0 & 0x70) return close(1002, "reserved bits");
      if (!(b1 & 0x80)) return close(1002, "client frames must be masked");
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(max)) return close(1009, "message too big");
        len = Number(big);
        off = 10;
      }
      if (len > max) return close(1009, "message too big");
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i & 3] as number);
      buf = buf.subarray(off + 4 + len);
      if (opcode === 0x8) return close(1000, "bye");
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) {
        missed = 0;
        continue;
      }
      if (opcode === 0x2) return close(1003, "text only");
      if (opcode !== 0x1 && opcode !== 0x0) return close(1002, "bad opcode");
      if (opcode === 0x1 && fragments.length) return close(1002, "unfinished message");
      if (opcode === 0x0 && !fragments.length) return close(1002, "nothing to continue");
      fragBytes += payload.length;
      if (fragBytes > max) return close(1009, "message too big");
      fragments.push(payload);
      if (!fin) continue;
      const whole = fragments.length === 1 ? (fragments[0] as Buffer) : Buffer.concat(fragments);
      fragments = [];
      fragBytes = 0;
      missed = 0;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(whole);
      } catch {
        return close(1007, "invalid utf-8");
      }
      for (const h of msgHandlers) h(text);
    }
  };
  socket.on("data", onData);
  socket.on("close", shut);
  socket.on("error", shut);
  if (head.length) onData(head);

  return {
    send(text) {
      if (open) socket.write(frame(0x1, Buffer.from(text, "utf8")));
    },
    close,
    onMessage: (h) => void msgHandlers.push(h),
    onClose: (h) => void closeHandlers.push(h),
    get bufferedAmount() {
      return socket.writableLength;
    },
    remoteAddress: req.socket.remoteAddress ?? "",
    get open() {
      return open;
    },
  };
}
