import { checkHarnessFit, type Engine, type HarnessFit } from "@alca/engines";
import type { Store, WorkerRecord } from "@alca/store";
import type { GitSnapshots } from "../../harness/git-snapshots.ts";
import type { HarnessKind } from "../../harness/kinds.ts";

/**
 * Phase 5: the host side of 完全授權 for coding work. At this level the gate
 * clears writes and commands unasked for every engine (mac B2: Claude Code,
 * ACP and Alca's own loop as much as Codex on-request), so every coding turn
 * starts from a git snapshot the person can go back to, where one can be kept.
 * Decision of 11-05: the snapshot is best effort. A folder that is not git, or
 * a snapshot that fails, does not stop the turn; the ledger records why there
 * is none (`snapshot.skipped`) so the worker panel can say so.
 */
export interface FullAccessDeps {
  store: Store;
  snapshots: GitSnapshots;
  now: () => Date;
  levelOf: (botId: string, threadId: string) => string;
}

/** Why a coding turn at full access has no snapshot. */
export type SnapshotSkipReason = "not_git" | "snapshot_failed";

/** The ledger event for a turn that starts without a snapshot. */
export const SNAPSHOT_SKIPPED = "snapshot.skipped";

/** The fit of a dispatch, by level (whether the folder is git does not change it). */
export function dispatchFit(engine: Engine, kind: HarnessKind, level: string): HarnessFit {
  return checkHarnessFit(engine, kind, undefined, { level });
}

/** Whether this worker already has a `not_git` line (it is written once per worker, not per turn). */
function notGitRecorded(store: Store, dispatchId: string, workerId: string): boolean {
  return store.dispatches.eventsOf(dispatchId, [SNAPSHOT_SKIPPED]).some((e) => {
    const d = e.detail as { workerId?: unknown; reason?: unknown } | null;
    return d?.workerId === workerId && d?.reason === "not_git";
  });
}

function recordSkip(
  deps: FullAccessDeps,
  dispatchId: string,
  w: WorkerRecord,
  reason: SnapshotSkipReason,
  error?: string,
): void {
  try {
    if (reason === "not_git" && notGitRecorded(deps.store, dispatchId, w.id)) return;
    deps.store.dispatches.event(dispatchId, SNAPSHOT_SKIPPED, deps.now().getTime(), {
      detail: { workerId: w.id, reason, ...(error ? { error: error.slice(0, 200) } : {}) },
    });
  } catch {
    // the turn goes on either way; the ledger line is a record of it
  }
}

/**
 * Before a coding turn: keep a snapshot when the turn may write without
 * asking (every engine at 完全授權). Returns why the turn must not start (only
 * when the level changed so the engine no longer fits), or undefined to go on.
 * No git folder, or a git failure, records `snapshot.skipped` and goes on.
 */
export function snapshotBeforeTurn(
  deps: FullAccessDeps,
  w: WorkerRecord,
  engine: Engine,
  dir: string | undefined,
): string | undefined {
  if (w.grants.harness !== "coding") return undefined;
  const level = deps.levelOf(w.botId, w.threadId);
  const fit = checkHarnessFit(engine, "coding", undefined, { level });
  if (!fit.ok) return `權限等級已改變，這個引擎不能再做 coding 工作（${fit.reason}）`;
  if (!fit.snapshotEachTurn) return undefined;
  const dispatchId = w.grants.dispatchId;
  if (!dispatchId) return undefined;
  if (!dir) {
    recordSkip(deps, dispatchId, w, "not_git");
    return undefined;
  }
  try {
    const s = deps.snapshots.take(dir, dispatchId);
    if (!s) {
      recordSkip(deps, dispatchId, w, "not_git");
      return undefined;
    }
    try {
      deps.store.dispatches.event(dispatchId, "snapshot", deps.now().getTime(), {
        detail: { ref: s.ref, commit: s.commit, repo: s.repo },
      });
    } catch {
      // the ref is kept either way; the ledger line is a record of it
    }
  } catch (err) {
    recordSkip(deps, dispatchId, w, "snapshot_failed", String((err as Error)?.message ?? err));
  }
  return undefined;
}
