import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, LinkClient, pairDevice } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * Connected apps + routines over Alca Link (P6): reading needs `chat`, every
 * change (connect, grant, disconnect, routine on / off / run) needs `approve`,
 * and the Composio key is never set or shown over Link.
 */

vi.setConfig({ testTimeout: 30_000 });

const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe("phone × connectors + routines scopes", () => {
  let app: DesktopApp;
  let relay: Awaited<ReturnType<typeof startRendezvous>>;
  let dir: string;
  const clients: LinkClient[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test JSON
    return (await res.json()) as any;
  };
  const phone = async (scopes: string[]) => {
    const p = await api("POST", "/api/link/pairings", { scopes });
    const identity = await generateIdentity();
    const credentials = await pairDevice({
      relayUrl: relay.url,
      code: String(p.display),
      identity,
      device: { name: "測試 iPhone", kind: "phone", platform: "headless" },
      expectFingerprint: String(p.coreFingerprint),
    });
    const client = new LinkClient({ credentials, identity, pingSec: 0, backoff: { first: 50, max: 300 } });
    client.start();
    clients.push(client);
    await until(() => client.status === "online");
    return client;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-link-conn-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ engineering: { routines: { startDelaySec: 0 } } }),
    );
    relay = await startRendezvous({ port: 0 });
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "off",
      composioMock: true,
      vaultKeySource: "file",
      rendezvous: relay.url,
    });
    await api("PUT", "/api/connectors/key", { key: app.composioMock?.key });
    const r = await api("POST", "/api/connectors/accounts", { toolkit: "gmail", label: "工作" });
    await fetch(r.redirectUrl);
    await api("POST", "/api/connectors/refresh");
  }, 30_000);
  afterAll(async () => {
    for (const c of clients) c.stop();
    await app?.close();
    await relay?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("chat reads accounts and routines; the key never crosses Link", async () => {
    const c = await phone(["chat"]);
    const st = await c.request<Record<string, unknown>>("connectors.status", {});
    expect(st.keySet).toBe(true);
    expect(st).not.toHaveProperty("keyPreview");
    expect(st).not.toHaveProperty("keyStore");
    expect(JSON.stringify(st)).not.toContain(app.composioMock?.key as string);
    expect(JSON.stringify(st)).not.toContain("0001");
    const groups = st.groups as Array<{ toolkit: string; accounts: Array<{ label: string }> }>;
    expect(groups[0]?.accounts[0]?.label).toBe("工作");
    expect(await c.request("routines.list", {})).toMatchObject({ routines: [], drafts: [] });
    for (const op of ["connectors.setKey", "connectors.key", "connectors.clearKey"])
      await expect(c.request(op, { key: "x" })).rejects.toMatchObject({ code: "unknown_op" });
  });

  it("chat cannot change anything; approve can", async () => {
    const reader = await phone(["chat"]);
    const st = await reader.request<{
      groups: Array<{ accounts: Array<{ id: string; bots: Array<{ botId: string }> }> }>;
    }>("connectors.status", {});
    const acc = st.groups[0]?.accounts[0];
    const botId = acc?.bots[0]?.botId as string;
    const routine = await api("POST", "/api/routines", {
      name: "工作信箱",
      kind: "interval",
      intervalSec: 3600,
      check: { kind: "app", app: "gmail", account: "工作" },
    });
    const changes: Array<[string, Record<string, unknown>]> = [
      ["connectors.connect", { toolkit: "gmail", label: "個人" }],
      ["connectors.grant", { accountId: acc?.id, botId, access: "read" }],
      ["connectors.disconnect", { accountId: acc?.id }],
      ["routines.enable", { routineId: routine.id, enabled: false }],
      ["routines.run", { routineId: routine.id }],
    ];
    for (const [op, args] of changes)
      await expect(reader.request(op, args)).rejects.toMatchObject({ code: "forbidden" });
    expect(app.core.store.connectors.accounts().filter((a) => a.status !== "removed")).toHaveLength(1);

    const approver = await phone(["chat", "approve"]);
    await approver.request("connectors.grant", { accountId: acc?.id, botId, access: "read" });
    const after = await approver.request<
      typeof st & { groups: Array<{ accounts: Array<{ bots: Array<{ access: string }> }> }> }
    >("connectors.status", {});
    expect(after.groups[0]?.accounts[0]?.bots[0]?.access).toBe("read");
    const off = await approver.request<{ enabled: boolean }>("routines.enable", {
      routineId: routine.id,
      enabled: false,
    });
    expect(off.enabled).toBe(false);
    const linked = await approver.request<{ redirectUrl: string }>("connectors.connect", {
      toolkit: "gmail",
      label: "個人",
    });
    expect(linked.redirectUrl).toMatch(/^http/);
  });
});
