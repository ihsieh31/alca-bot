import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAudit,
  currentVersion,
  journalMode,
  MIGRATIONS,
  MigrationError,
  migrate,
  openDatabase,
  openStore,
  verifyAuditChain,
} from "../src/index.ts";

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-store-"));
  dirs.push(d);
  return join(d, "state.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = "2026-11-03T00:00:00.000Z";

function seed(db: ReturnType<typeof openDatabase>) {
  db.prepare("INSERT INTO threads (id, created_at, updated_at) VALUES ('t1', ?, ?)").run(NOW, NOW);
  db.prepare(
    "INSERT INTO runs (id, thread_id, initiator_kind, initiator_id, started_at) VALUES ('r1','t1','user','u',?)",
  ).run(NOW);
  db.prepare(
    "INSERT INTO jobs (id, kind, thread_id, created_at, updated_at) VALUES ('j1','turn','t1',?,?)",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO job_events (job_id, seq, type, payload, created_at) VALUES ('j1', 0, 'created', '{}', ?)",
  ).run(NOW);
}

describe("migrations", () => {
  it("uses WAL on file databases", () => {
    const s = openStore(tmpDb());
    expect(journalMode(s.db)).toBe("wal");
    s.close();
  });

  it("are idempotent across reopen", () => {
    const path = tmpDb();
    const a = openStore(path);
    expect(a.migration.applied).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
      29, 30, 31, 32,
    ]);
    a.close();
    const b = openStore(path);
    expect(b.migration.applied).toEqual([]);
    expect(currentVersion(b.db)).toBe(32);
    expect(migrate(b.db, MIGRATIONS).applied).toEqual([]);
    b.close();
  });

  it("creates every planned table", () => {
    const s = openStore(":memory:");
    const names = (
      s.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of [
      "threads",
      "messages",
      "runs",
      "run_events",
      "jobs",
      "job_events",
      "audit_log",
      "approvals",
      "devices",
      "memories",
      "memories_fts",
      "memory_tombstones",
      "skills",
      "skill_versions",
      "git_snapshots",
      "retention_gate",
    ]) {
      expect(names).toContain(t);
    }
    s.close();
  });

  it("refuses an edited, already-applied migration", () => {
    const s = openStore(":memory:");
    const edited = [{ ...MIGRATIONS[0]!, sql: `${MIGRATIONS[0]!.sql}\n-- edit` }];
    expect(() => migrate(s.db, edited)).toThrow(MigrationError);
    s.close();
  });

  it("refuses unordered versions and rolls back a failing migration", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(() =>
      migrate(db, [
        { version: 2, name: "b", sql: "" },
        { version: 1, name: "a", sql: "" },
      ]),
    ).toThrow(MigrationError);
    expect(() =>
      migrate(db, [{ version: 1, name: "bad", sql: "CREATE TABLE ok (x); CREATE TABLE broken (" }]),
    ).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
    expect(currentVersion(db)).toBe(0);
    db.close();
  });
});

describe("append-only tables", () => {
  it("job_events rejects UPDATE and DELETE", () => {
    const s = openStore(":memory:");
    seed(s.db);
    expect(() => s.db.exec("UPDATE job_events SET type = 'x'")).toThrow(/append-only/);
    expect(() => s.db.exec("DELETE FROM job_events")).toThrow(/append-only/);
    expect(() =>
      s.db
        .prepare("INSERT INTO job_events (job_id, seq, type, created_at) VALUES ('j1', 0, 'dup', ?)")
        .run(NOW),
    ).toThrow(/UNIQUE/);
    s.close();
  });

  it("audit_log rejects UPDATE and DELETE and keeps a valid hash chain", () => {
    const s = openStore(":memory:");
    const base = {
      initiator: { kind: "user" as const, id: "u" },
      actor: { kind: "agent", id: "main" },
      actionClass: "send",
    };
    appendAudit(s.db, { ...base, action: "mail.send", decision: "ask", detail: { to: "a" } });
    appendAudit(s.db, { ...base, action: "mail.send", decision: "allow" });
    expect(verifyAuditChain(s.db)).toEqual({ ok: true, count: 2 });
    expect(() => s.db.exec("UPDATE audit_log SET decision = 'allow'")).toThrow(/append-only/);
    expect(() => s.db.exec("DELETE FROM audit_log")).toThrow(/append-only/);
    // Tamper by bypassing the trigger: chain verification catches it.
    s.db.exec("DROP TRIGGER audit_log_no_update");
    s.db.exec("UPDATE audit_log SET target = 'evil' WHERE id = 1");
    expect(verifyAuditChain(s.db)).toMatchObject({ ok: false, brokenAt: 1 });
    s.close();
  });

  it("run_events rejects UPDATE and DELETE", () => {
    const s = openStore(":memory:");
    seed(s.db);
    s.db
      .prepare(
        "INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES ('r1', 0, 'run.started', '{}', ?)",
      )
      .run(NOW);
    expect(() => s.db.exec("UPDATE run_events SET seq = 9")).toThrow(/append-only/);
    expect(() => s.db.exec("DELETE FROM run_events")).toThrow(/append-only/);
    s.close();
  });
});

