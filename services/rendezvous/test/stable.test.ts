// P9: a stable address. The mailbox is derived from the install's key, so it
// survives core and relay restarts; the core checks its own reachability and
// re-registers; a relay move reaches paired phones without re-pairing.
import { generateIdentity, LinkHost, mailboxOf, probeRelay, relayWsUrl } from "@alca/link";
import { afterEach, describe, expect, it } from "vitest";
import { startRendezvous } from "../src/server.ts";
import { cleanup, cleanups, client, pairPhone, setup, until } from "./helpers.ts";

afterEach(cleanup);

describe("stable address + automatic reconnect (P9)", () => {
  it("the relay answers a probe for a listening mailbox, and only with one bit", async () => {
    const { relay, host } = await setup();
    const ws = relayWsUrl(relay.url);
    expect(await probeRelay(ws, host.mailbox)).toBe(true);
    expect(await probeRelay(ws, "0".repeat(22))).toBe(false);
    expect(relay.hub.stats().channels).toBe(0); // no channel was opened
    expect(await probeRelay("ws://127.0.0.1:1/v0/link", host.mailbox, { timeoutMs: 1000 })).toBeUndefined();
  });

  it("a restarted core (same key) is found again by a paired phone, no re-pairing", async () => {
    const { relay, host, devices, identity } = await setup();
    const { creds, phone } = await pairPhone(relay, host);
    const c = client(creds, phone);
    c.start();
    await until(() => c.status === "online");
    const mailbox = host.mailbox;
    await host.close();
    await until(() => c.status !== "online");
    const again = new LinkHost({
      relayUrl: relay.url,
      identity,
      coreName: "測試桌機",
      devices,
      backoff: { first: 50, max: 200 },
      onSession: (s) => s.peer.handle(async () => ({ back: true })),
    });
    cleanups.push(() => again.close());
    await again.start();
    expect(again.mailbox).toBe(mailbox);
    expect(mailbox).toBe(await mailboxOf(identity.publicRaw));
    await until(() => c.status === "online", 8000);
    expect(await c.request("anything")).toEqual({ back: true });
    expect(c.credentials.deviceId).toBe(creds.deviceId);
  });

  it("self-check: a relay that lost the core is noticed and the core re-registers", async () => {
    const { relay, host } = await setup();
    const { creds, phone } = await pairPhone(relay, host);
    // The relay forgets the core while its socket stays open (what a half-dead relay looks like).
    (relay.hub as unknown as { cores: Map<string, unknown> }).cores.delete(host.mailbox);
    expect(await probeRelay(relayWsUrl(relay.url), host.mailbox)).toBe(false);
    const h = await host.selfCheck(2000);
    expect(h).toMatchObject({ ok: false, reason: "not_listed", repairs: 1 });
    await until(() => host.status === "online");
    expect(await probeRelay(relayWsUrl(relay.url), host.mailbox)).toBe(true);
    const c = client(creds, phone);
    c.start();
    await until(() => c.status === "online");
    expect((await host.selfCheck(2000)).ok).toBe(true);
  });

  it("the periodic self-check runs on its own timer", async () => {
    const { relay, host } = await setup({ host: { selfCheckMs: 80 } });
    (relay.hub as unknown as { cores: Map<string, unknown> }).cores.delete(host.mailbox);
    await until(() => host.health.repairs >= 1, 3000);
    await until(() => host.health.ok === true, 3000);
  });

  it("moving to another relay reaches a paired phone without re-pairing", async () => {
    const { relay, host } = await setup();
    const { creds, phone } = await pairPhone(relay, host);
    const c = client(creds, phone);
    const saved: string[] = [];
    c.onCredentials((x) => saved.push(x.relayUrl));
    c.start();
    await until(() => c.status === "online");
    const next = await startRendezvous({ port: 0 });
    cleanups.push(() => next.close());
    await host.setRelayUrl(next.url);
    expect(host.relayUrl).toBe(relayWsUrl(next.url));
    await until(() => c.status === "online" && c.credentials.relayUrl === relayWsUrl(next.url), 8000);
    expect(saved).toContain(relayWsUrl(next.url));
    expect(await c.request("ping")).toBe("pong");
    // The phone's 診斷 view of its relays: the new one lists the core, the old one does not.
    const probes = await c.probeRelays(2000);
    expect(probes.find((p) => p.url === relayWsUrl(next.url))?.online).toBe(true);
    expect(probes.find((p) => p.url === relayWsUrl(relay.url))?.online).toBe(false);
  });

  it("ready tells the phone every address; a stable relay set in settings is one of them", async () => {
    const stable = await startRendezvous({ port: 0 });
    cleanups.push(() => stable.close());
    const { relay, host } = await setup({
      host: { endpoints: () => ({ relays: [stable.url], direct: ["wss://mac.tailnet.ts.net/v0/link"] }) },
    });
    const { creds, phone } = await pairPhone(relay, host);
    const c = client(creds, phone);
    c.start();
    await until(() => c.status === "online");
    expect(c.credentials.relays).toEqual([relayWsUrl(relay.url), relayWsUrl(stable.url)]);
    expect(c.credentials.direct).toEqual(["wss://mac.tailnet.ts.net/v0/link"]);
    // The direct address is tried first (it fails here), then the relay works.
    expect(c.via).toBe("relay");
    const id = await generateIdentity();
    expect(id.publicRaw.length).toBeGreaterThan(0);
  });
});
