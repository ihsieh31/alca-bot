// The Cloudflare Workers variant (P10) with the runtime faked: a
// WebSocketPair of two linked sockets and a Map-backed Durable Object
// storage. The real LinkHost, phone enrollment and session run through it.
import {
  enrollDevice,
  generateIdentity,
  LinkClient,
  LinkHost,
  listComputers,
  type WebSocketLike,
} from "@alca/link";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type FakeGoogle, startFakeGoogle } from "../../rendezvous/test/fake-google.ts";
import { MemoryDevices, until } from "../../rendezvous/test/helpers.ts";
import type { CfWebSocket, DurableState, DurableStorage, RelayEnv } from "../src/cf-types.ts";
import worker, { RelayObject } from "../src/worker.ts";

// SPAKE2 point math in plain BigInt is slow on a loaded CI runner.
vi.setConfig({ testTimeout: 20_000 });

class FakeSocket implements CfWebSocket {
  peer!: FakeSocket;
  readyState = 1;
  private h: Record<string, Array<(e: { data: string }) => void>> = {};
  accept() {}
  addEventListener(type: string, f: (e: { data: string }) => void) {
    const list = this.h[type] ?? [];
    list.push(f);
    this.h[type] = list;
  }
  emit(type: string, data = "") {
    for (const f of this.h[type] ?? []) f({ data });
  }
  send(data: string) {
    if (this.readyState !== 1) return;
    queueMicrotask(() => this.peer.emit("message", data));
  }
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.peer.readyState = 3;
    queueMicrotask(() => {
      this.emit("close");
      this.peer.emit("close");
    });
  }
}

function fakePair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class MapStorage implements DurableStorage {
  m = new Map<string, unknown>();
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
}

const WEB = "test-web.apps.googleusercontent.com";
const DESKTOP = "test-desktop.apps.googleusercontent.com";
let google: FakeGoogle;
beforeAll(async () => {
  google = await startFakeGoogle();
});
afterAll(() => google.close());

/** A Google subject no random key material can contain (a '.', a '@' and a '#'). */
const SUB = "w1.sub@google#test";

/** Every string anywhere in a value (map keys and values, nested). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (v instanceof Map) for (const [k, x] of v) strings(k, strings(x, out));
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(k, strings(x, out));
  return out;
}

function deploy(storage = new MapStorage()) {
  const state: DurableState = { storage, blockConcurrencyWhile: (f) => f() };
  const env = {
    GOOGLE_CLIENT_IDS: `${WEB}, ${DESKTOP}`,
    ALCA_RELAY_SECRET: "x".repeat(40),
    GOOGLE_JWKS_URL: google.jwksUrl,
  } as RelayEnv;
  const obj = new RelayObject(state, env);
  /** A WebSocket constructor whose sockets land in this object (what the Workers runtime does). */
  const Ws = class {
    private c: FakeSocket;
    constructor(_url: string) {
      const [client, server] = fakePair();
      this.c = client;
      obj.accept(server, "203.0.113.7");
      setTimeout(() => client.emit("open"), 0);
    }
    get readyState() {
      return this.c.readyState;
    }
    bufferedAmount = 0;
    send(d: string) {
      this.c.send(d);
    }
    close() {
      this.c.close();
    }
    addEventListener(t: string, f: (e: { data?: unknown }) => void) {
      this.c.addEventListener(t, f as (e: { data: string }) => void);
    }
  } as unknown as new (
    url: string,
  ) => WebSocketLike;
  return { obj, storage, env, Ws };
}

