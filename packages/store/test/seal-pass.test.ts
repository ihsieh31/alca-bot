import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BatchSizer,
  drainSync,
  listBackups,
  MIGRATIONS,
  MigrationError,
  openStore,
  readSealProgress,
  restoreBackup,
  SEALED,
  SealError,
  Sealer,
  sealStatus,
  sealSteps,
} from "../src/index.ts";
import { seedConversation } from "./seed-conversation.ts";

/**
 * Next round R7.5 / R7.6 (Phase F2): the background pass over rows written
 * before the key existed, the old plaintext backups, restore and export.
 */

const newKey = () => new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } });
const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-seal-pass-"));
  dirs.push(d);
  return join(d, "state.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MARK = "OKAPI-SEALPASS-4410";
/** Suffixes of the columns R7 seals (seed-conversation names each place). */
const SEALED_PLACES =
  "message|reply|event|jobevent|jobtitle|jobinput|jobresult|goal|wresult|spill|approval|report|draft|memory";
const fileBytes = (p: string) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
function leftovers(...bufs: Buffer[]): string[] {
  const found = new Set<string>();
  for (const b of bufs)
    for (const m of b.toString("latin1").matchAll(new RegExp(`${MARK}-(${SEALED_PLACES})\\b`, "g")))
      found.add(m[1] as string);
  return [...found].sort();
}

/** A database written before the key existed: three conversations, all plaintext. */
function plainDb(path: string): void {
  const s = openStore(path);
  for (const t of ["t1", "t2", "t3"]) seedConversation(s, t, MARK);
  s.close();
}

describe("the seal pass (R7.5 step 4)", () => {
  it("seals every plaintext row; reads give the same text before and after", async () => {
    const path = tmpDb();
    plainDb(path);
    const k = newKey();
    const s = openStore(path, undefined, { sealer: k, inlineJobs: true });
    const before = {
      msgs: s.threads.messages("t1"),
      events: s.runs.events("t1_r"),
      worker: s.workers.get("t1_w"),
      approval: s.human.approval("t1_a")?.summary,
      mem: s.memory.list({}).map((m) => m.body),
      hits: s.memory.search(`${MARK}`, { any: true }).length,
    };
    expect(sealStatus(s.db).remaining).toBeGreaterThan(0);
    const r = await s.jobs.run("sealPass", null);
    expect(r.done).toBe(true);
    expect(sealStatus(s.db).remaining).toBe(0);
    expect(s.threads.messages("t1")).toEqual(before.msgs);
    expect(s.runs.events("t1_r")).toEqual(before.events);
    expect(s.workers.get("t1_w")).toEqual(before.worker);
    expect(s.human.approval("t1_a")?.summary).toBe(before.approval);
    expect(s.memory.list({}).map((m) => m.body)).toEqual(before.mem);
    // Search terms were rewritten as keyed tokens and the FTS index followed.
    expect(s.memory.search(MARK, { any: true }).length).toBe(3);
    expect(before.hits).toBe(0); // before the pass, a keyed query does not match plaintext terms
    expect(
      s.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')").run(),
    ).toBeTruthy();
    // Every gate is closed again.
    expect((s.db.prepare("SELECT SUM(open) AS n FROM seal_gate").get() as { n: number }).n).toBe(0);
    await s.stop();
  });

  it("stops part way, keeps its place in meta.seal_progress, and goes on after a restart", async () => {
    const path = tmpDb();
    plainDb(path);
    const wire = newKey().toWire();
    const a = openStore(path, undefined, { sealer: new Sealer(wire), inlineJobs: true });
    const total = sealStatus(a.db).remaining;
    const first = await a.jobs.run("sealPass", 4);
    expect(first.done).toBe(false);
    const left = sealStatus(a.db).remaining;
    expect(left).toBeLessThan(total);
    expect(left).toBeGreaterThan(0);
    expect(Object.keys(readSealProgress(a.db)).length).toBeGreaterThan(0);
    a.close();
    const b = openStore(path, undefined, { sealer: new Sealer(wire), inlineJobs: true });
    const second = await b.jobs.run("sealPass", null);
    expect(second.done).toBe(true);
    expect(sealStatus(b.db).remaining).toBe(0);
    expect(readSealProgress(b.db).done).toBeTruthy();
    b.close();
  });

  it("runs on the database worker thread with the same key", async () => {
    const path = tmpDb();
    plainDb(path);
    const k = newKey();
    const s = openStore(path, undefined, { sealer: k, inlineJobs: false });
    expect(s.jobs.mode).toBe("worker");
    const r = await s.jobs.run("sealPass", null);
    expect(r.done).toBe(true);
    expect(sealStatus(s.db).remaining).toBe(0);
    // Sealed by the worker, opened by the main connection: the same key ring.
    expect(s.threads.messages("t2")[0]?.content).toBe(`${MARK}-message`);
    await s.stop();
  });

  it("leaves no plaintext of the sealed columns in the file, its WAL, or a new backup", async () => {
    const path = tmpDb();
    plainDb(path);
    const s = openStore(path, undefined, { sealer: newKey(), inlineJobs: true });
    expect(leftovers(fileBytes(path), fileBytes(`${path}-wal`)).length).toBeGreaterThan(0);
    await s.jobs.run("sealPass", null);
    const backup = await s.jobs.run("backup", new Date().toISOString(), "manual", 7);
    expect(leftovers(fileBytes(path), fileBytes(`${path}-wal`), fileBytes(backup))).toEqual([]);
    await s.stop();
    expect(leftovers(fileBytes(path), fileBytes(`${path}-wal`))).toEqual([]);
  });

  it("needs a key", () => {
    const s = openStore(":memory:");
    expect(() => drainSync(sealSteps(s.db, BatchSizer.fixed(10)))).toThrow(SealError);
    s.close();
  });
});

describe("old plaintext backups (R7.5 step 5, user decision: delete only once everything is sealed)", () => {
  it("lists the backups taken before the pass finished, refuses to drop them until then", async () => {
    const path = tmpDb();
    plainDb(path);
    // Opening with migration 25 pending takes a pre-migration backup (plaintext).
    const s = openStore(path, undefined, { sealer: newKey(), inlineJobs: true });
    expect(s.migration.backup).toBeUndefined(); // plainDb already ran every migration
    const old = await s.jobs.run("backup", new Date(Date.now() - 60_000).toISOString(), "daily", 7);
    const st = await s.jobs.run("sealStatus");
    expect(st.backups.map((b) => b.file)).toContain(old);
    await expect(s.jobs.run("dropPlaintextBackups", new Date().toISOString())).rejects.toThrow(/尚未加密/);
    expect(existsSync(old)).toBe(true);
    await s.jobs.run("sealPass", null);
    const r = await s.jobs.run("dropPlaintextBackups", new Date(Date.now() + 2000).toISOString());
    expect(existsSync(old)).toBe(false);
    expect(r.removed).toContain(old.split("/").pop());
    expect(existsSync(r.backup)).toBe(true);
    expect(listBackups(path).map((b) => b.file)).toEqual([r.backup]);
    expect((await s.jobs.run("sealStatus")).backups).toEqual([]);
    expect(leftovers(fileBytes(r.backup))).toEqual([]);
    await s.stop();
  });

  it("without a key nothing is dropped", async () => {
    const path = tmpDb();
    plainDb(path);
    const s = openStore(path, undefined, { inlineJobs: true });
    await expect(s.jobs.run("dropPlaintextBackups", new Date().toISOString())).rejects.toThrow(
      /沒有資料金鑰/,
    );
    await s.stop();
  });
});

describe("restore and export with a data key (R7.6)", () => {
  it("restore refuses a backup sealed with another key; the same key restores", async () => {
    const path = tmpDb();
    const k = newKey();
    const s = openStore(path, undefined, { sealer: k, inlineJobs: true });
    seedConversation(s, "t1", MARK);
    const backup = await s.jobs.run("backup", new Date().toISOString(), "manual", 7);
    await s.stop();
    expect(() => restoreBackup(path, backup, MIGRATIONS, new Date(), { sealer: newKey() })).toThrow(
      /另一把資料金鑰/,
    );
    // Without the key (CLI, update rollback): the ring fingerprints decide.
    const other = tmpDb();
    const o = openStore(other, undefined, { sealer: newKey() });
    o.close();
    expect(() => restoreBackup(other, backup, MIGRATIONS)).toThrow(MigrationError);
    const r = restoreBackup(path, backup, MIGRATIONS, new Date(), { sealer: new Sealer(k.toWire()) });
    expect(r.version).toBe(32);
  });

  it("an export holds plaintext (no key needed to move it); the import is sealed under the new ids", async () => {
    const k = newKey();
    const a = openStore(tmpDb(), undefined, { sealer: k, inlineJobs: true });
    seedConversation(a, "t1", MARK);
    // seedConversation writes raw SQL: seal what it wrote, as the pass would.
    await a.jobs.run("sealPass", null);
    const file = join(dirs[0] as string, "t1.alca-export");
    await a.jobs.run("exportThread", "t1", file, { memories: true });
    await a.stop();
    const text = (await import("node:zlib")).gunzipSync(readFileSync(file)).toString("utf8");
    expect(text).toContain(`${MARK}-message`);
    const b = openStore(tmpDb(), undefined, { sealer: newKey(), inlineJobs: true });
    const imp = await b.jobs.run("importThread", file, {});
    expect(b.threads.messages(imp.threadId).map((m) => m.content)).toEqual([
      `${MARK}-message`,
      `${MARK}-reply`,
    ]);
    expect(sealStatus(b.db).remaining).toBe(0);
    await b.stop();
  });
});

describe("no SQL outside the store reads a sealed column (R7.4 static scan)", () => {
  it("only packages/store/src/repos, seal*.ts, export.ts and erase.ts (and the evals) name sealed content columns in SQL", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const root = join(import.meta.dirname, "..", "..", "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        if (n === "node_modules" || n === "test" || n === "dist" || n.startsWith(".")) continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith(".ts")) files.push(p);
      }
    };
    for (const top of ["packages", "apps", "services"]) walk(join(root, top));
    const allowed =
      /packages\/store\/src\/(repos\/|seal|export\.ts|erase\.ts|migrations\/)|packages\/evals\//;
    const bad: string[] = [];
    for (const f of files) {
      if (allowed.test(f)) continue;
      const src = readFileSync(f, "utf8");
      for (const sql of src.match(/`[^`]*`|"[^"\n]*"/g) ?? []) {
        if (!/\b(SELECT|INSERT|UPDATE)\b/i.test(sql)) continue;
        for (const [t, spec] of Object.entries(SEALED)) {
          if (!new RegExp(`\\b${t}\\b`).test(sql)) continue;
          for (const c of spec.cols)
            if (new RegExp(`\\b${c}\\b|SELECT\\s+(\\w+\\.)?\\*|\\b\\w+\\.\\*`).test(sql))
              bad.push(`${f.slice(root.length)}: ${t}.${c}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
