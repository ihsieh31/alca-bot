import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type SseOut, sseOut } from "../src/sse-out.ts";

/**
 * PERF-2026-11 §6: an SSE client that stops reading is cut off once its queue
 * passes the cap (it reconnects and the stream replays what it needs), instead
 * of buffering every event in the core.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function serve(max: number, replay?: (out: SseOut) => void) {
  let res!: ServerResponse;
  let out!: SseOut;
  const overflow: number[] = [];
  const ready = new Promise<void>((resolve) => {
    const srv = createServer((_req, r) => {
      res = r;
      r.writeHead(200, { "content-type": "text/event-stream" });
      out = sseOut(r, {
        maxBuffered: max,
        onOverflow: (b) => overflow.push(b),
        ...(replay ? { replay: true } : {}),
      });
      out.write(": hi\n\n");
      if (replay) {
        replay(out);
        out.arm();
      }
      resolve();
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      const sock = connect(port, "127.0.0.1", () => sock.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n"));
      cleanups.push(() => {
        sock.destroy();
        srv.close();
      });
      // A client that never reads again (a frozen tab).
      sock.once("data", () => sock.pause());
    });
  });
  await ready;
  return { res: () => res, out: () => out, overflow };
}

const chunk = `event: alca\ndata: ${"x".repeat(16 * 1024)}\n\n`;

describe("SSE backpressure", () => {
  it("cuts off a client that stopped reading once its queue passes the cap", async () => {
    const max = 256 * 1024;
    const s = await serve(max);
    const closed = once(s.res(), "close");
    let accepted = 0;
    let peak = 0;
    for (let i = 0; i < 20_000 && s.out().write(chunk); i++) {
      accepted++;
      peak = Math.max(peak, s.out().buffered);
      if (i % 16 === 0) await new Promise((r) => setImmediate(r)); // let the kernel buffers fill
    }
    expect(s.out().closed).toBe(true);
    expect(s.overflow).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(max);
    expect(accepted).toBeLessThan(20_000);
    await closed; // the core's side is gone: subscriptions are released on req "close"
    expect(s.out().write(chunk)).toBe(false); // nothing more is queued
  }, 20_000);

  it("review #5: the initial replay is not counted, so a replay over the cap does not cut the client", async () => {
    const max = 256 * 1024;
    let replayed = 0;
    let peak = 0;
    const s = await serve(max, (out) => {
      // Written in one tick, before the client could read: 1 MB, four times the cap.
      for (let i = 0; i < 64; i++) {
        if (out.write(chunk)) replayed++;
        peak = Math.max(peak, out.buffered);
      }
    });
    expect(peak).toBeGreaterThan(max); // the old cap would have cut this client during its replay
    expect(replayed).toBe(64);
    expect(s.out().closed).toBe(false);
    expect(s.overflow).toEqual([]);
    // Past the replay the cap holds again: a client that never reads is cut off.
    const closed = once(s.res(), "close");
    let accepted = 0;
    for (let i = 0; i < 20_000 && s.out().write(chunk); i++) {
      accepted++;
      if (i % 16 === 0) await new Promise((r) => setImmediate(r));
    }
    expect(s.out().closed).toBe(true);
    expect(s.overflow).toHaveLength(1);
    expect(accepted).toBeLessThan(20_000);
    await closed;
  }, 20_000);

  it("a client that reads keeps its stream", async () => {
    const srv = createServer((_req, r) => {
      r.writeHead(200, { "content-type": "text/event-stream" });
      const out = sseOut(r, { maxBuffered: 256 * 1024 });
      let n = 0;
      const pump = () => {
        while (n < 200) {
          n++;
          if (!out.write(chunk)) return;
          if (r.writableNeedDrain) return void r.once("drain", pump);
        }
        r.end();
      };
      pump();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    cleanups.push(() => srv.close());
    const res = await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/`);
    const body = await res.text();
    expect(body.split("event: alca").length - 1).toBe(200);
  }, 20_000);
});
