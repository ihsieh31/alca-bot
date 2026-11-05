import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@alca/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitSnapshots,
  SNAPSHOT_KEEP_MS,
  SNAPSHOT_REF_PREFIX,
  SNAPSHOTS_PER_REPO,
} from "../src/harness/git-snapshots.ts";

/** Phase 5: hidden snapshot refs — create, cap, expire, restore, manual purge. All data is made up. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  }).trim();

let dir: string;
let store: Store;
let clock: number;
let snaps: GitSnapshots;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alca-snap-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "dist/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  store = openStore(":memory:");
  clock = Date.UTC(2026, 10, 5, 1, 0, 0);
  snaps = new GitSnapshots({ store, now: () => new Date(clock) });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const refs = () =>
  git(dir, "for-each-ref", "--format=%(refname)", SNAPSHOT_REF_PREFIX).split("\n").filter(Boolean);

describe("git snapshots", () => {
  it("a snapshot is a hidden ref of the whole work tree; branches, log, index and files are untouched", () => {
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    git(dir, "add", "new.txt");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "out.js"), "ignored\n");
    const statusBefore = git(dir, "status", "--porcelain");
    const s = snaps.take(join(dir), "dsp_one");
    expect(s?.ref).toBe(`${SNAPSHOT_REF_PREFIX}/dsp_one/1`);
    expect(refs()).toEqual([`${SNAPSHOT_REF_PREFIX}/dsp_one/1`]);
    expect(git(dir, "show", `${s?.commit}:a.txt`)).toBe("two");
    expect(git(dir, "show", `${s?.commit}:new.txt`)).toBe("fresh");
    expect(() => git(dir, "show", `${s?.commit}:dist/out.js`)).toThrow();
    expect(git(dir, "branch", "--format=%(refname:short)")).toBe("main");
    expect(git(dir, "log", "--oneline")).not.toContain("alca snapshot");
    expect(git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("two\n");
  });

  it("a folder that is not a git work tree gets no snapshot", () => {
    const plain = mkdtempSync(join(tmpdir(), "alca-plain-"));
    try {
      expect(snaps.take(plain, "dsp_x")).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it(`keeps at most ${SNAPSHOTS_PER_REPO} per folder; the oldest goes first`, () => {
    for (let i = 0; i < SNAPSHOTS_PER_REPO + 3; i++) {
      clock += 1000;
      writeFileSync(join(dir, "a.txt"), `v${i}\n`);
      snaps.take(dir, i < 10 ? "dsp_a" : "dsp_b");
    }
    expect(refs()).toHaveLength(SNAPSHOTS_PER_REPO);
    expect(snaps.list({ repo: dir })).toHaveLength(SNAPSHOTS_PER_REPO);
    expect(refs()).not.toContain(`${SNAPSHOT_REF_PREFIX}/dsp_a/1`);
    expect(refs()).not.toContain(`${SNAPSHOT_REF_PREFIX}/dsp_a/3`);
    expect(refs()).toContain(`${SNAPSHOT_REF_PREFIX}/dsp_a/4`);
  });

  it("expire: kept seven days after the dispatch settled, then the sweep deletes the ref", () => {
    const d = store.dispatches.open(
      { botId: "bot_x", threadId: "thr_x", harness: "coding", level: "full_access" },
      clock,
    );
    snaps.take(dir, d.id);
    const open = store.dispatches.open(
      { botId: "bot_x", threadId: "thr_x", harness: "coding", level: "full_access" },
      clock,
    );
    snaps.take(dir, open.id);
    store.dispatches.park(d.id, "done", clock, "settled");
    clock += SNAPSHOT_KEEP_MS - 60_000;
    expect(snaps.sweep().expired).toBe(0);
    expect(refs()).toHaveLength(2);
    clock += 120_000;
    const r = snaps.sweep();
    expect(r.expired).toBe(1);
    expect(r.gcRuns).toBe(1);
    expect(refs()).toEqual([`${SNAPSHOT_REF_PREFIX}/${open.id}/1`]); // its dispatch has not settled
    // gc is throttled: a second expiry the same day does not run it again
    store.dispatches.park(open.id, "done", clock - SNAPSHOT_KEEP_MS - 1, "settled");
    expect(snaps.sweep()).toEqual({ expired: 1, gcRuns: 0 });
    expect(refs()).toEqual([]);
  });

  it("restore puts the snapshot's files back, removes newer ones, keeps HEAD, and saves what was there", () => {
    writeFileSync(join(dir, "a.txt"), "before the turn\n");
    const s = snaps.take(dir, "dsp_r");
    writeFileSync(join(dir, "a.txt"), "broken by the turn\n");
    writeFileSync(join(dir, "stray.txt"), "made by the turn\n");
    const head = git(dir, "rev-parse", "HEAD");
    const r = snaps.restore(dir, s?.ref as string);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("before the turn\n");
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
    expect(r.removed).toBe(1);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(r.before?.ref).toBe(`${SNAPSHOT_REF_PREFIX}/dsp_r/2`);
    expect(git(dir, "show", `${r.before?.commit}:stray.txt`)).toBe("made by the turn");
    expect(() => snaps.restore(dir, `${SNAPSHOT_REF_PREFIX}/nope/1`)).toThrow(/沒有這個快照/);
  });

  it("purge deletes on request: one ref, a dispatch's, a folder's", () => {
    for (const id of ["dsp_p", "dsp_p", "dsp_q", "dsp_q"]) {
      clock += 1000;
      snaps.take(dir, id);
    }
    expect(snaps.purge({ repo: dir, ref: `${SNAPSHOT_REF_PREFIX}/dsp_p/1` })).toBe(1);
    expect(snaps.purge({ dispatchId: "dsp_p" })).toBe(1);
    expect(refs()).toEqual([`${SNAPSHOT_REF_PREFIX}/dsp_q/1`, `${SNAPSHOT_REF_PREFIX}/dsp_q/2`]);
    expect(snaps.purge({ repo: dir })).toBe(2);
    expect(refs()).toEqual([]);
    expect(store.gitSnapshots.ofRepo(dir)).toEqual([]);
  });
});