describe("relay on Cloudflare Workers (fake runtime)", () => {
  it("routes /healthz and /v0/link to one object and refuses other paths", async () => {
    const { obj } = deploy();
    const env = { RELAY: { idFromName: (n: string) => n, get: () => obj } } as unknown as RelayEnv;
    const health = await worker.fetch(new Request("https://relay.example/healthz"), env);
    expect(await health.json()).toMatchObject({ ok: true, google: true, cores: 0 });
    expect((await worker.fetch(new Request("https://relay.example/v0/hooks/x"), env)).status).toBe(404);
    const plain = await obj.fetch(new Request("https://relay.example/v0/link"));
    expect(plain.status).toBe(404); // not an upgrade
  });

  it("register → list → enroll with the phone's code → session, and the registry survives a new object", async () => {
    const { obj, storage, Ws } = deploy();
    const identity = await generateIdentity(true);
    const devices = new MemoryDevices();
    const code = "305728";
    let asked = 0;
    const host = new LinkHost({
      relayUrl: "wss://relay.example/v0/link",
      identity,
      coreName: "Mac",
      devices,
      WebSocketImpl: Ws,
      selfCheckMs: 0,
      onEnroll: () => ({
        askCode: async () => {
          asked++;
          return code; // the person types what the phone shows
        },
        accept: async (d) => {
          const rec = devices.add(d, ["chat"]);
          return { deviceId: rec.id, scopes: rec.scopes };
        },
      }),
      onSession: (s) => s.peer.handle(async () => ({ hi: "from the worker" })),
    });
    await host.start();
    await host.registerComputer(google.token({ sub: SUB, aud: WEB }), "小明的 Mac");
    const [pc] = await listComputers("wss://relay.example", google.token({ sub: SUB, aud: WEB }), {
      WebSocketImpl: Ws,
    });
    expect(pc).toMatchObject({ name: "小明的 Mac", online: true, mailbox: host.mailbox });
    const phone = await generateIdentity();
    const creds = await enrollDevice({
      relayUrl: "wss://relay.example",
      computer: pc as NonNullable<typeof pc>,
      idToken: google.token({ sub: SUB, aud: WEB }),
      identity: phone,
      device: { name: "iPhone", kind: "phone", platform: "iOS · Safari" },
      code,
      WebSocketImpl: Ws,
    });
    expect(asked).toBe(1);
    const c = new LinkClient({ credentials: creds, identity: phone, WebSocketImpl: Ws, pingSec: 0 });
    c.start();
    await until(() => c.status === "online");
    expect(await c.request("x")).toEqual({ hi: "from the worker" });
    c.stop();
    await host.close();
    await obj.flush();
    const keys = [...storage.m.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^acct:/);
    // The account is stored under a hash, never by its Google subject. (Was `not.toContain("w1")` on
    // the whole JSON, which failed now and then when random key material happened to contain "w1".)
    // The subject has characters no hex / base64 / base64url output has, so a match means it leaked.
    const stored = JSON.stringify([...storage.m]);
    expect(stored).not.toContain(SUB);
    expect(strings(storage.m).filter((v) => v.includes(SUB))).toEqual([]);
    const again = deploy(storage);
    const [still] = await listComputers("wss://relay.example", google.token({ sub: SUB, aud: WEB }), {
      WebSocketImpl: again.Ws,
    });
    expect(still).toMatchObject({ name: "小明的 Mac", online: false });
  });
});

describe("the Worker build stays free of Node built-ins", () => {
  it("nothing it imports (worker, hub, registry, verifier, Link modules) loads node:*", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "../../..");
    const map: Record<string, string> = {
      "@alca/rendezvous/accounts": "services/rendezvous/src/accounts.ts",
      "@alca/rendezvous/google": "services/rendezvous/src/google.ts",
      "@alca/rendezvous/relay": "services/rendezvous/src/relay.ts",
      "@alca/link/relay-protocol": "packages/link/src/relay-protocol.ts",
      "@alca/link/bytes": "packages/link/src/bytes.ts",
      "@alca/link/identity": "packages/link/src/identity.ts",
    };
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) {
        const spec = m[2] as string;
        if (m[1]) continue; // type-only
        expect(spec.startsWith("node:"), `${file} imports ${spec}`).toBe(false);
        if (spec.startsWith(".")) walk(resolve(dirname(file), spec));
        else if (map[spec]) walk(resolve(root, map[spec] as string));
        else throw new Error(`${file}: unexpected import ${spec}`);
      }
    };
    walk(resolve(root, "services/relay-worker/src/worker.ts"));
    expect(seen.size).toBeGreaterThan(6);
  });
});
