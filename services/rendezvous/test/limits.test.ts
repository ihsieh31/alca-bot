// Review 2026-11-04b M1 + M2: the client address behind a proxy is the
// rightmost entry our own proxy wrote (not the leftmost, which the client
// chooses), and the hub limits what one address or one idle socket can hold:
// a hello deadline, an idle timeout, sockets per address, sockets in all, a
// byte budget, and channels per address to one core.
import { connect } from "node:net";
import { RELAY_VERSION } from "@alca/link/relay-protocol";
import type { WsConnection } from "@alca/link/ws";
import { afterEach, describe, expect, it } from "vitest";
import { RelayHub } from "../src/relay.ts";
import { clientAddress, startRendezvous } from "../src/server.ts";
import { cleanup, cleanups, setup, until } from "./helpers.ts";

afterEach(cleanup);

class FakeWs implements WsConnection {
  sent: Array<Record<string, unknown>> = [];
  closedWith: string | undefined;
  open = true;
  bufferedAmount = 0;
  remoteAddress = "198.51.100.1";
  private msg: Array<(t: string) => void> = [];
  private closeH: Array<() => void> = [];
  send(t: string) {
    this.sent.push(JSON.parse(t));
  }
  close(_code?: number, reason?: string) {
    if (!this.open) return;
    this.open = false;
    this.closedWith = reason ?? "";
    for (const h of this.closeH) h();
  }
  onMessage(h: (t: string) => void) {
    this.msg.push(h);
  }
  onClose(h: () => void) {
    this.closeH.push(h);
  }
  deliver(m: Record<string, unknown> | string) {
    for (const h of this.msg) h(typeof m === "string" ? m : JSON.stringify(m));
  }
  get errors() {
    return this.sent.filter((m) => m.op === "error").map((m) => m.message);
  }
}

describe("M1: the client address behind trusted proxies", () => {
  it("is the rightmost entry the proxies did not write; the client's own entries are ignored", () => {
    // One proxy appends the address it saw: the client cannot choose the last entry.
    expect(clientAddress("6.6.6.6, 203.0.113.9", 1, "10.0.0.1")).toBe("203.0.113.9");
    expect(clientAddress("1.2.3.4, 5.6.7.8, 203.0.113.9", 1, "10.0.0.1")).toBe("203.0.113.9");
    // Two proxies (a CDN, then nginx): the second entry from the right.
    expect(clientAddress("6.6.6.6, 203.0.113.9, 192.0.2.50", 2, "10.0.0.1")).toBe("203.0.113.9");
    // Fewer entries than proxies: the leftmost (all of them came from a proxy).
    expect(clientAddress("203.0.113.9", 2, "10.0.0.1")).toBe("203.0.113.9");
    expect(clientAddress(undefined, 1, "10.0.0.1")).toBe("10.0.0.1");
    expect(clientAddress(["6.6.6.6", "203.0.113.9"], 1, "10.0.0.1")).toBe("203.0.113.9");
    expect(clientAddress("6.6.6.6", 0, "10.0.0.1")).toBe("10.0.0.1");
  });

  it("the server keys its limits by that address: a new leftmost value per socket does not help", async () => {
    const relay = await startRendezvous({ port: 0, trustProxy: true, limits: { maxSocketsPerAddress: 1 } });
    cleanups.push(() => relay.close());
    const open = (xff: string) =>
      new Promise<string>((resolve) => {
        const s = connect(relay.port, "127.0.0.1", () => {
          s.write(
            "GET /v0/link HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
              `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Forwarded-For: ${xff}\r\n\r\n`,
          );
        });
        let got = "";
        s.on("data", (d) => {
          got += d.toString("latin1");
        });
        setTimeout(() => resolve(got), 300);
        cleanups.push(() => void s.destroy());
      });
    expect(await open("1.1.1.1, 203.0.113.9")).toContain("101");
    const second = await open("2.2.2.2, 203.0.113.9");
    expect(second).toContain("too many connections from this address");
    expect(await open("3.3.3.3, 203.0.113.10")).not.toContain("too many connections");
  });
});

