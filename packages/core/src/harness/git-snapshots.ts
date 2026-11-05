import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { GIT_HARDEN_ARGS, hardenedGitEnv } from "@alca/os";
import type { GitSnapshotRecord, Store } from "@alca/store";

/**
 * Phase 5: git snapshots kept before each turn of a coding worker whose
 * engine may write without asking (完全授權 + an engine that asks only
 * sometimes).
 *
 * A snapshot is a commit of the whole work tree (tracked and untracked files
 * that `.gitignore` does not exclude) built in a throw-away index, stored
 * under a hidden ref `refs/alca/snapshots/<dispatchId>/<n>`: it is on no
 * branch, not in `git log`, and neither the person's index nor the work tree
 * is touched when it is taken.
 *
 * - at most 20 per repository (the oldest goes first);
 * - kept seven days after its dispatch settled, then the sweep deletes the
 *   ref; a throttled `git gc --prune` drops the objects;
 * - `restore` puts a snapshot's files back (after keeping one more snapshot
 *   of what is there now); `purge` deletes refs on request (Phase 6 UI).
 */
export const SNAPSHOT_REF_PREFIX = "refs/alca/snapshots";
export const SNAPSHOTS_PER_REPO = 20;
export const SNAPSHOT_KEEP_MS = 7 * 24 * 3600_000;
/** At most one `git gc` per repository per day. */
export const SNAPSHOT_GC_EVERY_MS = 24 * 3600_000;

const GIT_TIMEOUT_MS = 60_000;
const IDENTITY = {
  GIT_AUTHOR_NAME: "Alca",
  GIT_AUTHOR_EMAIL: "snapshots@alca.invalid",
  GIT_COMMITTER_NAME: "Alca",
  GIT_COMMITTER_EMAIL: "snapshots@alca.invalid",
};

export interface GitSnapshotsOptions {
  store: Store;
  now?: () => Date;
  /** The git program (tests may point at another). */
  git?: string;
}

export interface RestoreResult {
  /** Files written back from the snapshot. */
  restored: number;
  /** Files that were not in the snapshot and were removed. */
  removed: number;
  /** The snapshot of the work tree taken just before restoring. */
  before?: GitSnapshotRecord;
}

/** One spelling per folder (macOS temp folders are symlinks). */
const norm = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "dispatch";

export class GitSnapshots {
  private readonly o: GitSnapshotsOptions;
  private readonly lastGc = new Map<string, number>();
  constructor(o: GitSnapshotsOptions) {
    this.o = o;
  }

  private now(): number {
    return (this.o.now?.() ?? new Date()).getTime();
  }