describe("domain invariants", () => {
  it("jobs form a tree and outbound_observed is sticky", () => {
    const s = openStore(":memory:");
    seed(s.db);
    s.db
      .prepare("INSERT INTO jobs (id, parent_id, kind, created_at, updated_at) VALUES ('j2','j1','tool',?,?)")
      .run(NOW, NOW);
    expect(() =>
      s.db
        .prepare(
          "INSERT INTO jobs (id, parent_id, kind, created_at, updated_at) VALUES ('j3','nope','tool',?,?)",
        )
        .run(NOW, NOW),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      s.db.exec(
        "INSERT INTO jobs (id, kind, status, created_at, updated_at) VALUES ('j4','turn','weird','x','x')",
      ),
    ).toThrow(/CHECK/);
    s.db.exec("UPDATE jobs SET outbound_observed = 1 WHERE id = 'j2'");
    expect(() => s.db.exec("UPDATE jobs SET outbound_observed = 0 WHERE id = 'j2'")).toThrow(
      /cannot be cleared/,
    );
    s.close();
  });

  it("approvals are final once resolved; device revocation is permanent", () => {
    const s = openStore(":memory:");
    s.db
      .prepare(
        "INSERT INTO approvals (id, action_class, summary, requested_at) VALUES ('a1','payment','pay',?)",
      )
      .run(NOW);
    s.db.prepare("UPDATE approvals SET status='approved', resolved_at=? WHERE id='a1'").run(NOW);
    expect(() => s.db.exec("UPDATE approvals SET status='denied' WHERE id='a1'")).toThrow(/already resolved/);
    s.db
      .prepare(
        "INSERT INTO devices (id, name, pubkey, key_fingerprint, scopes, created_at) VALUES ('d1','iPhone','pk','th','[\"chat\",\"approve\"]',?)",
      )
      .run(NOW);
    s.db.prepare("UPDATE devices SET revoked_at=? WHERE id='d1'").run(NOW);
    expect(() => s.db.exec("UPDATE devices SET revoked_at=NULL WHERE id='d1'")).toThrow(/permanent/);
    expect(() =>
      s.db
        .prepare(
          "INSERT INTO devices (id, name, pubkey, key_fingerprint, scopes, created_at) VALUES ('d2','x','pk2','th2','chat',?)",
        )
        .run(NOW),
    ).toThrow(/CHECK/);
    s.close();
  });
});

describe("devices (migration 5)", () => {
  it("adds, lists, revokes for good, never deletes or swaps keys", () => {
    const s = openStore(tmpDb());
    const d = s.devices.add({
      name: "iPhone",
      kind: "phone",
      platform: "iOS",
      pubkey: "pk",
      keyFingerprint: "fp",
      scopes: ["chat", "approve"],
    });
    expect(d.id).toMatch(/^dev_/);
    expect(s.devices.byFingerprint("fp")?.id).toBe(d.id);
    s.devices.seen(d.id);
    expect(s.devices.get(d.id)?.lastSeenAt).not.toBeNull();
    expect(() => s.db.prepare("UPDATE devices SET pubkey='other' WHERE id=?").run(d.id)).toThrow(
      /never changes/,
    );
    expect(() => s.db.prepare("DELETE FROM devices WHERE id=?").run(d.id)).toThrow(/revoked, not deleted/);
    expect(s.devices.revoke(d.id)).toBe(true);
    expect(s.devices.revoke(d.id)).toBe(false);
    expect(s.devices.list()).toEqual([]);
    expect(s.devices.list({ includeRevoked: true })[0]?.revokedAt).not.toBeNull();
    s.close();
  });
});

describe("P11 providers schema", () => {
  it("custom ACP rows with their config; settings for built-in providers", () => {
    const s = openStore(join(mkdtempSync(join(tmpdir(), "p11-")), "a.db"));
    const acp = s.team.addProvider({
      kind: "acp",
      label: "我的代理",
      baseUrl: "",
      model: "",
      hasKey: false,
      config: { command: ["my-agent", "--acp"], keyEnv: "MY_KEY" },
    });
    expect(s.team.provider(acp.id)?.config).toEqual({ command: ["my-agent", "--acp"], keyEnv: "MY_KEY" });
    s.team.setProviderHasKey(acp.id, true);
    expect(s.team.provider(acp.id)?.hasKey).toBe(true);
    expect(s.team.providerSettings("openai")).toEqual({ settings: {}, hasKey: false });
    s.team.setProviderSettings("openai", { settings: { family: "openai-chat" } });
    s.team.setProviderSettings("openai", { hasKey: true });
    expect(s.team.providerSettings("openai")).toEqual({ settings: { family: "openai-chat" }, hasKey: true });
    s.close();
  });

  it("keeps a P7 model service across the table rebuild", () => {
    const db = openDatabase({ path: ":memory:" });
    migrate(db, MIGRATIONS.slice(0, 10));
    db.prepare(
      "INSERT INTO engine_providers (id, kind, label, base_url, model, has_key, created_at) VALUES ('eng_1','openai','本機','http://127.0.0.1:1/v1','m',1,'2026-11-01T00:00:00Z')",
    ).run();
    migrate(db, MIGRATIONS);
    const r = db
      .prepare("SELECT kind, label, has_key, config FROM engine_providers WHERE id = 'eng_1'")
      .get();
    expect(r).toEqual({ kind: "openai", label: "本機", has_key: 1, config: "{}" });
    db.close();
  });
});
