// Review M3: the Workers relay has the same `/v0/hooks` webhook mailboxes as
// the Node relay. One scenario runs against both — the Node relay over HTTP,
// the Worker with its runtime faked (a Map-backed Durable Object storage and a
// namespace that keeps one object per name).
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { startRendezvous } from "../../rendezvous/src/server.ts";
import type { DurableNamespace, DurableState, DurableStorage, RelayEnv } from "../src/cf-types.ts";
import { HookObject } from "../src/hooks.ts";
import worker from "../src/worker.ts";

class MapStorage implements DurableStorage {
  m = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(k: string) {
    return this.m.get(k) as T | undefined;
  }
  async list<T>(o: { prefix?: string } = {}) {
    return new Map([...this.m].filter(([k]) => k.startsWith(o.prefix ?? ""))) as Map<string, T>;
  }
  async put(e: Record<string, unknown>) {
    for (const [k, v] of Object.entries(e)) this.m.set(k, structuredClone(v));
  }
  async delete(keys: string[]) {
    let n = 0;
    for (const k of keys) n += this.m.delete(k) ? 1 : 0;
    return n;
  }
  async deleteAll() {
    this.m.clear();
    this.alarm = null;
  }
  async setAlarm(t: number) {
    this.alarm = t;
  }
}

/** A HOOKS namespace whose objects live as long as the test (one per mailbox id). */
function hooksNamespace(now = () => Date.now()) {
  const objects = new Map<string, { obj: HookObject; storage: MapStorage }>();
  const ns: DurableNamespace = {
    idFromName: (n: string) => n,
    get: (id: unknown) => {
      const key = String(id);
      let o = objects.get(key);
      if (!o) {
        const storage = new MapStorage();
        const state: DurableState = { storage, blockConcurrencyWhile: (f) => f() };
        o = { obj: new HookObject(state, {}, { now }), storage };
        objects.set(key, o);
      }
      return o.obj;
    },
  };
  return { ns, objects };
}

const ID = "box_0123456789abcdefghijkl";
const TOKEN = "pull-token-0123456789";
const pull = createHash("sha256").update(TOKEN).digest("hex");

type Call = (path: string, init?: RequestInit) => Promise<Response>;

/** The protocol, step by step (services/rendezvous/src/hooks.ts header). */
async function scenario(call: Call) {
  const put = (body: unknown) => call(`/v0/hooks/${ID}`, { method: "PUT", body: JSON.stringify(body) });
  expect((await put({ pull: "nothex" })).status).toBe(400);
  // Unknown mailbox: a delivery is refused.
  expect((await call(`/v0/hooks/${ID}`, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await put({ pull })).status).toBe(201);
  expect((await put({ pull })).status).toBe(200); // the same owner again
  expect((await put({ pull: "0".repeat(64) })).status).toBe(409); // someone else
  for (const n of [1, 2, 3])
    expect(
      (
        await call(`/v0/hooks/${ID}`, {
          method: "POST",
          headers: {
            "webhook-id": `msg_${n}`,
            "webhook-timestamp": "1700000000",
            "webhook-signature": "v1,abc",
            "x-other": "dropped",
          },
          body: JSON.stringify({ n }),
        })
      ).status,
    ).toBe(200);
  const events = (after: number, token = TOKEN) =>
    call(`/v0/hooks/${ID}/events?after=${after}`, { headers: { "x-alca-pull": token } });
  expect((await events(0, "wrong")).status).toBe(403);
  const r0 = (await (await events(0)).json()) as {
    items: Array<{ seq: number; headers: Record<string, string>; body: string }>;
    seq: number;
  };
  expect(r0.seq).toBe(3);
  expect(r0.items.map((i) => i.seq)).toEqual([1, 2, 3]);
  expect(r0.items[0]?.headers).toEqual({
    "webhook-id": "msg_1",
    "webhook-timestamp": "1700000000",
    "webhook-signature": "v1,abc",
  });
  expect(JSON.parse(r0.items[2]?.body ?? "")).toEqual({ n: 3 });
  // after=2 acknowledges 1 and 2.
  expect(
    ((await (await events(2)).json()) as { items: Array<{ seq: number }> }).items.map((i) => i.seq),
  ).toEqual([3]);
  // A counter past ours (the relay started over): nothing is dropped.
  expect(((await (await events(99)).json()) as { items: unknown[] }).items).toHaveLength(1);
  // Too large a body.
  expect((await call(`/v0/hooks/${ID}`, { method: "POST", body: "x".repeat(256 * 1024 + 1) })).status).toBe(
    413,
  );
  // Bad ids and methods.
  expect((await call("/v0/hooks/short", { method: "PUT", body: "{}" })).status).toBe(404);
  expect((await call(`/v0/hooks/${ID}/events/x`)).status).toBe(404);
  expect((await call(`/v0/hooks/${ID}`, { method: "DELETE" })).status).toBe(405);
}

const nodeRelay = await startRendezvous({ port: 0 });
afterAll(() => nodeRelay.close());

describe("webhook mailboxes: the Worker relay speaks the Node relay's protocol", () => {
  it("Node relay", async () => {
    await scenario((path, init) => fetch(`${nodeRelay.url}${path}`, init));
  });

  it("Worker relay (one Durable Object per mailbox)", async () => {
    const { ns, objects } = hooksNamespace();
    const env = { RELAY: ns, HOOKS: ns } as unknown as RelayEnv;
    await scenario((path, init) => worker.fetch(new Request(`https://relay.example${path}`, init), env));
    expect([...objects.keys()]).toEqual([ID]); // the bad id never reached an object
    const st = objects.get(ID)?.storage as MapStorage;
    // Only the hash of the pull token is kept, never the token.
    expect(JSON.stringify([...st.m])).not.toContain(TOKEN);
    expect(st.alarm).not.toBeNull();
  });

  it("Worker: events expire after a day, an idle empty mailbox is removed after a week", async () => {
    let t = Date.parse("2026-11-04T00:00:00Z");
    const { ns, objects } = hooksNamespace(() => t);
    const env = { RELAY: ns, HOOKS: ns } as unknown as RelayEnv;
    const call: Call = (path, init) => worker.fetch(new Request(`https://relay.example${path}`, init), env);
    expect((await call(`/v0/hooks/${ID}`, { method: "PUT", body: JSON.stringify({ pull }) })).status).toBe(
      201,
    );
    await call(`/v0/hooks/${ID}`, { method: "POST", headers: { "webhook-id": "m1" }, body: "{}" });
    const box = objects.get(ID) as { obj: HookObject; storage: MapStorage };
    t += 25 * 3600_000;
    await box.obj.alarm();
    expect([...box.storage.m.keys()]).toEqual(["box"]);
    t += 8 * 24 * 3600_000;
    await box.obj.alarm();
    expect(box.storage.m.size).toBe(0);
    // Gone: the same id registers as new.
    expect((await call(`/v0/hooks/${ID}`, { method: "PUT", body: JSON.stringify({ pull }) })).status).toBe(
      201,
    );
  });

  it("Worker without a HOOKS binding answers 404 with a reason", async () => {
    const { ns } = hooksNamespace();
    const r = await worker.fetch(new Request(`https://relay.example/v0/hooks/${ID}`, { method: "PUT" }), {
      RELAY: ns,
    } as unknown as RelayEnv);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: expect.stringContaining("HOOKS") });
  });
});
