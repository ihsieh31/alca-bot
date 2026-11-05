import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  anchorPath,
  appendAudit,
  auditTail,
  backupNow,
  listBackups,
  MIGRATIONS,
  openStore,
  readAnchor,
  restoreBackup,
  type Store,
  Upkeep,
  verifyAudit,
  verifyAuditAsync,
  verifyAuditChain,
} from "../src/index.ts";

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-audit-"));
  dirs.push(d);
  return join(d, "state.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fill(s: Store, n: number, from = 0) {
  for (let i = from; i < from + n; i++)
    appendAudit(s.db, {
      ts: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
      initiator: { kind: "user", id: "u_fake" },
      actor: { kind: "bot", id: "b_fake" },
      action: i % 2 ? "browser_click" : "shell",
      actionClass: "write",
      decision: "allow",
      detail: { i },
    });
}

/** Out-of-band edits: what someone changing the file outside Alca could do. */
function unlock(s: Store) {
  s.db.exec("DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;");
}

describe("verifyAudit", () => {
  it("a whole chain holds; the old wrapper agrees", () => {
    const s = openStore(":memory:");
    fill(s, 50);
    const r = verifyAudit(s.db, { integrity: true });
    expect(r).toMatchObject({
      ok: true,
      count: 50,
      checkedFrom: 1,
      integrity: "ok",
      anchor: { state: "absent" },
    });
    expect(r.last?.id).toBe(50);
    expect(verifyAuditChain(s.db)).toEqual({ ok: true, count: 50 });
    s.close();
  });

  it("names the row and the reason: an edited detail, a deleted middle row, bad JSON", () => {
    const s = openStore(":memory:");
    fill(s, 20);
    unlock(s);
    s.db.prepare("UPDATE audit_log SET detail = '{\"i\":999}' WHERE id = 8").run();
    expect(verifyAudit(s.db).brokenAt).toMatchObject({ id: 8, reason: "hash", action: "browser_click" });
    expect(verifyAuditChain(s.db)).toMatchObject({ ok: false, brokenAt: 8 });

    const t = openStore(":memory:");
    fill(t, 20);
    unlock(t);
    t.db.prepare("DELETE FROM audit_log WHERE id = 11").run();
    expect(verifyAudit(t.db).brokenAt).toMatchObject({ id: 12, reason: "prev_hash" });

    const u = openStore(":memory:");
    fill(u, 5);
    unlock(u);
    u.db.exec("PRAGMA ignore_check_constraints = ON");
    u.db.prepare("UPDATE audit_log SET detail = '{broken' WHERE id = 3").run();
    const r = verifyAudit(u.db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toMatchObject({ id: 3, reason: "detail_json" });
    for (const x of [s, t, u]) x.close();
  });

  it("the anchor catches a cut-off tail the chain cannot see", () => {
    const s = openStore(":memory:");
    fill(s, 30);
    const tail = auditTail(s.db);
    const anchor = {
      lastId: tail?.id ?? 0,
      lastHash: tail?.hash ?? "",
      count: 30,
      at: "2026-11-05T01:00:00Z",
    };
    expect(verifyAudit(s.db, { anchor }).anchor?.state).toBe("match");
    unlock(s);
    s.db.prepare("DELETE FROM audit_log WHERE id > 27").run();
    expect(verifyAudit(s.db).ok).toBe(true); // the chain alone still looks whole
    const r = verifyAudit(s.db, { anchor });
    expect(r.ok).toBe(false);
    expect(r.anchor?.state).toBe("behind");
    s.close();
  });

  it("an older copy that grew past the anchor again is caught by the anchor row's hash", () => {
    const s = openStore(":memory:");
    fill(s, 10);
    const t = auditTail(s.db);
    const anchor = { lastId: t?.id ?? 0, lastHash: t?.hash ?? "", count: 10, at: "x" };
    const older = openStore(":memory:");
    fill(older, 8);
    fill(older, 4, 100); // different rows 9..12
    const r = verifyAudit(older.db, { anchor });
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toMatchObject({ id: 10, reason: "hash" });
    s.close();
    older.close();
  });

  it("incremental from a verified row gives the same verdict as a full pass", () => {
    const s = openStore(":memory:");
    fill(s, 40);
    const mid = s.db.prepare("SELECT id, hash FROM audit_log WHERE id = 25").get() as {
      id: number;
      hash: string;
    };
    const inc = verifyAudit(s.db, { from: mid });
    expect(inc).toMatchObject({ ok: true, count: 15, checkedFrom: 26 });
    expect(inc.last).toEqual(verifyAudit(s.db).last);
    unlock(s);
    s.db.prepare("UPDATE audit_log SET action = 'x' WHERE id = 33").run();
    expect(verifyAudit(s.db, { from: mid }).brokenAt).toEqual(verifyAudit(s.db).brokenAt);
    // the row it continues from was itself changed
    s.db.prepare("UPDATE audit_log SET hash = 'f00' WHERE id = 25").run();
    expect(verifyAudit(s.db, { from: mid }).brokenAt).toMatchObject({ id: 25, reason: "hash" });
    s.close();
  });

  it("streams: memory does not grow with the rows; the async drain yields progress", async () => {
    const s = openStore(":memory:");
    s.db.exec("BEGIN");
    fill(s, 100_000);
    s.db.exec("COMMIT");
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const seen: number[] = [];
    const r = await verifyAuditAsync(s.db, {}, (n) => seen.push(n));
    const grew = process.memoryUsage().heapUsed - before;
    expect(r).toMatchObject({ ok: true, count: 100_000 });
    expect(seen.at(-1)).toBe(100_000);
    expect(seen.length).toBe(20);
    expect(grew).toBeLessThan(64 * 1024 * 1024);
    s.close();
  }, 60_000);
});

describe("Upkeep (the hourly data steps)", () => {
  it("checks only new rows, moves the anchor, and resumes from the anchor after a restart", () => {
    const path = tmpDb();
    const s = openStore(path);
    fill(s, 12);
    const up = new Upkeep({ db: s.db, dbPath: path });
    const first = up.hourly(new Date());
    expect(first.audit).toMatchObject({ ok: true, count: 12 });
    expect(readAnchor(anchorPath(path))).toMatchObject({ lastId: 12, count: 12 });
    expect(statSync(anchorPath(path)).mode & 0o777).toBe(0o600);
    fill(s, 3, 50);
    expect(up.hourly(new Date()).audit).toMatchObject({ ok: true, count: 3, checkedFrom: 13 });
    fill(s, 2, 80);
    const again = new Upkeep({ db: s.db, dbPath: path }); // a restart: nothing in memory
    expect(again.checkAudit(new Date())).toMatchObject({ ok: true, count: 2, checkedFrom: 16 });
    expect(readAnchor(anchorPath(path))).toMatchObject({ lastId: 17, count: 17 });
    s.close();
  });

  it("a broken chain alerts once and leaves the anchor where it was", () => {
    const path = tmpDb();
    const s = openStore(path);
    fill(s, 5);
    const alerts: unknown[] = [];
    const up = new Upkeep({ db: s.db, dbPath: path, onAuditBroken: (r) => alerts.push(r) });
    up.hourly(new Date());
    fill(s, 3, 10);
    unlock(s);
    s.db.prepare("UPDATE audit_log SET target = 'evil' WHERE id = 7").run();
    expect(up.hourly(new Date()).audit?.brokenAt).toMatchObject({ id: 7, reason: "hash" });
    up.hourly(new Date());
    expect(alerts).toHaveLength(1);
    expect(readAnchor(anchorPath(path))?.lastId).toBe(5);
    s.close();
  });

  it("takes a daily backup once a day, keeps the daily ones apart from the manual ones", () => {
    const path = tmpDb();
    const s = openStore(path);
    for (let i = 0; i < 5; i++) backupNow(s.db, path, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    const up = new Upkeep({
      db: s.db,
      dbPath: path,
      policy: () => ({ runEventsDays: 90, jobEventsDays: 90, externalDays: 90, dailyBackups: 7 }),
    });
    const t0 = Date.UTC(2026, 10, 1, 3, 0, 0);
    expect(up.hourly(new Date(t0)).backup).toHaveProperty("file");
    expect(up.hourly(new Date(t0 + 3600_000)).backup).toEqual({ skipped: "fresh" });
    for (let d = 1; d <= 9; d++) up.hourly(new Date(t0 + d * 86_400_000));
    const list = listBackups(path);
    expect(list.filter((b) => b.kind === "daily")).toHaveLength(7);
    expect(list.filter((b) => b.kind === "manual")).toHaveLength(5);
    const off = new Upkeep({
      db: s.db,
      dbPath: path,
      policy: () => ({ runEventsDays: 90, jobEventsDays: 90, externalDays: 90, dailyBackups: 0 }),
    });
    expect(off.hourly(new Date(t0 + 30 * 86_400_000)).backup).toEqual({ skipped: "off" });
    s.close();
  });

  it("one failing step does not stop the others", () => {
    const path = tmpDb();
    const s = openStore(path);
    fill(s, 2);
    writeFileSync(join(path, "..", "backups"), "not a folder"); // the backup step cannot make its folder
    const r = new Upkeep({ db: s.db, dbPath: path }).hourly(new Date());
    expect(r.errors.backup).toBeTruthy();
    expect(r.maintain).toBeDefined();
    expect(r.audit?.ok).toBe(true);
    expect(r.pruned).toEqual({});
    s.close();
  });

  it("restoring a backup moves the anchor back to the backup's last row", () => {
    const path = tmpDb();
    const s = openStore(path);
    fill(s, 4);
    const file = backupNow(s.db, path);
    fill(s, 6, 20);
    new Upkeep({ db: s.db, dbPath: path }).hourly(new Date());
    expect(readAnchor(anchorPath(path))?.lastId).toBe(10);
    s.close();
    const r = restoreBackup(path, file, MIGRATIONS);
    expect(r.audit?.lastId).toBe(4);
    expect(readAnchor(anchorPath(path))).toMatchObject({ lastId: 4, count: 4, note: "restored" });
    const back = openStore(path);
    expect(new Upkeep({ db: back.db, dbPath: path }).checkAudit(new Date()).ok).toBe(true);
    back.close();
    expect(existsSync(anchorPath(path))).toBe(true);
  });
});
