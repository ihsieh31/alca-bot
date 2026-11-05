// Review L3 / L4 / M2 on the Workers relay: /healthz names a missing
// ALCA_RELAY_SECRET or an empty ALLOWED_ORIGINS, production mode refuses
// browser sockets until the phone site's origin is set, the account ops say
// why Google sign-in is off, and MAX_SOCKETS caps the one relay object.
import { RELAY_VERSION } from "@alca/link/relay-protocol";
import type { WsConnection } from "@alca/link/ws";
import { describe, expect, it } from "vitest";
import type { DurableState, DurableStorage, RelayEnv } from "../src/cf-types.ts";
import { configProblems, DEFAULT_MAX_SOCKETS, RelayObject } from "../src/worker.ts";

const storage: DurableStorage = {
  get: async () => undefined,
  list: async <T>() => new Map<string, T>(),
  put: async () => undefined,
  delete: async () => 0,
};
const state: DurableState = { storage, blockConcurrencyWhile: (f) => f() };
const ID = "test-web.apps.googleusercontent.com";
const health = async (env: Partial<RelayEnv>) =>
  (await (
    await new RelayObject(state, env as RelayEnv).fetch(new Request("https://relay.example/healthz"))
  ).json()) as {
    ok: boolean;
    google: boolean;
    hooks: boolean;
    mode: string;
    warnings?: string[];
  };

describe("Workers relay configuration checks", () => {
  it("a complete production config is ok with no warnings", async () => {
    const env = {
      GOOGLE_CLIENT_IDS: ID,
      ALCA_RELAY_SECRET: "s".repeat(40),
      ALLOWED_ORIGINS: "https://alca.example.com",
      RELAY_MODE: "production",
    };
    expect(configProblems(env as RelayEnv)).toEqual([]);
    expect(await health(env)).toMatchObject({ ok: true, google: true, mode: "production" });
    expect((await health(env)).warnings).toBeUndefined();
  });

  it("L4: client IDs without ALCA_RELAY_SECRET → ok:false and a warning that names the secret", async () => {
    const h = await health({ GOOGLE_CLIENT_IDS: ID, ALLOWED_ORIGINS: "https://alca.example.com" });
    expect(h.ok).toBe(false);
    expect(h.google).toBe(false);
    expect(h.warnings?.join(" ")).toContain("ALCA_RELAY_SECRET");
    expect(
      (await health({ ALCA_RELAY_SECRET: "short", ALLOWED_ORIGINS: "https://a.example" })).warnings,
    ).toEqual(["ALCA_RELAY_SECRET is shorter than 32 characters"]);
  });

  it("L4: the account ops say why Google sign-in is off", () => {
    const obj = new RelayObject(state, { GOOGLE_CLIENT_IDS: ID } as RelayEnv);
    const sent: Array<Record<string, unknown>> = [];
    const ws: WsConnection = {
      send: (t) => void sent.push(JSON.parse(t)),
      close: () => undefined,
      onMessage: (h) =>
        queueMicrotask(() => h(JSON.stringify({ v: RELAY_VERSION, op: "computers.list", idToken: "x" }))),
      onClose: () => undefined,
      bufferedAmount: 0,
      remoteAddress: "203.0.113.1",
      open: true,
    };
    (obj as unknown as { hub: { accept(w: WsConnection, k: string): void } }).hub.accept(ws, "203.0.113.1");
    return new Promise<void>((done) =>
      setTimeout(() => {
        expect(sent[0]).toMatchObject({ op: "error", code: "not_enabled" });
        expect(String(sent[0]?.message)).toContain("ALCA_RELAY_SECRET");
        done();
      }, 20),
    );
  });

  it("L3: empty ALLOWED_ORIGINS warns loudly; in production mode it is fatal and browsers are refused", async () => {
    const dev = await health({});
    expect(dev.ok).toBe(true);
    expect(dev.warnings?.[0]).toContain("any website can open relay sockets");
    const prod = await health({ RELAY_MODE: "production" });
    expect(prod.ok).toBe(false);
    expect(prod.warnings?.[0]).toContain("production mode");
    const obj = new RelayObject(state, { RELAY_MODE: "production" } as RelayEnv);
    const r = await obj.fetch(
      new Request("https://relay.example/v0/link", {
        headers: { upgrade: "websocket", origin: "https://evil.example" },
      }),
    );
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("ALLOWED_ORIGINS");
  });

  it("M2: MAX_SOCKETS caps the relay object (default 5000); /healthz says whether hooks are bound", async () => {
    const limits = (env: Partial<RelayEnv>) =>
      (new RelayObject(state, env as RelayEnv) as unknown as { hub: { limits: { maxSockets: number } } }).hub
        .limits.maxSockets;
    expect(limits({})).toBe(DEFAULT_MAX_SOCKETS);
    expect(limits({ MAX_SOCKETS: "12" })).toBe(12);
    expect(limits({ MAX_SOCKETS: "lots" })).toBe(DEFAULT_MAX_SOCKETS);
    expect((await health({})).hooks).toBe(false);
    expect(
      (await health({ HOOKS: { idFromName: () => "", get: () => ({ fetch: async () => new Response() }) } }))
        .hooks,
    ).toBe(true);
  });
});
