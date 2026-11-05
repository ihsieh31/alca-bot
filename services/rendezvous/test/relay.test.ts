import {
  type DeviceRecord,
  generateIdentity,
  type LinkError,
  pairDevice,
  startLanListener,
  toB64u,
} from "@alca/link";
import { afterEach, describe, expect, it } from "vitest";
import { startRendezvous } from "../src/server.ts";
import { cleanup, cleanups, client, pairPhone, SECRET_TEXT, setup, until } from "./helpers.ts";

afterEach(cleanup);

/** The same code with its first secret digit changed (never equal to the real one). */
const wrongCode = (code: string, nameplate: string) => {
  const d = Number(code[nameplate.length]);
  return `${nameplate}${(d + 1) % 10}${code.slice(nameplate.length + 1)}`;
};

describe("rendezvous + Link", () => {
  it("pairs with the code, then talks over sealed frames only", async () => {
    const { relay, host, devices, seen } = await setup();
    expect(host.status).toBe("online");
    const { creds, phone } = await pairPhone(relay, host);
    expect(creds.deviceId).toBe("dev_1");
    expect(devices.get("dev_1")?.scopes).toEqual(["chat", "approve"]);
    const c = client(creds, phone);
    const events: unknown[] = [];
    c.onEvent((_ch, e) => events.push(e));
    c.start();
    await until(() => c.status === "online");
    expect(c.ready?.coreName).toBe("測試桌機");
    expect(await c.request("echo", { text: SECRET_TEXT })).toEqual({ echoed: SECRET_TEXT });
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ text: `${SECRET_TEXT}（串流）` });

    // What the relay forwarded: handshake public values and sealed frames, never the text.
    const dump = JSON.stringify(seen);
    expect(dump).not.toContain(SECRET_TEXT);
    expect(dump).not.toContain("echo");
    expect(dump).not.toContain("iPhone"); // the device name travels inside the PAKE channel
    const kinds = new Set(seen.map((m) => (m as { t: string }).t));
    expect([...kinds].sort()).toEqual(["auth", "f", "hello", "pair1", "pair2", "pair3", "welcome"]);
    for (const m of seen as Array<{ t: string; d?: string }>)
      if (m.t === "f") expect(m.d).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("G1: one wrong code burns the code at once — even the right code finds nothing afterwards", async () => {
    const { relay, host } = await setup({ limits: { claimBurst: 10 } });
    const outcomes: Array<{ ok: boolean; error?: string; attemptsLeft?: number; pake?: number }> = [];
    host.onPairing((o) => outcomes.push(o));
    const p = await host.createPairing({ scopes: ["chat"] });
    const wrong = wrongCode(p.code, p.nameplate);
    const phone = await generateIdentity();
    const dev = { name: "x", kind: "phone" as const, platform: "t" };
    await expect(
      pairDevice({ relayUrl: relay.url, code: wrong, identity: phone, device: dev }),
    ).rejects.toMatchObject({ code: "wrong_code" });
    await until(() => outcomes.length === 1);
    expect(outcomes[0]).toMatchObject({ ok: false, error: "wrong_code", attemptsLeft: 0, pake: 2 });
    // Burned on the core and on the relay: the right code is no use now.
    await until(() => relay.hub.stats().nameplates === 0);
    await expect(
      pairDevice({ relayUrl: relay.url, code: p.code, identity: phone, device: dev }),
    ).rejects.toMatchObject({ code: "no_such_code" });
    // A new code pairs (v2), and success spends it too.
    const q = await host.createPairing({ scopes: ["chat"] });
    const creds = await pairDevice({ relayUrl: relay.url, code: q.code, identity: phone, device: dev });
    expect(creds).toMatchObject({ deviceId: "dev_1", pake: 2 });
    await until(() => relay.hub.stats().nameplates === 0);
    const other = await generateIdentity();
    await expect(
      pairDevice({ relayUrl: relay.url, code: q.code, identity: other, device: dev }),
    ).rejects.toMatchObject({ code: "no_such_code" });
  });

  it("rate-limits pairing claims per client", async () => {
    const { relay } = await setup({ limits: { claimBurst: 3, claimsPerMinute: 1 } });
    const phone = await generateIdentity();
    const dev = { name: "x", kind: "phone" as const, platform: "t" };
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        await pairDevice({ relayUrl: relay.url, code: `90${i}123456`, identity: phone, device: dev });
      } catch (e) {
        codes.push((e as LinkError).code);
      }
    }
    expect(codes).toEqual(["no_such_code", "no_such_code", "no_such_code", "rate_limited", "rate_limited"]);
  });

  it("a revoked device is cut off and cannot reconnect", async () => {
    const { relay, host, devices } = await setup();
    const { creds, phone } = await pairPhone(relay, host);
    const c = client(creds, phone);
    c.start();
    await until(() => c.status === "online");
    (devices.get(creds.deviceId) as DeviceRecord).revoked = true;
    host.disconnect(creds.deviceId);
    await until(() => c.status === "revoked");
    // A fresh client with the same key is refused at the handshake.
    const again = client(creds, phone);
    again.start();
    await until(() => again.status === "revoked");
  });

  it("only the key holder can listen on a mailbox", async () => {
    const { relay, host } = await setup();
    const ws = new WebSocket(`${relay.url.replace("http", "ws")}/v0/link`);
    const msgs: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (e) => msgs.push(JSON.parse(String(e.data))));
    await new Promise((r) => ws.addEventListener("open", r));
    // Claim the real core's public key without its private key.
    const other = await generateIdentity();
    ws.send(
      JSON.stringify({ op: "core.hello", v: 0, pub: host.coreFingerprint ? toB64u(other.publicRaw) : "" }),
    );
    await until(() => msgs.length === 1);
    ws.send(JSON.stringify({ op: "core.auth", sig: toB64u(new Uint8Array(64)) }));
    await until(() => msgs.length === 2);
    expect(msgs[1]).toMatchObject({ op: "error", code: "auth_failed" });
    ws.close();
    expect(relay.hub.stats().cores).toBe(1);
  });

  it("host and device reconnect after the relay restarts", async () => {
    const first = await setup();
    const { creds, phone } = await pairPhone(first.relay, first.host);
    const c = client(creds, phone);
    c.start();
    await until(() => c.status === "online");
    const port = first.relay.port;
    await first.relay.close();
    await until(() => c.status !== "online");
    const again = await startRendezvous({ port });
    cleanups.push(() => again.close());
    await until(() => first.host.status === "online" && c.status === "online", 8000);
    expect(await c.request("echo", { text: "回來了" })).toEqual({ echoed: "回來了" });
  });

  it("uses the LAN listener first when the core reports one", async () => {
    const { relay, host } = await setup();
    const lan = await startLanListener(host, { host: "127.0.0.1", addresses: ["127.0.0.1"] });
    cleanups.push(() => lan.close());
    const { creds, phone } = await pairPhone(relay, host);
    const c = client({ ...creds, lan: lan.urls }, phone, true);
    c.start();
    await until(() => c.status === "online");
    expect(c.via).toBe("lan");
    expect(await c.request("echo", { text: "區網" })).toEqual({ echoed: "區網" });
    // Stop the LAN listener: the next connection falls back to the relay.
    await lan.close();
    await until(() => c.status !== "online");
    await until(() => c.status === "online");
    expect(c.via).toBe("relay");
  });
});