  /**
   * Every git Alca runs here is hardened (next-round §5.6): no fsmonitor, no
   * hooks, no ssh command, no external diff, no pager, no system config — a
   * repository's own settings never run a program on Alca's behalf.
   */
  private git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
    return execFileSync(this.o.git ?? "git", [...GIT_HARDEN_ARGS, ...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...hardenedGitEnv(process.env), ...env },
    });
  }

  /** The repository root a folder belongs to, or undefined when it is not in a git work tree. */
  repoOf(dir: string): string | undefined {
    try {
      const top = this.git(dir, ["rev-parse", "--show-toplevel"]).trim();
      return top ? norm(top) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A commit of the work tree as it is now (throw-away index; the person's index is untouched). */
  private commitWorkTree(repo: string, message: string): string {
    const gitPath = this.git(repo, ["rev-parse", "--git-path", `alca-snapshot-index-${randomUUID()}`]).trim();
    const index = isAbsolute(gitPath) ? gitPath : join(repo, gitPath);
    const env = { GIT_INDEX_FILE: index, ...IDENTITY };
    try {
      let head: string | undefined;
      try {
        head = this.git(repo, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || undefined;
      } catch {
        head = undefined; // a repository without a first commit
      }
      if (head) this.git(repo, ["read-tree", head], env);
      this.git(repo, ["add", "-A", "--", "."], env);
      const tree = this.git(repo, ["write-tree"], env).trim();
      return this.git(repo, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message], env).trim();
    } finally {
      rmSync(index, { force: true });
    }
  }

  /**
   * Keep a snapshot of the repository `dir` is in, for this dispatch. Returns
   * undefined when `dir` is not in a git work tree; throws when git fails.
   */
  take(dir: string, dispatchId: string): GitSnapshotRecord | undefined {
    const repo = this.repoOf(dir);
    if (!repo) return undefined;
    const seq = this.o.store.gitSnapshots.nextSeq(repo, dispatchId);
    const ref = `${SNAPSHOT_REF_PREFIX}/${safeId(dispatchId)}/${seq}`;
    const commit = this.commitWorkTree(repo, `alca snapshot ${dispatchId} #${seq}`);
    this.git(repo, ["update-ref", ref, commit]);
    const rec: GitSnapshotRecord = { ref, repo, dispatchId, seq, commit, createdAt: this.now() };
    this.o.store.gitSnapshots.add(rec);
    this.cap(repo);
    return rec;
  }

  /** The newest `SNAPSHOTS_PER_REPO` stay; older ones are deleted. */
  private cap(repo: string): void {
    const all = this.o.store.gitSnapshots.ofRepo(repo);
    for (const old of all.slice(0, Math.max(0, all.length - SNAPSHOTS_PER_REPO))) this.drop(old);
  }

  /** Delete one snapshot's ref and its row (a ref already gone only loses its row). */
  private drop(s: GitSnapshotRecord): boolean {
    try {
      this.git(s.repo, ["update-ref", "-d", s.ref]);
    } catch {
      // the folder or the ref is gone: nothing left to delete in git
    }
    return this.o.store.gitSnapshots.remove(s.repo, s.ref);
  }

  list(filter: { repo?: string; dispatchId?: string }): GitSnapshotRecord[] {
    if (filter.dispatchId) {
      const rows = this.o.store.gitSnapshots.ofDispatch(filter.dispatchId);
      return filter.repo ? rows.filter((r) => r.repo === norm(filter.repo as string)) : rows;
    }
    return filter.repo ? this.o.store.gitSnapshots.ofRepo(norm(filter.repo)) : [];
  }

  /**
   * Put a snapshot's files back into its work tree: every file it holds is
   * written, and files it does not hold (and `.gitignore` does not exclude)
   * are removed. HEAD, branches and the person's index are not moved. What
   * is there now is kept as one more snapshot first.
   */
  restore(repo: string, ref: string): RestoreResult {
    const root = norm(repo);
    const s = this.o.store.gitSnapshots.get(root, ref);
    if (!s) throw new Error(`沒有這個快照：${ref}`);
    const before = this.take(root, s.dispatchId);
    const gitPath = this.git(root, ["rev-parse", "--git-path", `alca-restore-index-${randomUUID()}`]).trim();
    const index = isAbsolute(gitPath) ? gitPath : join(root, gitPath);
    const env = { GIT_INDEX_FILE: index };
    try {
      this.git(root, ["read-tree", s.commit], env);
      const kept = new Set(this.git(root, ["ls-files", "-z"], env).split("\0").filter(Boolean));
      const now = this.git(root, ["ls-files", "-z", "-c", "-o", "--exclude-standard"])
        .split("\0")
        .filter(Boolean);
      let removed = 0;
      for (const f of new Set(now)) {
        if (kept.has(f)) continue;
        const abs = resolve(root, f);
        const rel = relative(root, abs);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        try {
          unlinkSync(abs);
          removed++;
        } catch {
          // already gone (a deleted file still in the person's index)
        }
      }
      this.git(root, ["checkout-index", "-a", "-f"], env);
      return { restored: kept.size, removed, ...(before ? { before } : {}) };
    } finally {
      rmSync(index, { force: true });
    }
  }

  /** Delete snapshots on request (a ref, a dispatch's, or a repository's). Returns how many. */
  purge(filter: { repo?: string; dispatchId?: string; ref?: string }): number {
    let rows: GitSnapshotRecord[];
    if (filter.ref && filter.repo) {
      const one = this.o.store.gitSnapshots.get(norm(filter.repo), filter.ref);
      rows = one ? [one] : [];
    } else rows = this.list(filter);
    let n = 0;
    for (const s of rows) if (this.drop(s)) n++;
    for (const repo of new Set(rows.map((r) => r.repo))) this.gc(repo);
    return n;
  }

  /**
   * The sweep: snapshots whose dispatch settled more than seven days ago are
   * deleted, every repository is held to the cap, and repositories that lost
   * refs get a throttled `git gc --prune`.
   */
  sweep(): { expired: number; gcRuns: number } {
    const t = this.now();
    const gone = this.o.store.gitSnapshots.expired(t - SNAPSHOT_KEEP_MS);
    let expired = 0;
    for (const s of gone) if (this.drop(s)) expired++;
    for (const repo of this.o.store.gitSnapshots.repos()) this.cap(repo);
    let gcRuns = 0;
    for (const repo of new Set(gone.map((s) => s.repo))) if (this.gc(repo)) gcRuns++;
    return { expired, gcRuns };
  }

  /** `git gc --prune` at most once a day per repository; never fails the caller. */
  private gc(repo: string): boolean {
    const t = this.now();
    if (t - (this.lastGc.get(repo) ?? Number.NEGATIVE_INFINITY) < SNAPSHOT_GC_EVERY_MS) return false;
    this.lastGc.set(repo, t);
    try {
      this.git(repo, ["gc", "--quiet", "--prune=7.days.ago"]);
      return true;
    } catch {
      return false;
    }
  }
}
