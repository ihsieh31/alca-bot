import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExportError,
  exportThread,
  importThread,
  MIGRATIONS,
  openStore,
  REFS,
  readExportManifest,
  type Store,
} from "../src/index.ts";
import { seedConversation } from "./seed-conversation.ts";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-exp-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MARK = "TAPIR-MARKER-3110-FAKE";
const n = (s: Store, sql: string, ...a: string[]) => Number((s.db.prepare(sql).get(...a) as { n: number }).n);

describe("single-conversation export and restore (R5.6)", () => {
  it("every foreign key of a carried table is in the reference list", () => {
    const s = openStore(":memory:");
    for (const t of Object.keys(REFS)) {
      const fks = s.db.prepare(`PRAGMA foreign_key_list(${t})`).all() as Array<{
        from: string;
        table: string;
      }>;
      for (const fk of fks) expect(REFS[t]?.[fk.from], `${t}.${fk.from} → ${fk.table}`).toBeDefined();
    }
    s.close();
  });

  it("export → delete → import: the same rows come back, all with new ids, as a live conversation", () => {
    const d = tmpDir();
    const s = openStore(join(d, "state.sqlite"));
    seedConversation(s, "t1", MARK);
    const file = join(d, "t1.alca-export");
    const out = exportThread(s.db, "t1", file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(out.counts).toMatchObject({ threads: 1, messages: 2, run_events: 5, approvals: 1, workers: 1 });
    expect(out.counts.memories).toBeUndefined(); // only when asked
    s.threads.erase("t1");
    const r = importThread(s.db, file);
    expect(r.threadId).not.toBe("t1");
    expect(r.counts).toEqual(out.counts);
    const t = s.threads.get(r.threadId);
    expect(t?.title).toBe(`${MARK}-title`);
    expect(n(s, "SELECT COUNT(*) AS n FROM threads WHERE id = ? AND deleted_at IS NULL", r.threadId)).toBe(1);
    // The deleted shell stays deleted.
    expect(n(s, "SELECT COUNT(*) AS n FROM threads WHERE id = 't1' AND deleted_at IS NOT NULL")).toBe(1);
    expect(n(s, "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?", r.threadId)).toBe(2);
    expect(
      n(
        s,
        "SELECT COUNT(*) AS n FROM run_events e JOIN runs r ON r.id = e.run_id WHERE r.thread_id = ?",
        r.threadId,
      ),
    ).toBe(5);
    expect(
      n(
        s,
        "SELECT COUNT(*) AS n FROM approvals a JOIN runs r ON r.id = a.run_id JOIN workers w ON w.id = a.worker_id WHERE r.thread_id = ?1 AND w.thread_id = ?1",
        r.threadId,
      ),
    ).toBe(1);
    // No old id survives anywhere in the imported rows.
    for (const old of ["t1_r", "t1_m1", "t1_j", "t1_w", "t1_s", "t1_a", "t1_q", "t1_d", "t1_dr"])
      expect(n(s, "SELECT COUNT(*) AS n FROM messages WHERE id = ?", old)).toBe(0);
    expect(n(s, "SELECT COUNT(*) AS n FROM workers WHERE id = 't1_w'")).toBe(1); // the scrubbed original
    expect(
      n(s, "SELECT COUNT(*) AS n FROM workers WHERE thread_id = ? AND goal = ?", r.threadId, `${MARK}-goal`),
    ).toBe(1);
    expect(
      n(s, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'data.restored' AND target = ?", r.threadId),
    ).toBe(1);
    expect(s.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    s.close();
  });

  it("importing the same file twice makes two conversations", () => {
    const d = tmpDir();
    const s = openStore(join(d, "state.sqlite"));
    seedConversation(s, "t1", MARK);
    const file = join(d, "t1.alca-export");
    exportThread(s.db, "t1", file, { memories: true });
    const a = importThread(s.db, file);
    const b = importThread(s.db, file);
    expect(a.threadId).not.toBe(b.threadId);
    expect(a.counts.memories).toBe(1);
    expect(n(s, "SELECT COUNT(*) AS n FROM memories WHERE body = ?", `${MARK}-memory`)).toBe(3);
    s.close();
  });

  it("a sealed export opens only with its passphrase; nothing readable inside without it", () => {
    const d = tmpDir();
    const s = openStore(join(d, "state.sqlite"));
    seedConversation(s, "t1", MARK);
    const file = join(d, "t1.alca-export");
    exportThread(s.db, "t1", file, { passphrase: "correct horse" });
    expect(gunzipSync(readFileSync(file)).toString("utf8").includes(MARK)).toBe(false);
    expect(readExportManifest(file).sealed).toBe("passphrase");
    expect(() => importThread(s.db, file)).toThrow(/passphrase is needed/);
    expect(() => importThread(s.db, file, { passphrase: "wrong horse" })).toThrow(/wrong passphrase/);
    const before = n(s, "SELECT COUNT(*) AS n FROM threads");
    expect(importThread(s.db, file, { passphrase: "correct horse" }).counts.messages).toBe(2);
    expect(n(s, "SELECT COUNT(*) AS n FROM threads")).toBe(before + 1);
    s.close();
  });

  it("an older-schema export imports into a newer store; a newer-schema export is refused", () => {
    const d = tmpDir();
    const old = openStore(
      join(d, "old.sqlite"),
      MIGRATIONS.filter((m) => m.version <= 21),
    );
    seedConversation(old, "t1", MARK);
    const file = join(d, "t1.alca-export");
    exportThread(old.db, "t1", file);
    old.close();
    const s = openStore(join(d, "state.sqlite"));
    expect(readExportManifest(file).schema).toBe(21);
    expect(importThread(s.db, file).schema).toBe(21);
    // Pretend a file from the future.
    const lines = gunzipSync(readFileSync(file)).toString("utf8").split("\n");
    const m = JSON.parse(lines[0] as string);
    m.schema = 999;
    lines[0] = JSON.stringify(m);
    writeFileSync(file, gzipSync(lines.join("\n")));
    expect(() => importThread(s.db, file)).toThrow(/newer Alca/);
    s.close();
  });

  it("a failing import leaves nothing behind", () => {
    const d = tmpDir();
    const s = openStore(join(d, "state.sqlite"));
    seedConversation(s, "t1", MARK);
    const file = join(d, "t1.alca-export");
    exportThread(s.db, "t1", file);
    const lines = gunzipSync(readFileSync(file)).toString("utf8").trimEnd().split("\n");
    // A broken last row (a NOT NULL column emptied) makes the insert fail halfway.
    const last = JSON.parse(lines[lines.length - 1] as string);
    last.r.created_at = null;
    if (last.t === "harness_waits" || last.t === "dispatch_events") last.r.at = null;
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(file, gzipSync(lines.join("\n")));
    const threads = n(s, "SELECT COUNT(*) AS n FROM threads");
    const events = n(s, "SELECT COUNT(*) AS n FROM run_events");
    expect(() => importThread(s.db, file)).toThrow();
    expect(n(s, "SELECT COUNT(*) AS n FROM threads")).toBe(threads);
    expect(n(s, "SELECT COUNT(*) AS n FROM run_events")).toBe(events);
    expect(s.db.isTransaction).toBe(false);
    s.close();
  });

  it("refuses what is not an export", () => {
    const d = tmpDir();
    const s = openStore(":memory:");
    const junk = join(d, "x.alca-export");
    writeFileSync(junk, "hello");
    expect(() => importThread(s.db, junk)).toThrow(ExportError);
    expect(() => exportThread(s.db, "nope", join(d, "n.alca-export"))).toThrow(/no conversation/);
    s.close();
  });
});
