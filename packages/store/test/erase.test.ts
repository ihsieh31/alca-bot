import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BatchSizer,
  backupNow,
  drainSync,
  eraseTrailSteps,
  listBackups,
  MIGRATIONS,
  maintain,
  openDatabase,
  openStore,
  type Store,
  scrubBackupFile,
  threadsWithTrail,
} from "../src/index.ts";
import { seedConversation } from "./seed-conversation.ts";

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-erase-"));
  dirs.push(d);
  return join(d, "state.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MARK = "OKAPI-MARKER-5521-FAKE";
const count = (s: Store, sql: string, ...a: string[]) =>
  Number((s.db.prepare(sql).get(...a) as { n: number }).n);

const WHERE =
  "title|message|reply|event|jobtitle|jobinput|jobresult|jobevent|wtitle|goal|wresult|spill|approval|question|answer|report|devent|early|draft|memory";

/** Every suffix of MARK still readable in these bytes. */
function leftovers(...bufs: Buffer[]): string[] {
  const found = new Set<string>();
  for (const b of bufs) {
    const text = b.toString("latin1");
    for (const m of text.matchAll(new RegExp(`${MARK}-(${WHERE})`, "g"))) found.add(m[0]);
  }
  return [...found].sort();
}

const fileBytes = (p: string) => {
  try {
    return readFileSync(p);
  } catch {
    return Buffer.alloc(0);
  }
};

describe("approval and question cards follow a deleted conversation (migration 22)", () => {
  it("cannot be deleted while the thread is not marked deleted", () => {
    const s = openStore(":memory:");
    seedConversation(s, "t1", MARK);
    expect(() => s.db.prepare("DELETE FROM approvals WHERE id = 't1_a'").run()).toThrow(/kept for audit/);
    expect(() => s.db.prepare("DELETE FROM questions WHERE id = 't1_q'").run()).toThrow(/kept for audit/);
    // A card with no run and no worker belongs to no conversation.
    s.db
      .prepare(
        "INSERT INTO approvals (id, action_class, summary, status, requested_at) VALUES ('lone', 'send', 'x', 'pending', ?)",
      )
      .run(new Date().toISOString());
    s.threads.erase("t1");
    expect(() => s.db.prepare("DELETE FROM approvals WHERE id = 'lone'").run()).toThrow(/kept for audit/);
    s.close();
  });

  it("only the deleted thread's cards may go, not another thread's", () => {
    const s = openStore(":memory:");
    seedConversation(s, "t1", MARK);
    seedConversation(s, "t2", MARK);
    s.threads.erase("t1");
    expect(count(s, "SELECT COUNT(*) AS n FROM approvals")).toBe(1);
    expect(() => s.db.prepare("DELETE FROM approvals WHERE id = 't2_a'").run()).toThrow(/kept for audit/);
    s.close();
  });
});

describe("deleting a conversation removes its words (R5.4)", () => {
  it("nothing of it is left in the file or the WAL; the shell row and the other thread stay", () => {
    const path = tmpDb();
    const s = openStore(path);
    seedConversation(s, "t1", MARK);
    seedConversation(s, "keep", "KEEPME-MARKER-77");
    maintain(s.db, new Date());
    expect(leftovers(readFileSync(path)).length).toBeGreaterThan(10); // the test can see them while they exist
    expect(s.threads.erase("t1")).toBe(true);
    expect(maintain(s.db, new Date()).checkpointed).toBe(true);
    // The memory is kept by default (user decision): only its line may remain.
    expect(leftovers(readFileSync(path), fileBytes(`${path}-wal`))).toEqual([`${MARK}-memory`]);
    const shell = s.db.prepare("SELECT title, deleted_at FROM threads WHERE id = 't1'").get() as {
      title: string | null;
      deleted_at: string | null;
    };
    expect(shell.title).toBeNull();
    expect(shell.deleted_at).not.toBeNull();
    expect(count(s, "SELECT COUNT(*) AS n FROM runs WHERE thread_id = 't1'")).toBe(1); // ids and times stay
    expect(readFileSync(path).includes("KEEPME-MARKER-77-message")).toBe(true);
    expect(count(s, "SELECT COUNT(*) AS n FROM messages WHERE thread_id = 'keep'")).toBe(2);
    s.close();
  });

  it("with memories: the memories learned there go too", () => {
    const path = tmpDb();
    const s = openStore(path);
    seedConversation(s, "t1", MARK);
    s.threads.erase("t1", new Date(), { memories: true });
    maintain(s.db, new Date());
    expect(count(s, "SELECT COUNT(*) AS n FROM memories WHERE source_thread_id = 't1'")).toBe(0);
    expect(leftovers(readFileSync(path), fileBytes(`${path}-wal`))).toEqual([]);
    s.close();
  });

  it("trail later: the content goes at once, the trail in batches; a crash in between is found again", () => {
    const s = openStore(":memory:");
    seedConversation(s, "t1", MARK);
    s.threads.erase("t1", new Date(), { trail: "later" });
    expect(count(s, "SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't1'")).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events")).toBe(5);
    expect(threadsWithTrail(s.db)).toEqual(["t1"]);
    const steps = eraseTrailSteps(s.db, "t1", BatchSizer.fixed(2));
    let batches = 0;
    let r = steps.next();
    while (!r.done) {
      batches += 1;
      expect(s.db.isTransaction).toBe(false); // each batch committed on its own
      r = steps.next();
    }
    expect(batches).toBe(2); // 5 run events in batches of 2: two full batches, then the rest
    expect(r.value).toEqual({ run_events: 5, job_events: 1, spills: 1 });
    expect(threadsWithTrail(s.db)).toEqual([]);
    s.close();
  });

  it("the trail of a thread that is not deleted cannot be taken (the triggers refuse)", () => {
    const s = openStore(":memory:");
    seedConversation(s, "t1", MARK);
    expect(() => drainSync(eraseTrailSteps(s.db, "t1", BatchSizer.fixed(10)))).toThrow(/append-only/);
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events")).toBe(5);
    s.close();
  });
});

describe("scrubbing the backups (R5.4, user default on)", () => {
  it("a backup taken before the delete no longer holds the conversation", () => {
    const path = tmpDb();
    const s = openStore(path);
    seedConversation(s, "t1", MARK);
    seedConversation(s, "keep", "KEEPME-MARKER-77");
    const file = backupNow(s.db, path, new Date(), { kind: "daily" });
    expect(leftovers(readFileSync(file)).length).toBeGreaterThan(10);
    s.threads.erase("t1");
    const r = scrubBackupFile(file, ["t1"], new Date());
    expect(r).toEqual({ file, ok: true });
    expect(leftovers(readFileSync(file), fileBytes(`${file}-journal`))).toEqual([`${MARK}-memory`]);
    expect(readFileSync(file).includes("KEEPME-MARKER-77-message")).toBe(true);
    // Still a valid backup with the same name, kind and schema.
    expect(listBackups(path).map((b) => b.file)).toEqual([file]);
    const b = openDatabase({ path: file, readOnly: true });
    expect((b.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe(
      "ok",
    );
    b.close();
    // Again: nothing left to do.
    expect(scrubBackupFile(file, ["t1"], new Date())).toEqual({ file, ok: true, absent: true });
    s.close();
  });

  it("a backup from before migration 22 is reported and left untouched", () => {
    const path = tmpDb();
    const s = openStore(
      path,
      MIGRATIONS.filter((m) => m.version <= 21),
    );
    seedConversation(s, "t1", MARK);
    const file = backupNow(s.db, path, new Date(), { kind: "daily" });
    s.close();
    const before = readFileSync(file);
    const r = scrubBackupFile(file, ["t1"], new Date());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/schema 21/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("a file that is not a database is reported; the good backup beside it is untouched", () => {
    const path = tmpDb();
    const s = openStore(path);
    seedConversation(s, "t1", MARK);
    const file = backupNow(s.db, path, new Date(), { kind: "daily" });
    s.close();
    const copy = `${file}.orig`;
    copyFileSync(file, copy);
    // A file that is not a database at all fails; the good backup next to it is untouched.
    const junk = join(dirs[dirs.length - 1] as string, "backups", "state-v22-20260101T000000Z-daily.sqlite");
    writeFileSync(junk, "not sqlite at all, just text that is long enough to have a header");
    expect(scrubBackupFile(junk, ["t1"], new Date()).ok).toBe(false);
    expect(readFileSync(file).equals(readFileSync(copy))).toBe(true);
  });
});
