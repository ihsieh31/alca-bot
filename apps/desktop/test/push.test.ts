import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostTool } from "@alca/core";
import { ScriptedEngine, type ScriptStep, streamText } from "@alca/engines";
import { generateIdentity, LinkClient, pairDevice } from "@alca/link";
import type { AlcaEvent } from "@alca/protocol";
import { startMockPushService } from "@alca/push/testing";
import { startRendezvous } from "@alca/rendezvous";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openVault } from "../src/data-dir.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * Web Push end to end: desktop core ⇄ rendezvous ⇄ headless phone; the phone
 * subscribes (over Link) at a mock push service that checks VAPID and
 * decrypts like a browser. A payment card must produce a push that says
 * "approval" + the card's id and nothing else.
 */

vi.setConfig({ testTimeout: 30_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const until = async (f: () => boolean, ms = 8000, what = "condition") => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

const payTool: HostTool = {
  spec: { name: "pay_invoice", description: "付一張帳單", inputSchema: { type: "object", properties: {} } },
  actionClass: "payment",
  run: async () => "已付 NT$1,280 給王小明",
};

const engine = () =>
  new ScriptedEngine(({ pass, req }): ScriptStep[] => {
    if (pass === 0 && req.userMessage.includes("付款"))
      return [
        { type: "tool.call", id: "p1", name: "pay_invoice", input: { to: "王小明", amount: 1280 } },
        { type: "done", stop: "tool_use" },
      ];
    return streamText("好", 1);
  });

async function boot() {
  const relay = await startRendezvous({ port: 0 });
  const mock = await startMockPushService();
  const dir = mkdtempSync(join(tmpdir(), "alca-push-e2e-"));
  const app: DesktopApp = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "direct",
    browser: "off",
    engineOverride: engine(),
    tools: [payTool],
    rendezvous: relay.url,
    pushAllowEndpoint: (e) => e.startsWith(mock.url),
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => relay.close(),
    () => mock.close(),
    () => app.close(),
  );
  const res = await fetch(`${app.server.url}/api/link/pairings`, {
    method: "POST",
    headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
    body: "{}",
  });
  const p = (await res.json()) as { display: string; coreFingerprint: string };
  const identity = await generateIdentity();
  const creds = await pairDevice({
    relayUrl: relay.url,
    code: p.display,
    identity,
    device: { name: "測試 iPhone", kind: "phone", platform: "headless" },
    expectFingerprint: p.coreFingerprint,
  });
  const client = new LinkClient({
    credentials: creds,
    identity,
    pingSec: 0,
    backoff: { first: 50, max: 300 },
  });
  const events: AlcaEvent[] = [];
  const notes: unknown[] = [];
  client.onEvent((ch, e) => {
    if (ch === "alca") events.push(e as AlcaEvent);
    if (ch === "notify") notes.push(e);
  });
  client.start();
  cleanups.push(() => client.stop());
  await until(() => client.status === "online", 8000, "phone online");
  return { app, mock, dir, client, events, notes, deviceId: creds.deviceId };
}

describe("Web Push from the core", () => {
  it("keeps the VAPID key on this computer and hands out only its public half", async () => {
    const b = await boot();
    // Phase D1: the VAPID key is in the vault, not in secrets.json.
    const secrets = JSON.parse(readFileSync(join(b.dir, "secrets.json"), "utf8")) as Record<string, string>;
    expect(secrets["push.vapidKey"]).toBeUndefined();
    const jwk = JSON.parse((await openVault(b.dir, "file").get("core.vapidKey")) as string) as {
      crv: string;
      d: string;
    };
    expect(jwk.crv).toBe("P-256");
    const cfg = await b.client.request<{ enabled: boolean; vapidPublicKey: string }>("push.config");
    expect(cfg.enabled).toBe(true);
    expect(Buffer.from(cfg.vapidPublicKey, "base64url").length).toBe(65);
    expect(JSON.stringify(cfg)).not.toContain(jwk.d);
  });

  it("pings a phone with only 'approval' + the card id; details come over Link", async () => {
    const b = await boot();
    const cfg = await b.client.request<{ vapidPublicKey: string }>("push.config");
    const sub = b.mock.subscribe(cfg.vapidPublicKey);
    const r = await b.client.request<{ endpointHost: string }>("push.subscribe", {
      endpoint: sub.endpoint,
      keys: sub.keys,
      userAgent: "test",
    });
    expect(r.endpointHost).toBe(new URL(b.mock.url).host);
    // A test ping first (the 傳一則測試通知 button).
    await b.client.request("push.test");
    expect(b.mock.received.at(-1)?.payload).toMatchObject({ v: 1, t: "test" });

    // The app went to the background: the next card is a push.
    await b.client.request("push.presence", { visible: false });
    const t = await b.client.request<{ id: string }>("threads.create", { title: "付款" });
    const { runId } = await b.client.request<{ runId: string }>("threads.send", {
      threadId: t.id,
      text: "幫我付款",
    });
    await until(() => b.mock.received.length >= 2, 8000, "push");
    const got = b.mock.received.at(-1);
    const card = b.app.core.store.human.pendingApprovals(runId)[0];
    expect(got?.payload).toEqual({ v: 1, t: "approval", id: card?.id });
    // Nothing of the card's content is in the push (the push service sees only ciphertext anyway).
    const dump = JSON.stringify(got);
    for (const s of ["王小明", "1280", "1,280", "pay_invoice", "payment", "付款"])
      expect(dump).not.toContain(s);
    expect(got?.bodyBytes).toBeLessThan(200);

    // Opened from the notification: where is that card?
    const loc = await b.client.request<{ threadId: string; status: string }>("cards.locate", {
      kind: "approval",
      id: card?.id,
    });
    expect(loc).toEqual({ kind: "approval", threadId: t.id, status: "pending" });
    await b.client.request("watch.thread", { threadId: t.id });
    const st = await b.client.request<{ activeEvents: AlcaEvent[] }>("threads.get", { threadId: t.id });
    expect(st.activeEvents.some((e) => e.type === "approval.requested")).toBe(true);
    // What the desktop shell's tray reads (loopback, token): one thing waits.
    const tray = await fetch(`${b.app.server.url}/api/status`, {
      headers: { authorization: `Bearer ${b.app.token}`, ...b.app.uiHeaders },
    });
    expect(await tray.json()).toMatchObject({ ok: true, waiting: { approvals: 1, questions: 0 } });
    expect((await fetch(`${b.app.server.url}/api/status`)).status).toBe(401);
    // The log keeps kinds and ids only.
    const log = b.app.core.store.push.events();
    expect(log[0]).toMatchObject({ kind: "approval", ref: card?.id, outcome: "sent", status: 201 });
  });

  it("設定 推播：不送 (pushPreview none) sends no Web Push at all (P13 B1)", async () => {
    const b = await boot();
    const cfg = await b.client.request<{ vapidPublicKey: string }>("push.config");
    const sub = b.mock.subscribe(cfg.vapidPublicKey);
    await b.client.request("push.subscribe", { endpoint: sub.endpoint, keys: sub.keys, userAgent: "test" });
    const res = await fetch(`${b.app.server.url}/api/settings`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${b.app.token}`,
        ...b.app.uiHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pushPreview: "none" }),
    });
    expect(res.status).toBe(200);
    await expect(b.client.request("push.test")).rejects.toThrow(/關閉/);
    await b.client.request("push.presence", { visible: false });
    const t = await b.client.request<{ id: string }>("threads.create", { title: "付款" });
    const { runId } = await b.client.request<{ runId: string }>("threads.send", {
      threadId: t.id,
      text: "幫我付款",
    });
    await until(() => b.app.core.store.human.pendingApprovals(runId).length > 0, 8000, "card");
    await until(() => b.app.core.store.push.events().length > 0, 8000, "push log");
    expect(b.mock.received).toHaveLength(0);
    expect(b.app.core.store.push.events()[0]).toMatchObject({ kind: "approval", outcome: "skipped" });
  });

  it("sends nothing while the app is in front (a Link event instead), and forgets gone subscriptions", async () => {
    const b = await boot();
    const cfg = await b.client.request<{ vapidPublicKey: string }>("push.config");
    const sub = b.mock.subscribe(cfg.vapidPublicKey);
    await b.client.request("push.subscribe", { endpoint: sub.endpoint, keys: sub.keys });
    await b.client.request("push.presence", { visible: true });
    const t = await b.client.request<{ id: string }>("threads.create", {});
    await b.client.request("threads.send", { threadId: t.id, text: "幫我付款" });
    await until(() => b.notes.length > 0, 8000, "in-app notify");
    expect(b.notes[0]).toMatchObject({ t: "approval" });
    expect(b.mock.received.length).toBe(0);

    await b.client.request("push.presence", { visible: false });
    b.mock.expire(sub.endpoint);
    const r = await b.app.push?.notify("question", "qst_x");
    expect(r?.[0]?.outcome).toBe("gone");
    expect(b.app.core.store.push.forDevice(b.deviceId)).toEqual([]);
  });

  it("refuses endpoints that are not push services, and a revoked phone's subscriptions go with it", async () => {
    const b = await boot();
    await expect(
      b.client.request("push.subscribe", {
        endpoint: "https://192.168.1.20/steal",
        keys: b.mock.subscribe("x").keys,
      }),
    ).rejects.toThrow(/推播服務/);
    const cfg = await b.client.request<{ vapidPublicKey: string }>("push.config");
    const sub = b.mock.subscribe(cfg.vapidPublicKey);
    await b.client.request("push.subscribe", { endpoint: sub.endpoint, keys: sub.keys });
    expect(b.app.core.store.push.forDevice(b.deviceId)).toHaveLength(1);
    b.app.link?.revoke(b.deviceId);
    expect(b.app.core.store.push.forDevice(b.deviceId)).toEqual([]);
    expect(() =>
      b.app.core.store.push.upsert(b.deviceId, {
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
      }),
    ).toThrow(/revoked/);
  });

  it("comes back from the background: one quick ping, a fresh session at once when it does not answer", async () => {
    const b = await boot();
    expect(await b.client.resume(2000)).toBe(true);
    expect(b.client.stats.lastRttMs).toBeGreaterThanOrEqual(0);
    const before = b.client.stats.connects;
    // A socket that looks open but no longer answers (a frozen iOS page): the ping times out.
    const peer = (
      b.client as unknown as { peer: { request: (op: string, a: unknown, ms: number) => Promise<unknown> } }
    ).peer;
    peer.request = (_op, _a, ms) => new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms));
    expect(await b.client.resume(150)).toBe(false);
    await until(
      () => b.client.status === "online" && b.client.stats.connects === before + 1,
      8000,
      "fresh session",
    );
    expect(await b.client.request("ping")).toBe("pong");
  });
});
