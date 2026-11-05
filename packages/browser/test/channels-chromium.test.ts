// R3 against a real Chromium: a Space's service worker cannot send for the
// page or on its own unseen, WebRTC is refused, and a WebSocket frame that
// looks like a send stops the tab (after the fact: the frame has left).
// Skips without a Chromium, except where ALCA_REQUIRE_CHROMIUM is set (CI).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionClass } from "@alca/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrowserAgent,
  BrowserHost,
  CdpSession,
  type ChannelEvent,
  type ChromiumProcess,
  findChromium,
  launchChromium,
  type NetworkConfirmRequest,
} from "../src/index.ts";

const bin = process.env.ALCA_TEST_CHROMIUM || findChromium();
const BOT = "bot_00000000000000000000000001";
const sig = () => AbortSignal.timeout(30_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const WS_PAGE = html(
  "WS",
  `<button onclick="go('send')">按鈕甲</button><button onclick="go('hi')">打招呼</button><p id="s">ws:無</p>
<script>
const MSGS = { send: JSON.stringify({ query: "mutation sendMessage { send(text: 1) }" }), hi: "hello" };
function go(k) {
  const w = new WebSocket("ws://" + location.host + "/sock");
  w.onopen = () => { w.send(MSGS[k]); document.getElementById("s").textContent = "ws:sent " + k; };
}
</script>`,
);

const SW_PAGE = html(
  "SW",
  `<p id="s">sw:無</p><p id="g">get:無</p>
<button onclick="navigator.serviceWorker.ready.then((r) => r.active.postMessage('send'))">背景同步</button>
<button onclick="fetch('/swonly/send',{method:'POST',body:'{}'}).then((r)=>r.text()).then((t)=>{document.getElementById('s').textContent='proxy:'+t}).catch(()=>{document.getElementById('s').textContent='proxy:被擋'})">經由背景</button>
<button onclick="fetch('/swonly/item').then((r)=>r.text()).then((t)=>{document.getElementById('g').textContent='get:'+t})">讀取</button>
<script>
navigator.serviceWorker.onmessage = (e) => { document.getElementById("s").textContent = String(e.data); };
navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => {
  document.getElementById("s").textContent = "sw:ready";
});
</script>`,
);

const SW_JS = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  e.waitUntil(
    fetch("/api/messages/send", { method: "POST", headers: { "content-type": "application/json" }, body: '{"text":"from sw"}' })
      .then((r) => r.text())
      .then((t) => e.source.postMessage("sw:" + t))
      .catch(() => e.source.postMessage("sw:被擋")),
  );
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname === "/swonly/item") e.respondWith(new Response("from-sw"));
  if (u.pathname === "/swonly/send")
    e.respondWith(fetch("/api/messages/send", { method: "POST", body: '{"text":"proxied"}' }).catch(() => new Response("被擋")));
});
`;

const RTC_PAGE = html(
  "RTC",
  `<button onclick="tryRtc()">建立連線</button><p id="s">rtc:無</p><p id="f">iframe:無</p>
