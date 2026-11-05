// Phase 6: the snapshot list of a dispatch (hidden git refs taken before each
// coding turn at 完全授權) and the confirm step in front of 還原 / 清除.
// Pure (no DOM): the gate decides what runs; worker-harness.ts draws it.
import { t } from "./i18n/index.ts";

export interface Snapshot {
  ref: string;
  repo: string;
  dispatchId: string;
  seq: number;
  commit: string;
  /** ms since epoch. */
  createdAt: number;
}

export interface RestoreResult {
  restored: number;
  removed: number;
  before?: Snapshot;
}

export type SnapshotAction = { kind: "restore"; snapshot: Snapshot } | { kind: "purge"; snapshot?: Snapshot };

export interface ConfirmText {
  title: string;
  body: string;
  yes: string;
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return t("common.justNow");
  const m = Math.floor(s / 60);
  if (m < 60) return t("desktop.snapshotView.minAgo", { m });
  const hr = Math.floor(m / 60);
  return hr < 24 ? t("desktop.snapshotView.hrAgo", { hr }) : t("common.daysAgo", { p0: Math.floor(hr / 24) });
}

export function snapshotLabel(s: Snapshot, now = Date.now()): string {
  return t("desktop.snapshotView.beforeRound", {
    seq: s.seq,
    createdAt: ago(s.createdAt, now),
    p2: s.commit.slice(0, 7),
  });
}

/** The question asked before an action runs. */
export function confirmText(a: SnapshotAction, count: number): ConfirmText {
  if (a.kind === "restore")
    return {
      title: t("desktop.snapshotView.restoreToBeforeRound", { seq: a.snapshot.seq }),
      body: t("desktop.snapshotView.filesInTheWorkFolder"),
      yes: t("common.restore"),
    };
  if (a.snapshot)
    return {
      title: t("desktop.snapshotView.clearTheBeforeRoundSnapshot", { seq: a.snapshot.seq }),
      body: t("desktop.snapshotView.afterClearingYouCantRestore"),
      yes: t("common.clear"),
    };
  return {
    title: t("desktop.snapshotView.clearThisJobsSnapshots", { count }),
    body: t("desktop.snapshotView.afterClearingYouCantRestore2"),
    yes: t("desktop.snapshotView.clearAll"),
  };
}

/**
 * Nothing runs on the first click: `ask` only names what would happen;
 * `confirm` runs it once (a second click while it runs does nothing), and
 * `cancel` drops it.
 */
export class ConfirmGate {
  private pendingAction: SnapshotAction | undefined;
  private running = false;
  private readonly run: (a: SnapshotAction) => Promise<void>;

  constructor(run: (a: SnapshotAction) => Promise<void>) {
    this.run = run;
  }

  get pending(): SnapshotAction | undefined {
    return this.pendingAction;
  }

  get busy(): boolean {
    return this.running;
  }

  ask(a: SnapshotAction): void {
    if (!this.running) this.pendingAction = a;
  }

  cancel(): void {
    if (!this.running) this.pendingAction = undefined;
  }

  async confirm(): Promise<boolean> {
    const a = this.pendingAction;
    if (!a || this.running) return false;
    this.running = true;
    try {
      await this.run(a);
      return true;
    } finally {
      this.running = false;
      this.pendingAction = undefined;
    }
  }
}

export function restoredLine(r: RestoreResult): string {
  return t("desktop.snapshotView.restoredFilesHowItLooked", {
    restored: r.restored,
    p1: r.removed ? t("desktop.snapshotView.removedFilesAddedAfterThe", { removed: r.removed }) : "",
  });
}
