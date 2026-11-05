/**
 * PERF-2026-11 (2): Alca Link latency through a local rendezvous (127.0.0.1).
 *
 *   ALCA_VAULT_BACKEND=file node --disable-warning=ExperimentalWarning scripts/bench/link.ts [iterations]
 *
 * Same pieces as apps/desktop/test/link.test.ts: a real rendezvous
 * (services/rendezvous), a real desktop core (startDesktop, scripted engine,
 * Link outbound), and a headless phone (the LinkClient + pairDevice the PWA
 * uses, on Node's WebSocket and WebCrypto). Measures, per iteration:
 *   pair     POST /api/link/pairings → pairDevice() resolved (SPAKE2 + enroll)
 *   connect  client.start() → status "online" (WS + E2E handshake + hello)
 *   rpc      median round trip of `threads.list` (30 calls)
 *   first    threads.send → first message.delta on the phone; → run.finished
 *   restart  stop()+start() of the phone client (fresh session) → online
 *   relay    relay process restarted on the same port → phone online again,
 *            with phone backoff 1000 ms, 50 ms and the LinkClient default (PERF-2026-11: 250 ms)
 * Loopback only: no Internet RTT, no TLS. Numbers are the protocol + crypto
 * + event-loop cost, not what a phone on LTE sees.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { startDesktop } from "../../apps/desktop/src/index.ts";
import { ScriptedEngine, type ScriptStep, streamText } from "../../packages/engines/src/index.ts";
import { generateIdentity, LinkClient, pairDevice } from "../../packages/link/src/index.ts";
import { startRendezvous } from "../../services/rendezvous/src/index.ts";

const ITER = Number(process.argv[2] ?? 5);
const now = () => performance.now();
const until = async (f: () => boolean, ms = 15000) => {
  const t = now();
  while (!f()) {
    if (now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 2));
  }
  return now() - t;
};
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

const engine = () =>
  new ScriptedEngine((): ScriptStep[] => streamText("哈囉，這是從桌機串流到手機的回覆。".repeat(3), 3));

const res: Record<string, number[]> = {};
const put = (k: string, v: number) => {
  res[k] ??= [];
  (res[k] as number[]).push(v);
};

for (let it = 0; it < ITER; it++) {
  let relay = await startRendezvous({ port: 0 });
  const port = Number(new URL(relay.url).port);
  const dir = mkdtempSync(join(tmpdir(), "alca-link-bench-"));
  const app = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "direct",
    browser: "off",
    browserDownload: false,
    engineOverride: engine(),
    rendezvous: relay.url,
  } as never);
  try {
    await until(() => app.link?.host.status === "online");
    const api = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${app.server.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${app.token}`,
          ...app.uiHeaders,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return (await r.json()) as Record<string, unknown>;
    };
    const identity = await generateIdentity();
    const t0 = now();
    const p = await api("POST", "/api/link/pairings", {});
    const tCode = now();
    const creds = await pairDevice({
      relayUrl: relay.url,
      code: String(p.display),
      identity,
      device: { name: "bench phone", kind: "phone", platform: "headless" },
      expectFingerprint: String(p.coreFingerprint),
    });
    put("pair: code issued (HTTP)", tCode - t0);
    put("pair: pairDevice (PAKE+enroll)", now() - tCode);

    // first undefined = LinkClient's own default (what the phone PWA uses).
    const mk = (first: number | undefined) =>
      new LinkClient({
        credentials: creds,
        identity,
        pingSec: 0,
        ...(first === undefined ? {} : { backoff: { first, max: 30_000 } }),
      });
    let client = mk(1000);
    const events: Array<{ type: string; runId?: string; at: number }> = [];
    client.onEvent((ch, e) => {
      if (ch === "alca") events.push({ ...(e as { type: string; runId?: string }), at: now() });
    });
    let t = now();
    client.start();
    put("connect: start → online", await until(() => client.status === "online"));

    const rtts: number[] = [];
    for (let i = 0; i < 30; i++) {
      t = now();
      await client.request("threads.list", { limit: 10 });
      rtts.push(now() - t);
    }
    put("rpc: threads.list RTT (median of 30)", med(rtts));

    const th = await client.request<{ id: string }>("threads.create", { title: "bench" });
    await client.request("watch.thread", { threadId: th.id });
    t = now();
    const r = await client.request<{ runId: string }>("threads.send", { threadId: th.id, text: "你好" });
    put("send: threads.send ack", now() - t);
    await until(() => events.some((e) => e.runId === r.runId && e.type === "run.finished"));
    const first = events.find((e) => e.runId === r.runId && e.type === "message.delta");
    const fin = events.find((e) => e.runId === r.runId && e.type === "run.finished");
    put("send: → first delta on phone", (first?.at ?? Number.NaN) - t);
    put("send: → run.finished on phone", (fin?.at ?? Number.NaN) - t);

    client.stop();
    await new Promise((r) => setTimeout(r, 50));
    client = mk(1000);
    t = now();
    client.start();
    put("reconnect: new client session → online", await until(() => client.status === "online"));

    for (const first of [1000, 50, undefined]) {
      client.stop();
      client = mk(first);
      client.start();
      await until(() => client.status === "online");
      await relay.close();
      await until(() => client.status !== "online");
      relay = await startRendezvous({ port });
      const up = now();
      await until(() => client.status === "online", 30000);
      put(
        `reconnect: relay back → phone online (phone backoff ${first ?? "default"}${first ? " ms" : ""})`,
        now() - up,
      );
      await until(() => app.link?.host.status === "online", 30000);
      put(
        `reconnect: relay back → core online (core default backoff; run with phone ${first ?? "default"}${first ? " ms" : ""})`,
        now() - up,
      );
    }
    client.stop();
  } finally {
    await app.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  `node ${process.version} ${process.platform}/${process.arch}, ${ITER} iterations, loopback relay`,
);
console.log("metric | median ms | min | max");
for (const [k, v] of Object.entries(res))
  console.log(`${k} | ${med(v).toFixed(1)} | ${Math.min(...v).toFixed(1)} | ${Math.max(...v).toFixed(1)}`);
