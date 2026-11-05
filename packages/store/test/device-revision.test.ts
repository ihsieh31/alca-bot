import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeviceRepo, openStore } from "../src/index.ts";

describe("DeviceRepo.revision (PERF-2026-11)", () => {
  it("changes on every write that can change what a device may do, not on seen()", () => {
    const s = openStore(":memory:");
    const d = s.devices;
    const r0 = d.revision;
    const dev = d.add({
      name: "手機",
      kind: "phone",
      platform: "ios",
      pubkey: "pk",
      keyFingerprint: "fp",
      scopes: ["chat"],
    });
    const r1 = d.revision;
    expect(r1).toBeGreaterThan(r0);
    d.seen(dev.id);
    expect(d.revision).toBe(r1);
    d.setScopes(dev.id, ["approve"]);
    const r2 = d.revision;
    expect(r2).toBeGreaterThan(r1);
    d.rename(dev.id, "新手機");
    const r3 = d.revision;
    expect(r3).toBeGreaterThan(r2);
    d.revoke(dev.id);
    expect(d.revision).toBeGreaterThan(r3);
    s.close();
  });
});

describe("DeviceRepo.revision sees writes from other connections (review 2026-11-05 #10)", () => {
  it("a revoke through a second connection to the file changes the revision (within the check interval)", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-devrev-"));
    try {
      const path = join(dir, "state.sqlite");
      const a = openStore(path);
      const b = openStore(path);
      let t = 1_000_000;
      const repo = new DeviceRepo(a.db, { now: () => t });
      const dev = a.devices.add({
        name: "手機",
        kind: "phone",
        platform: "ios",
        pubkey: "pk",
        keyFingerprint: "fp2",
        scopes: ["chat"],
      });
      const r0 = repo.revision;
      expect(repo.revision).toBe(r0); // nothing changed
      expect(b.devices.revoke(dev.id)).toBe(true); // another connection (the db worker, the CLI, a second Store)
      expect(repo.revision).toBe(r0); // still inside the check interval
      t += DeviceRepo.EXTERNAL_CHECK_MS;
      expect(repo.revision).not.toBe(r0);
      expect(repo.get(dev.id)?.revokedAt).not.toBeNull();
      // Its own writes count at once.
      const r1 = repo.revision;
      repo.bump();
      expect(repo.revision).toBeGreaterThan(r1);
      b.close();
      a.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