<script>
function tryRtc() {
  try { new RTCPeerConnection(); document.getElementById("s").textContent = "rtc:ok"; }
  catch (e) { document.getElementById("s").textContent = "rtc:" + e.name; }
  const f = document.createElement("iframe");
  document.body.append(f);
  try { new f.contentWindow.RTCPeerConnection(); document.getElementById("f").textContent = "iframe:ok"; }
  catch (e) { document.getElementById("f").textContent = "iframe:" + e.name; }
}
</script>`,
);

/** Two peer connections in one page, loopback only: does a data channel open? */
const LOOPBACK = `(async () => {
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
  const ch = a.createDataChannel("x");
  const opened = new Promise((r) => { ch.onopen = () => r("open"); setTimeout(() => r("timeout"), 4000); });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  return opened;
})()`;

interface Site {
  url: string;
  server: Server;
  hits: string[];
  frames: string[];
}

async function startSite(): Promise<Site> {
  const hits: string[] = [];
  const frames: string[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method !== "GET") hits.push(`${req.method} ${u.pathname}`);
    const page = (b: string, type = "text/html; charset=utf-8") =>
      res.writeHead(200, { "content-type": type }).end(b);
    if (u.pathname === "/ws") return void page(WS_PAGE);
    if (u.pathname === "/sw-page") return void page(SW_PAGE);
    if (u.pathname === "/sw.js") return void page(SW_JS, "text/javascript");
    if (u.pathname === "/rtc") return void page(RTC_PAGE);
    if (u.pathname === "/blank") return void page(html("blank", "<p>blank</p>"));
    if (u.pathname === "/swonly/item") return void res.writeHead(200).end("from-net");
    if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/swonly/"))
      return void res.writeHead(200).end("ok");
    res.writeHead(404).end();
  });
  // A bare-bones WebSocket endpoint: record the text frames that arrive.
  server.on("upgrade", (req, socket) => {
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const b1 = buf[1] as number;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskAt = off;
        if (b1 & 0x80) off += 4;
        if (buf.length < off + len) return;
        const mask = buf.subarray(maskAt, maskAt + 4);
        const payload = Buffer.from(buf.subarray(off, off + len)).map((x, i) =>
          b1 & 0x80 ? x ^ (mask[i % 4] as number) : x,
        );
        const opcode = (buf[0] as number) & 0x0f;
        if (opcode === 1) frames.push(Buffer.from(payload).toString("utf8"));
        if (opcode === 8) socket.end();
        buf = buf.subarray(off + len);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits, frames };
}

describe("R3: Chromium is required here", () => {
  it.runIf(!!process.env.ALCA_REQUIRE_CHROMIUM)("finds a Chromium (the channel tests must not skip)", () => {
    expect(bin).toBeTruthy();
  });
});

describe.skipIf(!bin)("R3 channels × real Chromium", { timeout: 60_000 }, () => {
  let site: Site;
  let dir: string;
  let host: BrowserHost;
  let agent: BrowserAgent;
  let proc: ChromiumProcess | undefined;
  const asked: NetworkConfirmRequest[] = [];
  const told: ChannelEvent[] = [];

  beforeAll(async () => {
    site = await startSite();
    dir = mkdtempSync(join(tmpdir(), "alca-chan-"));
    host = new BrowserHost({
      launchShared: async () => {
        proc = await launchChromium({
          executablePath: bin as string,
          userDataDir: join(dir, "p"),
          headless: true,
        });
        return proc;
      },
      confirmNetwork: async (req) => {
        asked.push(req);
        return false;
      },
      notifyChannel: (e) => told.push(e),
    });
    agent = new BrowserAgent(host);
  }, 30_000);

  afterAll(async () => {
    await host?.shutdown();
    await proc?.close();
    site?.server.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const step = (spaceId: string, s: Parameters<BrowserAgent["step"]>[2], granted: ActionClass = "write") =>
    agent.step(spaceId, BOT, s, { signal: sig(), granted });
  const text = async (spaceId: string) => (await step(spaceId, { do: "read" }, "read")).output;
  const until = async (what: () => Promise<boolean> | boolean, label: string, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await what()) return;
      await sleep(100);
    }
    throw new Error(`never saw ${label}`);
  };
  const sees = (spaceId: string, want: string) =>
    until(async () => (await text(spaceId)).includes(want), want);
  const tabUrl = (spaceId: string) => host.state(spaceId).tabs[0]?.url ?? "";

  it("a page's requests skip its service worker, and the worker's own send is gated before it runs", async () => {
    asked.length = 0;
    site.hits.length = 0;
    const { spaceId } = await host.open({ botId: BOT, title: "SW", url: `${site.url}/sw-page` });
    await sees(spaceId, "sw:ready");
    // The worker would answer from-sw; the page goes to the network instead.
    await step(spaceId, { do: "click", target: { role: "button", name: "讀取" } });
    await sees(spaceId, "get:from-net");
    // A send the worker makes for the page: the page's own request now, held at the tab.
    await step(spaceId, { do: "click", target: { role: "button", name: "經由背景" } });
    await sees(spaceId, "proxy:被擋");
    // A send the worker makes on its own (a message, no page request at all).
    await step(spaceId, { do: "click", target: { role: "button", name: "背景同步" } });
    await sees(spaceId, "sw:被擋");
    expect(asked.map((a) => a.actionClass)).toEqual(["send", "send"]);
    expect(asked.map((a) => new URL(a.url).pathname)).toEqual(["/swonly/send", "/api/messages/send"]);
    expect(site.hits).toEqual([]);
    await host.close(spaceId);
  });

  it("an agent tab cannot build a WebRTC connection (a tab that is no Space's still can: the switch is not a lock)", async () => {
    const { spaceId } = await host.open({ botId: BOT, title: "RTC", url: `${site.url}/rtc` });
    await step(spaceId, { do: "click", target: { role: "button", name: "建立連線" } });
    await sees(spaceId, "rtc:NotAllowedError");
    // Defence in depth, not a guarantee: record what a fresh same-origin frame got.
    const t = await text(spaceId);
    console.log(
      `[R3] WebRTC in a new about:blank iframe of an agent tab: ${/iframe:\S+/.exec(t)?.[0] ?? "?"}`,
    );
    // Finding (CI Chromium, 2026-11-05): 0. V8 adds a global binding to contexts created after
    // Runtime.addBinding only while the Runtime domain is enabled (v8-runtime-agent-impl.cc addBindings),
    // and the gate keeps Runtime off on purpose (a known automation signal), so the page — a later
    // context — has no reporter. The refusal itself holds (asserted above); only the note / audit is missing.
    console.log(`[R3] WebRTC refusals reported: ${told.filter((e) => e.kind === "webrtc").length}`);
    await host.close(spaceId);

    // A tab that is no Space's (no script): the launch switch alone must keep two local peers apart.
    const cdp = (proc as ChromiumProcess).cdp;
    const { targetId } = await cdp.send("Target.createTarget", { url: `${site.url}/blank` });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const raw = new CdpSession(cdp, String(sessionId));
    await sleep(300);
    const r = await raw.send("Runtime.evaluate", {
      expression: LOOPBACK,
      awaitPromise: true,
      returnByValue: true,
    });
    // Finding (CI Chromium, 2026-11-05): the switch does not keep a loopback data channel from opening, so
    // the agent-tab script above is what refuses WebRTC; the switch stays for non-proxied UDP to the outside.
    console.log(
      `[R3] loopback data channel with --force-webrtc-ip-handling-policy: ${JSON.stringify(r.result?.value)}`,
    );
    expect(["open", "timeout"]).toContain(r.result?.value);

    // Experiment (never fails): does Fetch pause a WebSocket? If it ever does, R3.5 can hold sockets up front.
    let paused = 0;
    const off = raw.on("Fetch.requestPaused", (e) => {
      paused++;
      void raw.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
    });
    // Finding (CI Chromium, 2026-11-05): Fetch.enable refuses the filter outright ("Unknown resource type in
    // fetch filter: 'WebSocket'"), so a socket cannot be held before it opens; the watch-and-stop path stays.
    const held = await raw
      .send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "WebSocket" }] })
      .then(() => "accepted")
      .catch((err: unknown) => `refused: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`[R3] Fetch.enable with resourceType WebSocket: ${held}`);
    await raw.send("Runtime.evaluate", {
      expression: `new Promise((r) => { const w = new WebSocket("ws://" + location.host + "/sock"); w.onopen = () => r(1); w.onerror = () => r(0); setTimeout(() => r(-1), 3000); })`,
      awaitPromise: true,
    });
    off();
    if (held === "accepted") await raw.send("Fetch.disable").catch(() => undefined);
    console.log(`[R3] Fetch.requestPaused for a WebSocket (resourceType WebSocket): ${paused}`);
    await cdp.send("Target.closeTarget", { targetId });
  });

  it("a WebSocket frame that looks like a send stops the tab (after it left); two stops make the host's sockets stop on open", async () => {
    told.length = 0;
    site.frames.length = 0;
    const { spaceId } = await host.open({ botId: BOT, title: "WS", url: `${site.url}/ws` });
    await step(spaceId, { do: "click", target: { role: "button", name: "打招呼" } });
    await until(() => site.frames.includes("hello"), "hello frame");
    await sleep(300);
    expect(tabUrl(spaceId)).toBe(`${site.url}/ws`);
    expect(told).toEqual([]);

    const clicked = (await step(spaceId, { do: "click", target: { role: "button", name: "按鈕甲" } })).output;
    await until(() => told.some((e) => e.outcome === "stopped"), "a stop");
    await until(() => tabUrl(spaceId) === "about:blank", "about:blank");
    expect(told[0]).toMatchObject({ kind: "websocket", outcome: "stopped", actionClass: "send" });
    // Honest about the limit: that first frame reached the server.
    await until(() => site.frames.some((f) => f.includes("sendMessage")), "the send frame at the server");
    // The model hears it from the click's step, or from the next one when the stop landed late.
    const next = (await step(spaceId, { do: "read" }, "read")).output;
    expect(clicked + next).toContain("可能已經生效");

    // Second strike on the same host, then any socket there stops as it opens.
    await step(spaceId, { do: "navigate", url: `${site.url}/ws` });
    await step(spaceId, { do: "click", target: { role: "button", name: "按鈕甲" } });
    await until(() => told.filter((e) => e.outcome === "stopped").length === 2, "the second stop");
    await step(spaceId, { do: "navigate", url: `${site.url}/ws` });
    await step(spaceId, { do: "click", target: { role: "button", name: "打招呼" } });
    await until(() => told.filter((e) => e.outcome === "stopped").length === 3, "a stop on open");
    expect(told.at(-1)?.reasons.join("")).toContain("已被停止 2 次");
    await until(() => tabUrl(spaceId) === "about:blank", "about:blank again");
    await host.close(spaceId);
  });
});