describe("M2: connection limits in the hub", () => {
  it("a socket that never says who it is is closed after the hello deadline", async () => {
    const hub = new RelayHub({ limits: { helloTimeoutSec: 0.05 } });
    const ws = new FakeWs();
    hub.accept(ws, "a");
    expect(hub.stats().sockets).toBe(1);
    await until(() => !ws.open, 2000);
    expect(ws.errors).toEqual(["say hello first"]);
    expect(hub.stats().sockets).toBe(0);
  });

  it("an idle socket is closed after idleTimeoutSec; a newer one is not", () => {
    let t = 0;
    const hub = new RelayHub({ now: () => t, limits: { idleTimeoutSec: 60, helloTimeoutSec: 0 } });
    const hello = { v: RELAY_VERSION, op: "core.hello", pub: "AAAA" };
    const quiet = new FakeWs();
    hub.accept(quiet, "a");
    quiet.deliver(hello); // answered with a challenge, then silence
    expect(quiet.sent.map((m) => m.op)).toEqual(["challenge"]);
    t = 30_000;
    const later = new FakeWs();
    hub.accept(later, "b");
    later.deliver(hello);
    expect(hub.sweepIdle()).toBe(0);
    t = 70_000;
    expect(hub.sweepIdle()).toBe(1);
    expect(quiet.open).toBe(false);
    expect(quiet.errors).toContain("idle timeout");
    expect(later.open).toBe(true);
  });

  it("sockets per address and in all are capped", () => {
    const hub = new RelayHub({ limits: { maxSocketsPerAddress: 2, maxSockets: 3, helloTimeoutSec: 0 } });
    const a = [new FakeWs(), new FakeWs(), new FakeWs()];
    for (const ws of a) hub.accept(ws, "same");
    expect(a.map((w) => w.open)).toEqual([true, true, false]);
    expect(a[2]?.errors).toEqual(["too many connections from this address"]);
    // A closed socket frees its place.
    a[0]?.close();
    const again = new FakeWs();
    hub.accept(again, "same");
    expect(again.open).toBe(true);
    const others = [new FakeWs(), new FakeWs()];
    for (const ws of others) hub.accept(ws, `other-${others.indexOf(ws)}`);
    expect(others.map((w) => w.open)).toEqual([true, false]);
    expect(others[1]?.errors).toEqual(["relay is full"]);
  });

  it("a connection's bytes are budgeted (burst, then per second)", () => {
    let t = 0;
    const hub = new RelayHub({
      now: () => t,
      limits: { bytesBurst: 1000, bytesPerSecond: 100, helloTimeoutSec: 0 },
    });
    const ws = new FakeWs();
    hub.accept(ws, "a");
    ws.deliver({ v: RELAY_VERSION, op: "dial", mailbox: "nobody", pad: "x".repeat(900) });
    expect(ws.errors).toEqual(["that core is not online"]);
    const ws2 = new FakeWs();
    hub.accept(ws2, "b");
    ws2.deliver({ v: RELAY_VERSION, op: "dial", mailbox: "nobody", pad: "x".repeat(1200) });
    expect(ws2.errors).toEqual(["too much data"]);
    t = 0;
  });

  it("one address holds at most maxChannelsPerCorePerAddress channels to a core", async () => {
    const { relay, host } = await setup({ limits: { maxChannelsPerCorePerAddress: 2 } });
    const results: string[] = [];
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${relay.url.replace(/^http/, "ws")}/v0/link`);
      sockets.push(ws);
      cleanups.push(() => ws.close());
      await new Promise<void>((r) => ws.addEventListener("open", () => r()));
      const first = new Promise<string>((r) =>
        ws.addEventListener("message", (e) => r(String((JSON.parse(String(e.data)) as { op: string }).op))),
      );
      ws.send(JSON.stringify({ v: RELAY_VERSION, op: "dial", mailbox: host.mailbox }));
      results.push(await first);
    }
    expect(results).toEqual(["open", "open", "error"]);
    // Closing one frees a place for the same address.
    sockets[0]?.close();
    await until(() => relay.hub.stats().channels === 1);
    const ws = new WebSocket(`${relay.url.replace(/^http/, "ws")}/v0/link`);
    cleanups.push(() => ws.close());
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    const op = new Promise<string>((r) =>
      ws.addEventListener("message", (e) => r(String((JSON.parse(String(e.data)) as { op: string }).op))),
    );
    ws.send(JSON.stringify({ v: RELAY_VERSION, op: "dial", mailbox: host.mailbox }));
    expect(await op).toBe("open");
  });
});
