// Network-layer gate against a real Chromium: a button with a harmless label
// whose script POSTs to a checkout endpoint, in the page and in a cross-site
// (out-of-process) frame. Skips when no Chromium is installed.
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
  type ChromiumProcess,
  findChromium,
  launchChromium,
  type NetworkConfirmRequest,
} from "../src/index.ts";

const bin = process.env.ALCA_TEST_CHROMIUM || findChromium();
const BOT = "bot_00000000000000000000000001";
const sig = () => AbortSignal.timeout(30_000);

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>網路閘門</title></head><body>${body}</body></html>`;
const POSTER = (label: string, path: string) =>
  `<button id="b" onclick="fetch('${path}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sku:1})}).then(r=>r.text()).then(t=>{document.getElementById('s').textContent='結果:'+t}).catch(()=>{document.getElementById('s').textContent='結果:被擋'})">${label}</button><p id="s">結果:無</p>`;

async function startSite(): Promise<{ url: string; other: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  let port = 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method !== "GET") hits.push(`${req.method} ${u.pathname}`);
    if (u.pathname === "/")
      return void res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(
          page(
            `${POSTER("繼續", "/api/checkout")}<button id="g" onclick="fetch('/api/items').then(r=>r.text()).then(t=>{document.getElementById('s').textContent='結果:'+t})">載入</button><iframe src="http://localhost:${port}/frame" title="跨站框" width="400" height="120"></iframe>`,
          ),
        );
    if (u.pathname === "/frame")
      return void res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(page(POSTER("框內繼續", "/api/messages/send")));
    if (u.pathname === "/api/items") return void res.writeHead(200).end("3 items");
    if (u.pathname.startsWith("/api/")) return void res.writeHead(200).end("ok");
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, other: `http://localhost:${port}`, server, hits };
}

// A real browser: 5 s was too tight when the suite ran in parallel (mac test: 2/2 timed out, 1.5 s alone).
describe.skipIf(!bin)("network-layer gate × real Chromium", { timeout: 30_000 }, () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let dir: string;
  let host: BrowserHost;
  let agent: BrowserAgent;
  let proc: ChromiumProcess | undefined;
  const asked: NetworkConfirmRequest[] = [];
  let answer = false;

  beforeAll(async () => {
    site = await startSite();
    dir = mkdtempSync(join(tmpdir(), "alca-net-"));
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
        return answer;
      },
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
  const until = async (spaceId: string, want: string) => {
    for (let i = 0; i < 50; i++) {
      const t = await text(spaceId);
      if (t.includes(want)) return t;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never saw ${want}`);
  };

  it("lets reads through, holds a harmless-looking checkout POST for a yes, and blocks it on a no", async () => {
    const { spaceId } = await host.open({ botId: BOT, title: "網路", url: `${site.url}/` });
    await step(spaceId, { do: "click", target: { role: "button", name: "載入" } });
    await until(spaceId, "結果:3 items");
    expect(asked).toEqual([]);

    answer = false;
    const out = (await step(spaceId, { do: "click", target: { role: "button", name: "繼續" } })).output;
    expect(asked.map((a) => a.actionClass)).toEqual(["payment"]);
    expect(asked[0]?.url).toBe(`${site.url}/api/checkout`);
    expect(out).toContain("網路層閘門");
    expect(out).toContain("已攔下");
    await until(spaceId, "結果:被擋");
    expect(site.hits).toEqual([]);

    answer = true;
    const ok = (await step(spaceId, { do: "click", target: { role: "button", name: "繼續" } })).output;
    expect(ok).toContain("已放行");
    await until(spaceId, "結果:ok");
    expect(site.hits).toEqual(["POST /api/checkout"]);
    expect(asked.length).toBe(2);
  });

  it("a step approved for payment needs no second card; a cross-site frame's send is gated too", async () => {
    asked.length = 0;
    site.hits.length = 0;
    const { spaceId } = await host.open({ botId: BOT, title: "網路2", url: `${site.url}/` });
    await step(spaceId, { do: "click", target: { role: "button", name: "繼續" } }, "payment");
    await until(spaceId, "結果:ok");
    expect(asked).toEqual([]);
    expect(site.hits).toEqual(["POST /api/checkout"]);

    answer = false;
    await step(spaceId, { do: "snapshot" }, "read");
    await step(spaceId, { do: "click", target: { role: "button", name: "框內繼續" } });
    expect(asked.map((a) => [a.actionClass, a.url])).toEqual([["send", `${site.other}/api/messages/send`]]);
    expect(site.hits).toEqual(["POST /api/checkout"]);
  });
});
