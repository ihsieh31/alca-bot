// P13: the network-layer gate's approval cards and the first-run Chromium
// download wiring on the desktop (no Chromium needed).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromiumInstaller, type NetworkConfirmRequest } from "@alca/browser";
import type { AlcaCore } from "@alca/core";
import type { BrowserEvent } from "@alca/protocol";
import { openStore } from "@alca/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeZip } from "../../../packages/browser/testing/zip-writer.ts";
import { createBrowser } from "../src/browser.ts";
import { CHANNEL_STOPPED, channelNotifier, networkConfirmer } from "../src/browser-gate.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";

describe("network-layer gate → approval cards", () => {
  let app: DesktopApp;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-netgate-"));
    app = await startDesktop({ engine: "demo", dataDir: dir, port: 0, agents: "direct", browser: "off" });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const req = (over: Partial<NetworkConfirmRequest> = {}): NetworkConfirmRequest => ({
    spaceId: "space_00000000000000000000000001",
    botId: app.core.store.bots.default()!.id,
    threadId: "thr_00000000000000000000000001",
    actionClass: "payment",
    method: "POST",
    url: "https://shop.example.com/api/checkout",
    reasons: ["網址 /api/checkout"],
    summary: "網路層：網頁要送出 POST shop.example.com/api/checkout（網址 /api/checkout）",
    ...over,
  });
  /** The real gateway, with the run the card would show in stubbed. */
  const core = (emitted: Array<{ type: string; data: Record<string, unknown> }>, live = true) =>
    ({
      gateway: app.core.gateway,
      emitToActiveRun: (_t: string, type: string, data: Record<string, unknown>) => {
        if (!live) return undefined;
        emitted.push({ type, data });
        return { type, data };
      },
    }) as unknown as AlcaCore;

  it("puts up an audited payment card in the owning run and lets the request go only on a yes", async () => {
    const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
    const confirm = networkConfirmer(core(emitted), undefined, { pollMs: 5 });
    const p = confirm(req(), new AbortController().signal);
    for (let i = 0; i < 100 && !emitted.length; i++) await new Promise((r) => setTimeout(r, 5));
    const card = emitted[0];
    expect(card?.type).toBe("approval.requested");
    expect(card?.data).toMatchObject({ actionClass: "payment" });
    expect(String(card?.data.summary)).toContain("網路層");
    const id = String(card?.data.approvalId);
    expect(app.core.gateway.approval(id)?.status).toBe("pending");
    app.core.answerApproval(id, "approved");
    expect(await p).toBe(true);
    expect(emitted.at(-1)).toMatchObject({
      type: "approval.resolved",
      data: { approvalId: id, decision: "approved" },
    });

    const p2 = confirm(req({ actionClass: "delete", method: "DELETE" }), new AbortController().signal);
    for (let i = 0; i < 100 && emitted.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    app.core.answerApproval(String(emitted[2]?.data.approvalId), "denied");
    expect(await p2).toBe(false);
  });

  it("blocks when no run can show the card, on abort, and on time-out (the card expires)", async () => {
    const before = app.core.store.human.pendingApprovals().length;
    const none = networkConfirmer(core([], false), undefined, { pollMs: 5 });
    expect(await none(req(), new AbortController().signal)).toBe(false);
    // The card nobody could see was closed, not left pending.
    expect(app.core.store.human.pendingApprovals().length).toBe(before);

    const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
    const ac = new AbortController();
    const p = networkConfirmer(core(emitted), undefined, { pollMs: 5 })(req(), ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    expect(await p).toBe(false);
    expect(app.core.gateway.approval(String(emitted[0]?.data.approvalId))?.status).toBe("expired");
    expect(emitted.at(-1)?.data).toMatchObject({ decision: "expired" });

    const quick = networkConfirmer(core([]), undefined, { pollMs: 5, timeoutMs: 20 });
    expect(await quick(req(), new AbortController().signal)).toBe(false);
    expect(app.core.store.human.pendingApprovals().length).toBe(before);
  });
});

describe("R3: a stopped WebSocket tab → a notice in the run and an audit row", () => {
  let app: DesktopApp;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-chan-"));
    app = await startDesktop({ engine: "demo", dataDir: dir, port: 0, agents: "direct", browser: "off" });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const rows = () =>
    app.core.store.db
      .prepare(
        "SELECT action, action_class, target, decision, detail FROM audit_log WHERE action LIKE 'browser.channel.%' ORDER BY id",
      )
      .all() as Array<{
      action: string;
      action_class: string;
      target: string;
      decision: string;
      detail: string;
    }>;

  it("writes browser.channel.stopped and shows a notice (not an approval card) in the owning run", () => {
    const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
    const core = {
      store: app.core.store,
      emitToActiveRun: (_t: string, type: string, data: Record<string, unknown>) => {
        emitted.push({ type, data });
        return { type, data };
      },
    } as unknown as AlcaCore;
    const notify = channelNotifier(core);
    const botId = app.core.store.bots.default()!.id;
    notify({
      spaceId: "space_00000000000000000000000001",
      botId,
      threadId: "thr_00000000000000000000000001",
      kind: "websocket",
      outcome: "stopped",
      actionClass: "send",
      url: "wss://chat.example.com/socket",
      reasons: ["GraphQL sendMessage"],
    });
    notify({
      spaceId: "space_00000000000000000000000001",
      botId,
      threadId: "thr_00000000000000000000000001",
      kind: "webrtc",
      outcome: "blocked",
      actionClass: "write",
      url: "https://meet.example.com/r",
      reasons: ["代理人分頁不允許 WebRTC"],
    });
    expect(rows().map((r) => [r.action, r.action_class, r.decision])).toEqual([
      ["browser.channel.stopped", "send", "deny"],
      ["browser.channel.blocked", "write", "deny"],
    ]);
    expect(JSON.parse(rows()[0]?.detail ?? "{}")).toMatchObject({
      kind: "websocket",
      reasons: ["GraphQL sendMessage"],
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "error", data: { code: CHANNEL_STOPPED, retryable: false } });
    expect(String(emitted[0]?.data.message)).toContain("可能已經生效");
    expect(String(emitted[0]?.data.message)).toContain("chat.example.com");
  });
});

describe("first-run Chromium download wiring", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const zip = makeZip([
      { name: "chrome-linux64/" },
      { name: "chrome-linux64/chrome", data: "#!/bin/sh\n", mode: 0o100755 },
    ]);
    server = createServer((rq, res) => {
      if (rq.url === "/index.json")
        return void res.end(
          JSON.stringify({
            channels: {
              Stable: {
                version: "150.0.0.9",
                downloads: { chrome: [{ platform: "linux64", url: `${base}/chrome-linux64.zip` }] },
              },
            },
          }),
        );
      res.writeHead(200, { "content-length": zip.length }).end(zip);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("streams install progress on the browser channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-cft-"));
    const store = openStore(join(dir, "db.sqlite"));
    const installer = new ChromiumInstaller({
      dir: join(dir, "browser", "bin"),
      indexUrl: `${base}/index.json`,
      platform: "linux",
      arch: "x64",
    });
    const setup = createBrowser({ dataDir: dir, store, mode: "headless", installer });
    expect(setup?.autoInstall()).toBe(false);
    const seen: BrowserEvent[] = [];
    setup?.host.subscribe((e) => seen.push(e));
    const exe = await installer.ensure();
    expect(exe).toContain(join("browser", "bin", "chrome-linux64", "chrome"));
    const phases = seen
      .filter((e) => e.type === "browser.install")
      .map((e) => (e.data as { phase: string }).phase);
    expect(phases[0]).toBe("checking");
    expect(phases.at(-1)).toBe("ready");
    // The executable's path stays on the computer: events carry no `executable`.
    expect(JSON.stringify(seen)).not.toContain("chrome-linux64/chrome");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
