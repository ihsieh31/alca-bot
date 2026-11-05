import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedEngine } from "@alca/engines";
import { WorkerHarness } from "@alca/protocol";
import { openStore, type WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotBeforeTurn } from "../src/agents/harness-run/full-access.ts";
import { harnessView } from "../src/agents/harness-run/view.ts";
import { GitSnapshots } from "../src/harness/git-snapshots.ts";

/**
 * 11-05: at 完全授權 the snapshot before a coding turn is best effort. A
 * folder that is not git, or a snapshot that fails, still lets the turn
 * start; the ledger says why (`snapshot.skipped`), `not_git` once per worker,
 * and the worker panel reads it back. Fictional data only.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const folder = (git: boolean) => {
  const d = mkdtempSync(join(tmpdir(), "alca-snapskip-"));
  dirs.push(d);
  writeFileSync(join(d, "a.txt"), "original\n");
  if (git) {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test" };
    const e2 = { ...env, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      ["commit", "-qm", "first"],
    ])
      execFileSync("git", args, { cwd: d, env: e2, stdio: "ignore" });
  }
  return d;
};

function bench(level = "full_access") {
  const store = openStore(":memory:");
  const bot = store.bots.ensureDefault();
  const t = store.threads.create("thr_01M6FS56CMD82Z8TY2D17VNKX1", "t", new Date(), bot.id);
  store.db
    .prepare("INSERT INTO jobs (id, kind, created_at, updated_at) VALUES ('j1','subagent','x','x')")
    .run();
  const d = store.dispatches.open({ botId: bot.id, threadId: t.id, harness: "coding", level });
  const w = store.workers.create({
    botId: bot.id,
    threadId: t.id,
    jobId: "j1",
    title: "改檔",
    goal: "把 a.txt 改掉",
    initiator: { kind: "user", id: "me" },
    budget: { maxSteps: 40, maxRunMs: 600_000, maxTokens: 90_000 },
    grants: { harness: "coding", dispatchId: d.id },
  });
  const now = () => new Date(10_000);
  const snapshots = new GitSnapshots({ store, now });
  const deps = { store, snapshots, now, levelOf: () => level };
  const get = () => store.workers.get(w.id) as WorkerRecord;
  const skipped = () =>
    store.dispatches.eventsOf(d.id, ["snapshot.skipped"]).map((e) => e.detail as Record<string, unknown>);
  return { store, deps, d, get, skipped };
}

const engine = new ScriptedEngine([]);

describe("best-effort snapshot at full access (11-05)", () => {
  it("not git: every turn may start; not_git is recorded once for the worker", () => {
    const b = bench();
    const dir = folder(false);
    for (let i = 0; i < 3; i++) expect(snapshotBeforeTurn(b.deps, b.get(), engine, dir)).toBeUndefined();
    expect(b.skipped()).toEqual([{ workerId: b.get().id, reason: "not_git" }]);
    expect(harnessView(b.store, b.get(), undefined)?.snapshotSkipped).toBe("not_git");
    // the panel field passes the wire schema
    const v = harnessView(b.store, b.get(), undefined);
    expect(WorkerHarness.safeParse(v).success).toBe(true);
  });

  it("no work folder at all counts as not git and still starts", () => {
    const b = bench();
    expect(snapshotBeforeTurn(b.deps, b.get(), engine, undefined)).toBeUndefined();
    expect(snapshotBeforeTurn(b.deps, b.get(), engine, undefined)).toBeUndefined();
    expect(b.skipped().map((x) => x.reason)).toEqual(["not_git"]);
  });

  it("git: a snapshot is kept every turn, nothing is skipped", () => {
    const b = bench();
    const dir = folder(true);
    expect(snapshotBeforeTurn(b.deps, b.get(), engine, dir)).toBeUndefined();
    expect(snapshotBeforeTurn(b.deps, b.get(), engine, dir)).toBeUndefined();
    expect(b.store.dispatches.eventsOf(b.d.id, ["snapshot"])).toHaveLength(2);
    expect(b.skipped()).toEqual([]);
    expect(harnessView(b.store, b.get(), undefined)?.snapshotSkipped).toBeUndefined();
  });

  it("a snapshot that fails: the turn starts, each failure is recorded, a later good one clears it", () => {
    const b = bench();
    const dir = folder(true);
    const real = b.deps.snapshots.take.bind(b.deps.snapshots);
    let broken = true;
    b.deps.snapshots.take = (d: string, id: string) => {
      if (broken) throw new Error("fatal: cannot lock ref");
      return real(d, id);
    };
    expect(snapshotBeforeTurn(b.deps, b.get(), engine, dir)).toBeUndefined();
    expect(snapshotBeforeTurn(b.deps, b.get(), engine, dir)).toBeUndefined();
    expect(b.skipped()).toEqual([
      { workerId: b.get().id, reason: "snapshot_failed", error: "fatal: cannot lock ref" },
      { workerId: b.get().id, reason: "snapshot_failed", error: "fatal: cannot lock ref" },
    ]);
    expect(harnessView(b.store, b.get(), undefined)?.snapshotSkipped).toBe("snapshot_failed");
    broken = false;
    expect(snapshotBeforeTurn(b.deps, b.get(), engine, dir)).toBeUndefined();
    expect(harnessView(b.store, b.get(), undefined)?.snapshotSkipped).toBeUndefined();
  });

  it("below full access nothing is taken or recorded", () => {
    const b = bench("autonomous");
    expect(snapshotBeforeTurn(b.deps, b.get(), engine, folder(false))).toBeUndefined();
    expect(b.skipped()).toEqual([]);
    expect(harnessView(b.store, b.get(), undefined)?.snapshotSkipped).toBeUndefined();
  });
});
