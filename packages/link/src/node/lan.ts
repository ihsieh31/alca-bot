// Direct LAN path: the core listens on a LAN port for devices that are on
// the same network. Only the Link protocol is spoken here (dial → session
// handshake → sealed frames); the HTTP API stays on loopback.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import type { LinkHost } from "../host.ts";
import { RELAY_PATH } from "../relay-protocol.ts";
import { QueueWire, type WireMessage } from "../wire.ts";
import { acceptWebSocket } from "./ws.ts";

export interface LanListener {
  server: Server;
  port: number;
  urls: string[];
  close(): Promise<void>;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  return out;
}

export async function startLanListener(
  host: LinkHost,
  o: { host?: string; port?: number; addresses?: string[] } = {},
): Promise<LanListener> {
  const attempts = new Map<string, { n: number; at: number }>();
  const server = createServer((_req, res) => res.writeHead(404).end());
  // Upgraded sockets leave the server's bookkeeping: track them so close() ends them.
  const sockets = new Set<Duplex>();
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if ((req.url ?? "").split("?")[0] !== RELAY_PATH) return void socket.destroy();
    const ws = acceptWebSocket(req, socket, head, { maxMessageBytes: 4 * 1024 * 1024 });
    if (!ws) return;
    const ip = ws.remoteAddress;
    const t = Date.now();
    const a = attempts.get(ip) ?? { n: 0, at: t };
    if (t - a.at > 60_000) Object.assign(a, { n: 0, at: t });
    a.n++;
    attempts.set(ip, a);
    if (a.n > 30) return ws.close(4000, "rate_limited");
    let wire: QueueWire | undefined;
    ws.onMessage((text) => {
      let m: WireMessage;
      try {
        m = JSON.parse(text) as WireMessage;
      } catch {
        return ws.close(4000, "bad_request");
      }
      if (!wire) {
        if (m.op !== "dial" || m.mailbox !== host.mailbox) {
          ws.send(JSON.stringify({ op: "error", code: "offline", message: "not this core" }));
          return ws.close(4000, "offline");
        }
        wire = new QueueWire(
          (d) => ws.send(JSON.stringify({ op: "msg", d })),
          () => ws.close(1000, "bye"),
        );
        ws.send(JSON.stringify({ op: "open" }));
        void host.acceptWire(wire, "lan");
        return;
      }
      if (m.op === "msg" && m.d && typeof m.d === "object") wire.push(m.d as WireMessage);
    });
    ws.onClose(() => wire?.end("closed"));
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(o.port ?? 0, o.host ?? "0.0.0.0", () => res());
  });
  const port = (server.address() as AddressInfo).port;
  const addrs = o.addresses ?? lanAddresses();
  return {
    server,
    port,
    urls: addrs.map((a) => `ws://${a}:${port}${RELAY_PATH}`),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
