import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, LinkClient, pairDevice } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Outbox } from "../../phone-pwa/app/offline.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * P13: a phone's queued sends reach the core exactly once. `threads.send` /
 * `threads.create` with a client key run at most once per (device, key) —
 * stored in the database, so it holds across a core restart too — and the
 * phone's outbox, flushed after it was offline, retried and flushed twice at
 * once, still makes one message each.
 */

vi.setConfig({ testTimeout: 30_000 });

const until = async (f: () => boolean | Promise<boolean>, ms = 8000) => {
  const t = Date.now();
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("phone × queued sends, once each", () => {
  let app: DesktopApp;
  let relay: Awaited<ReturnType<typeof startRendezvous>>;
  let dir: string;
  const clients: LinkClient[] = [];
  const boot = () =>
    startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "off",
      vaultKeySource: "file",
      rendezvous: relay.url,
    });
  const userMessages = (threadId: string) =>
    app.core
      .messages(threadId)
      .filter((m) => m.role === "user")
      .map((m) => m.content);
  let phone: { client: LinkClient; deviceId: string };
  let onceThread = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-link-outbox-"));
    relay = await startRendezvous({ port: 0 });
    app = await boot();
    const res = await fetch(`${app.server.url}/api/link/pairings`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["chat"] }),
    });
    const p = (await res.json()) as { display: string; coreFingerprint: string };
    const identity = await generateIdentity();
    const credentials = await pairDevice({
      relayUrl: relay.url,
      code: p.display,
      identity,
      device: { name: "測試 iPhone", kind: "phone", platform: "headless" },
      expectFingerprint: p.coreFingerprint,
    });
    const client = new LinkClient({ credentials, identity, pingSec: 0, backoff: { first: 50, max: 300 } });
    clients.push(client);
    client.start();
    await until(() => client.status === "online");
    phone = { client, deviceId: credentials.deviceId };
  }, 30_000);
  afterAll(async () => {
    for (const c of clients) c.stop();
    await app?.close();
    await relay?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the same client key sends once and answers the first result again", async () => {
    const c = phone.client;
    const t = await c.request<{ id: string }>("threads.create", {
      title: "一次",
      clientKey: "key_create_0001",
    });
    onceThread = t.id;
    const again = await c.request<{ id: string; duplicate?: boolean }>("threads.create", {
      title: "一次",
      clientKey: "key_create_0001",
    });
    expect(again).toMatchObject({ id: t.id, duplicate: true });
    const first = await c.request<{ runId: string }>("threads.send", {
      threadId: t.id,
      text: "只送一次",
      clientKey: "key_send_00001",
    });
    await until(() => !app.core.isBusy(t.id));
    const dup = await c.request<{ runId: string; duplicate?: boolean }>("threads.send", {
      threadId: t.id,
      text: "只送一次",
      clientKey: "key_send_00001",
    });
    expect(dup).toEqual({ runId: first.runId, duplicate: true });
    expect(userMessages(t.id)).toEqual(["只送一次"]);
    // A key belongs to one operation; malformed keys are refused; no key = as before.
    await expect(
      c.request("threads.send", { threadId: t.id, text: "x", clientKey: "key_create_0001" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      c.request("threads.send", { threadId: t.id, text: "x", clientKey: "短" }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("a busy conversation stores nothing, so the same key goes through once it is free", async () => {
    const c = phone.client;
    const t = await c.request<{ id: string }>("threads.create", { title: "忙碌" });
    await c.request("threads.send", { threadId: t.id, text: "給我一段長一點的回答" });
    await expect(
      c.request("threads.send", { threadId: t.id, text: "排隊的", clientKey: "key_busy_00001" }),
    ).rejects.toMatchObject({ code: "busy" });
    await until(() => !app.core.isBusy(t.id), 15_000);
    await c.request("threads.send", { threadId: t.id, text: "排隊的", clientKey: "key_busy_00001" });
    await until(() => !app.core.isBusy(t.id), 15_000);
    expect(userMessages(t.id)).toEqual(["給我一段長一點的回答", "排隊的"]);
  });

  it("a key is reserved before the send: a crash between send and result is found, not sent again", async () => {
    const c = phone.client;
    const t = await c.request<{ id: string }>("threads.create", { title: "當機" });
    const ops = app.core.store.clientOps;
    // A crash after the message was written but before its result was stored:
    // the reservation is pending and the message is there.
    ops.reserve(phone.deviceId, "key_crash_sent1", "threads.send");
    const { runId, done } = app.core.send(t.id, "當機前送出的", {
      initiator: { kind: "user", id: `device:${phone.deviceId}` },
    });
    await done;
    const found = await c.request<{ runId: string; duplicate?: boolean }>("threads.send", {
      threadId: t.id,
      text: "當機前送出的",
      clientKey: "key_crash_sent1",
    });
    expect(found).toEqual({ runId, duplicate: true });
    expect(ops.get(phone.deviceId, "key_crash_sent1")?.state).toBe("done");
    // A crash after the reservation but before the send: nothing written, so it is sent now — once.
    ops.reserve(phone.deviceId, "key_crash_none1", "threads.send");
    const sent = await c.request<{ runId: string; duplicate?: boolean }>("threads.send", {
      threadId: t.id,
      text: "當機前沒送出的",
      clientKey: "key_crash_none1",
    });
    expect(sent.duplicate).toBeUndefined();
    await until(() => !app.core.isBusy(t.id));
    // The same text sent again under another key is its own message, never mistaken for the first.
    ops.reserve(phone.deviceId, "key_crash_same1", "threads.send");
    const other = await c.request<{ runId: string; duplicate?: boolean }>("threads.send", {
      threadId: t.id,
      text: "當機前送出的",
      clientKey: "key_crash_same1",
    });
    expect(other.duplicate).toBeUndefined();
    expect(other.runId).not.toBe(runId);
    await until(() => !app.core.isBusy(t.id));
    expect(userMessages(t.id)).toEqual(["當機前送出的", "當機前沒送出的", "當機前送出的"]);
    // A busy thread frees its key (nothing written); a pending row never stays behind.
    expect(ops.get(phone.deviceId, "key_busy_00001")?.state).toBe("done");
  });

  it("the phone's outbox: typed offline, flushed twice at once and again after a restart — one message each", async () => {
    const c = phone.client;
    const t = await c.request<{ id: string }>("threads.create", { title: "離線" });
    const box = new Outbox(undefined);
    box.busyRetryMs = 50;
    c.stop(); // offline
    await box.add("離線打的第一則", t.id, null);
    await box.add("離線開的新對話", null, null, "draft_1");
    const api = {
      online: () => c.status === "online",
      request: <T>(op: string, args: Record<string, unknown>) => c.request<T>(op, args),
    };
    await box.flush(api);
    expect(box.items.every((i) => i.state === "queued")).toBe(true);
    c.start();
    await until(() => c.status === "online");
    await Promise.all([box.flush(api), box.flush(api)]);
    await until(() => box.items.length === 0, 15_000);
    await until(() => !app.core.isBusy(t.id), 15_000);
    expect(userMessages(t.id)).toEqual(["離線打的第一則"]);
    const created = app.core.listThreads().filter((x) => x.title === "離線開的新對話");
    expect(created).toHaveLength(1);

    // The core restarts; a phone that never got its answer flushes the same key again: still one message.
    expect(app.core.store.clientOps.get(phone.deviceId, "key_send_00001")).toBeDefined();
    await app.close();
    app = await boot();
    await until(() => c.status === "online", 15_000);
    const replay = await c.request<{ duplicate?: boolean }>("threads.send", {
      threadId: onceThread,
      text: "只送一次",
      clientKey: "key_send_00001",
    });
    expect(replay.duplicate).toBe(true);
    expect(userMessages(onceThread)).toEqual(["只送一次"]);
  });
});
