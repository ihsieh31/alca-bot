import type { DatabaseSync } from "node:sqlite";

/**
 * Phase 5: the registry of hidden git snapshot refs
 * (`refs/alca/snapshots/<dispatchId>/<n>`). The refs live in the repository;
 * this table only says where they are, so a sweep can cap and expire them
 * without walking every folder on the machine.
 */
export interface GitSnapshotRecord {
  ref: string;
  repo: string;
  dispatchId: string;
  seq: number;
  commit: string;
  createdAt: number;
}

interface Row {
  ref: string;
  repo: string;
  dispatch_id: string;
  seq: number;
  commit_sha: string;
  created_at: number;
}

const rec = (r: Row): GitSnapshotRecord => ({
  ref: r.ref,
  repo: r.repo,
  dispatchId: r.dispatch_id,
  seq: Number(r.seq),
  commit: r.commit_sha,
  createdAt: Number(r.created_at),
});

export class GitSnapshotRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(r: GitSnapshotRecord): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO git_snapshots (ref, repo, dispatch_id, seq, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(r.ref, r.repo, r.dispatchId, r.seq, r.commit, r.createdAt);
  }

  /** The next sequence number of a dispatch's snapshots in one repository. */
  nextSeq(repo: string, dispatchId: string): number {
    const r = this.db
      .prepare("SELECT MAX(seq) AS m FROM git_snapshots WHERE repo = ? AND dispatch_id = ?")
      .get(repo, dispatchId) as { m: number | null } | undefined;
    return Number(r?.m ?? 0) + 1;
  }

  /** A repository's snapshots, oldest first. */
  ofRepo(repo: string): GitSnapshotRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM git_snapshots WHERE repo = ? ORDER BY created_at, seq, rowid")
        .all(repo) as unknown as Row[]
    ).map(rec);
  }

  /** A dispatch's snapshots, oldest first. */
  ofDispatch(dispatchId: string): GitSnapshotRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM git_snapshots WHERE dispatch_id = ? ORDER BY created_at, seq, rowid")
        .all(dispatchId) as unknown as Row[]
    ).map(rec);
  }

  get(repo: string, ref: string): GitSnapshotRecord | undefined {
    const r = this.db.prepare("SELECT * FROM git_snapshots WHERE repo = ? AND ref = ?").get(repo, ref) as
      | Row
      | undefined;
    return r ? rec(r) : undefined;
  }

  repos(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT repo FROM git_snapshots ORDER BY repo").all() as Array<{
      repo: string;
    }>;
    return rows.map((r) => r.repo);
  }

  /**
   * Snapshots whose dispatch settled before `before` (epoch ms). A snapshot
   * whose dispatch row is gone counts as settled when it was taken.
   */
  expired(before: number): GitSnapshotRecord[] {
    return (
      this.db
        .prepare(
          `SELECT s.* FROM git_snapshots s LEFT JOIN dispatches d ON d.id = s.dispatch_id
           WHERE COALESCE(d.finished_at, CASE WHEN d.id IS NULL THEN s.created_at END) < ?
           ORDER BY s.created_at, s.seq`,
        )
        .all(before) as unknown as Row[]
    ).map(rec);
  }

  remove(repo: string, ref: string): boolean {
    const r = this.db.prepare("DELETE FROM git_snapshots WHERE repo = ? AND ref = ?").run(repo, ref);
    return Number(r.changes) > 0;
  }
}
