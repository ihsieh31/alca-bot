import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import { type Rendezvous, startRendezvous } from "@alca/rendezvous";
import { openStore, type Store, type TriggerRecord } from "@alca/store";
import type { TriggerEventInput } from "@alca/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAppTrigger, HookPuller, signWebhook, verifySignature } from "../src/hooks.ts";
import { ConnectorService } from "../src/service.ts";
import { FileKeySource, Vault } from "../src/vault.ts";
import { type MockComposio, startMockComposio } from "../testing/mock-composio.ts";

let dir: string;
let store: Store;
let mock: MockComposio;
let relay: Rendezvous;
let svc: ConnectorService;
let vault: Vault;
let fired: Array<{ triggerId: string; ev: TriggerEventInput }>;
let puller: HookPuller;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "alca-hooks-"));
  store = openStore(join(dir, "s.sqlite"));
  mock = await startMockComposio();
  relay = await startRendezvous({ port: 0 });
  vault = new Vault(join(dir, "vault.json"), new FileKeySource(join(dir, "vault.key")));
  const s = parseSettings({ engineering: { connectors: { composioBaseUrl: mock.baseUrl } } });
  svc = new ConnectorService({ store, vault, settings: () => s });
  fired = [];
  puller = new HookPuller({
    store,
    vault,
    service: svc,
    relayUrl: relay.url,
    fire: async (triggerId, ev) => {
      fired.push({ triggerId, ev });
    },
  });
});
afterEach(async () => {
  await relay.close();
  await mock.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("webhook signatures", () => {
  it("accepts the provider's scheme and refuses anything else", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook("s3cret", "msg_1", ts, '{"a":1}');
    expect(verifySignature("s3cret", { id: "msg_1", timestamp: ts, signature: sig }, '{"a":1}')).toBe(true);
    expect(verifySignature("s3cret", { id: "msg_1", timestamp: ts, signature: sig }, '{"a":2}')).toBe(false);
    expect(verifySignature("other", { id: "msg_1", timestamp: ts, signature: sig }, '{"a":1}')).toBe(false);
    expect(
      verifySignature(
        "s3cret",
        { id: "msg_1", timestamp: "1", signature: signWebhook("s3cret", "msg_1", "1", "{}") },
        "{}",
      ),
    ).toBe(false);
  });
});

describe("app triggers through the person's relay", () => {
  it("provider → relay mailbox → core pull → verified, deduplicated, fired into its P3 trigger", async () => {
    await svc.setKey(mock.key);
    const bot = store.bots.ensureDefault().id;
    const th = store.threads.create("thr_TEST0000000000000000000002", "信", new Date(), bot);
    const link = await svc.connect({ toolkit: "gmail", label: "工作" });
    mock.complete(mock.accounts[0]?.id as string);
    await svc.refresh();
    const created: TriggerRecord[] = [];
    const r = await enableAppTrigger(
      {
        store,
        service: svc,
        puller,
        createTrigger: (t) => {
          const rec = store.triggers.create({
            botId: bot,
            threadId: t.threadId,
            name: t.name,
            source: t.source,
            config: t.config ?? {},
            rule: (t.rule ?? {}) as Record<string, unknown>,
            semantic: null,
          });
          created.push(rec);
          return rec;
        },
      },
      { accountId: link.account.id, slug: "GMAIL_NEW_GMAIL_MESSAGE", threadId: th.id },
    );
    expect(created[0]?.source).toBe("email");
    const ti = mock.triggers[0];
    expect(ti?.egressUrl).toBe(puller.hookUrl());
    expect(ti?.egressUrl?.startsWith(relay.url)).toBe(true);

    const data = {
      subject: "明天的會",
      sender: "lin@example.com",
      preview: "可以改到下午嗎？",
      thread_id: "t9",
    };
    expect(await mock.emit(ti?.id as string, data, { id: "msg_a" })).toBe(200);
    expect(await mock.emit(ti?.id as string, data, { id: "msg_a" })).toBe(200); // provider retry
    expect(await mock.emit(ti?.id as string, data, { badSignature: true })).toBe(200);
    const p = await puller.pull();
    expect(p).toMatchObject({ received: 3, fired: 1, duplicates: 1, rejected: 1 });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.triggerId).toBe(r.triggerId);
    expect(fired[0]?.ev).toMatchObject({ from: "lin@example.com", streamKey: "gmail:t9" });
    expect(fired[0]?.ev.text).toContain("明天的會");
    // Acknowledged: the next pull gets nothing again.
    expect((await puller.pull()).received).toBe(0);
  });

  it("a relay that forgot the mailbox (counter behind ours) still delivers; a new mailbox resets the cursor", async () => {
    await svc.setKey(mock.key);
    store.connectors.setMeta("relay.hookSeq", "42");
    await puller.register(); // 201: a fresh mailbox
    expect(store.connectors.meta("relay.hookSeq")).toBe("0");
    await puller.register(); // 200: ours already, the cursor stays
    store.connectors.setMeta("relay.hookSeq", "42"); // as if the relay restarted without a file
    const secret = await puller.ensureSecret();
    const body = JSON.stringify({ id: "x", type: "composio.trigger.message", metadata: {}, data: {} });
    const ts = String(Math.floor(Date.now() / 1000));
    await fetch(puller.hookUrl(), {
      method: "POST",
      headers: {
        "webhook-id": "msg_z",
        "webhook-timestamp": ts,
        "webhook-signature": signWebhook(secret, "msg_z", ts, body),
      },
      body,
    });
    const out = await puller.pull();
    expect(out.received).toBe(1);
    expect(out.rejected).toBe(0);
    expect(store.connectors.meta("relay.hookSeq")).toBe("1");
  });

  it("someone without the pull token cannot read the mailbox; a read failure keeps the cursor", async () => {
    await puller.register();
    const res = await fetch(`${puller.hookUrl()}/events?after=0`, { headers: { "x-alca-pull": "guess" } });
    expect(res.status).toBe(403);
    const broken = new HookPuller({
      store,
      vault,
      service: svc,
      relayUrl: "http://127.0.0.1:9",
      fire: async () => undefined,
    });
    store.connectors.setMeta("relay.hookSeq", "7");
    const out = await broken.pull();
    expect(out.error).toBeTruthy();
    expect(store.connectors.meta("relay.hookSeq")).toBe("7");
  });
});
