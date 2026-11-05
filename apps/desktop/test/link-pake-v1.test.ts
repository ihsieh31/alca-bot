import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineeringParams } from "@alca/config";
import { generateIdentity, LinkError, openDeviceWire, pairDevice, parseCode, relayWsUrl } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterEach, describe, expect, it, vi } from "vitest";
// The frozen pre-G1 phone (PAKE v1 only): what a v0.2.0 page or app still runs.
import * as v1 from "../../../packages/link/test/fixtures/v1/handshake.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";
import { type PakeStatusView, pakeNote } from "../ui/link-pake-note.ts";

/**
 * PAKE v1 is removed (pake-v1-remove): a device that offers only v1 always gets
 * `upgrade_required` (update and pair again), nothing is stored, the refusal is
 * audited, and there is no setting that lets it in — an old
 * `engineering.link.pakeV1: "allow"` in config.json is dropped with a warning.
 * End to end: desktop core ⇄ real relay ⇄ the frozen v1 phone.
 */

vi.setConfig({ testTimeout: 30_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(config?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "alca-pake-v1-"));
  if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const relay = await startRendezvous({ port: 0 });
  const app: DesktopApp = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    browser: "off",
    vaultKeySource: "file",
    rendezvous: relay.url,
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => relay.close(),
    () => app.close(),
  );
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  return { app, relay, api };
}

type Rig = Awaited<ReturnType<typeof boot>>;

/** An old (v1-only) phone types a fresh code from this computer. */
async function oldPhonePairs(r: Rig) {
  const p = await r.api("POST", "/api/link/pairings", {});
  const code = parseCode(String(p.display));
  const wire = await openDeviceWire(relayWsUrl(r.relay.url), { op: "claim", nameplate: code.nameplate });
  try {
    const d = await v1.pairAsDevice(wire, {
      code,
      identity: await generateIdentity(),
      device: { name: "舊 iPhone", kind: "phone", platform: "v0.2.0" },
    });
    return { ok: true as const, deviceId: d.deviceId };
  } catch (e) {
    return {
      ok: false as const,
      code: e instanceof LinkError ? e.code : String(e),
      message: (e as Error).message,
    };
  }
}

interface AuditRow {
  action: string;
  decision: string;
  detail: string;
}
const linkAudit = (r: Rig) =>
  r.app.core.store.db
    .prepare(
      "SELECT action, decision, detail FROM audit_log WHERE action IN ('link.pair', 'link.enroll') ORDER BY id",
    )
    .all() as unknown as AuditRow[];

const until = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((res) => setTimeout(res, 20));
  }
};

describe("PAKE v1 removed", () => {
  it("a v1-only phone gets upgrade_required with 'update and pair again', nothing stored; the dialog says so", async () => {
    expect("link" in EngineeringParams.parse({})).toBe(false);
    const r = await boot();
    const before = r.app.core.store.devices.list().length;
    const res = await oldPhonePairs(r);
    expect(res).toMatchObject({ ok: false, code: "upgrade_required" });
    expect(res.ok ? "" : res.message).toMatch(/update .*pair again/);
    expect(r.app.core.store.devices.list().length).toBe(before);
    const st = await r.api("GET", "/api/link");
    const pake = st.pake as PakeStatusView;
    expect(Object.keys(pake)).toEqual(["recent"]); // no v1 policy to report any more
    expect(pake.recent[0]).toMatchObject({ version: 0, ok: false, error: "upgrade_required" });
    // The computer says it plainly too (an old page shows only the bare code).
    expect(pakeNote(pake)).toMatch(/已拒絕.*更新.*重新配對/);
    // A current phone still pairs (v2).
    const p = await r.api("POST", "/api/link/pairings", {});
    const creds = await pairDevice({
      relayUrl: r.relay.url,
      code: String(p.display),
      identity: await generateIdentity(),
      device: { name: "新 iPhone", kind: "phone", platform: "t" },
    });
    expect(creds.pake).toBe(2);
    expect(pakeNote((await r.api("GET", "/api/link")).pake as PakeStatusView)).toBeUndefined();
  });

  it("the refusal writes one audit entry (decision deny, refused pake_v1)", async () => {
    const r = await boot();
    await oldPhonePairs(r);
    await until(() => linkAudit(r).length > 0);
    const rows = linkAudit(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "link.pair", decision: "deny" });
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({
      pake: 0,
      error: "upgrade_required",
      refused: "pake_v1",
    });
  });

  it('a leftover engineering.link.pakeV1 = "allow" is ignored: the core starts and still refuses v1', async () => {
    const r = await boot({ engineering: { link: { pakeV1: "allow" } } });
    const before = r.app.core.store.devices.list().length;
    const res = await oldPhonePairs(r);
    expect(res).toMatchObject({ ok: false, code: "upgrade_required" });
    expect(r.app.core.store.devices.list().length).toBe(before);
    await until(() => linkAudit(r).length > 0);
    expect(linkAudit(r)[0]).toMatchObject({ action: "link.pair", decision: "deny" });
  });
});
