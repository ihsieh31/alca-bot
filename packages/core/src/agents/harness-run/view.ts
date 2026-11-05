import type { HarnessPhaseT, WorkerHarnessT } from "@alca/protocol";
import {
  CAP_EXPIRE_MS,
  type DispatchEventRecord,
  type DispatchRecord,
  MAX_CONTINUES,
  type Store,
  type WaitRecord,
  type WorkerRecord,
} from "@alca/store";
import type { NeedsInputQuestion } from "../../harness/contract.ts";
import type { HarnessResult } from "./ledger.ts";

/**
 * Phase 6: the harness part of a worker's state, for the desktop and phone
 * worker panels. Read only from the store — the worker row, its dispatch,
 * the wait it opened and the dispatch's append-only events — never from a
 * running loop, so a reload or a restart shows the same thing.
 */

/** The dispatch events the panel reads (never the per-second progress rows). */
const VIEW_KINDS = [
  "verify.started",
  "verify.result",
  "auto_allowed",
  "review.result",
  "review.skipped",
  "snapshot",
  "snapshot.skipped",
] as const;
export const AUTO_ALLOWED_SHOWN = 20;

const iso = (ms: number) => new Date(ms).toISOString();
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

const OUTCOME_PHASE: Record<string, HarnessPhaseT> = {
  done: "done",
  partial: "partial",
  budget: "partial",
  unverified: "unverified",
  blocked: "blocked",
  needs_input: "waiting_input",
  stopped: "stopped",
  failed: "failed",
  interrupted: "failed",
  interrupted_after_outward: "needs_review",
  expired: "expired",
};

/** Whether an event belongs to one of this worker's executions (fence tokens are `<worker>:<n>`). */
const ofWorker = (e: DispatchEventRecord, w: WorkerRecord) => !!e.runId?.startsWith(`${w.id}:`);

export function harnessPhase(
  w: WorkerRecord,
  d: DispatchRecord | undefined,
  wait: WaitRecord | undefined,
  mine: HarnessResult | undefined,
  verifying: boolean,
): HarnessPhaseT {
  if (w.status === "queued") return "queued";
  if (w.status === "running" || w.status === "waiting") return verifying ? "verifying" : "running";
  if (w.status === "needs_review") return "needs_review";
  if (wait) {
    if (wait.state === "open") return wait.kind === "needs_input" ? "waiting_input" : "waiting_event";
    if (wait.state === "claimed") return "continued";
    if (wait.state === "expired") return "expired";
    if (wait.state === "closed" && d?.outcome === "stopped") return "stopped";
  }
  if (d && mine && d.outcome) {
    if (d.status === "needs_review") return "needs_review";
    const p = OUTCOME_PHASE[d.outcome];
    if (p) return p;
  }
  if (mine) {
    const p = OUTCOME_PHASE[mine.report.status];
    if (p) return p;
  }
  return w.status === "succeeded" ? "done" : w.status === "failed" ? "failed" : "stopped";
}

function verification(
  events: readonly DispatchEventRecord[],
  mine: HarnessResult | undefined,
): { view: WorkerHarnessT["verification"]; running: boolean } {
  const started = events.filter((e) => e.kind === "verify.started").at(-1);
  const done = events.filter((e) => e.kind === "verify.result").at(-1);
  const running = !!started && (!done || done.seq < started.seq);
  if (!started && !done) {
    if (mine?.verified === undefined) return { view: undefined, running: false };
    return {
      view: {
        state: mine.verified ? "passed" : "failed",
        round: 0,
        checks: [],
        ...(mine.checkFeedback ? { feedback: mine.checkFeedback.slice(0, 2000) } : {}),
      },
      running: false,
    };
  }
  const r = rec(done?.detail);
  const checks = (Array.isArray(r.checks) ? r.checks : []).slice(0, 10).map((c) => {
    const x = rec(c);
    const exitCode = typeof x.exitCode === "number" ? Math.trunc(x.exitCode) : null;
    return { command: str(x.command, 300), exitCode, ok: exitCode === 0, summary: str(x.summary, 600) };
  });
  const round = Number(rec((running ? started : done)?.detail).round) || 0;
  const state = running ? "running" : r.ok === true ? "passed" : checks.length ? "failed" : "none";
  const feedback = !running && r.ok !== true ? mine?.checkFeedback : undefined;
  return {
    view: {
      state,
      round,
      checks: running ? [] : checks,
      ...(feedback ? { feedback: feedback.slice(0, 2000) } : {}),
    },
    running,
  };
}

/** B4: the reviewer's last outcome for this worker (a verdict or a skip with its reason). */
function reviewOf(events: readonly DispatchEventRecord[]): WorkerHarnessT["review"] {
  const last = events.filter((e) => e.kind === "review.result" || e.kind === "review.skipped").at(-1);
  if (!last) return undefined;
  const r = rec(last.detail);
  const round = Math.max(0, Math.trunc(Number(r.round) || 0));
  if (last.kind === "review.skipped")
    return { state: "skipped", round, reason: str(r.reason, 80) || "unknown" };
  if (r.met === true) return { state: "met", round };
  const gaps = (Array.isArray(r.gaps) ? r.gaps : [])
    .slice(0, 10)
    .map((g) => str(g, 300))
    .filter(Boolean);
  return { state: "gaps", round, ...(gaps.length ? { gaps } : {}) };
}

/**
 * Mac test 2026-11 B6: the status a worker's state shows, agreeing with its
 * harness phase. The stored status stays (the supervisor, watchdog and
 * router read it); only what the panels and the API show changes: a worker
 * whose execution ended but whose task waits on an answer or an event is
 * `waiting`, a task that ended short of done (blocked, unverified, partial)
 * is `needs_review` (a person should look), never `succeeded`.
 */
export function shownStatus(
  status: WorkerRecord["status"],
  phase: HarnessPhaseT | undefined,
): WorkerRecord["status"] {
  if (!phase || status !== "succeeded") return status;
  if (phase === "waiting_input" || phase === "waiting_event") return "waiting";
  if (phase === "blocked" || phase === "unverified" || phase === "partial" || phase === "needs_review")
    return "needs_review";
  if (phase === "failed") return "failed";
  if (phase === "stopped" || phase === "expired") return "stopped";
  return status;
}

function questionsOf(wait: WaitRecord | undefined): Pick<WorkerHarnessT, "questions" | "questionsExpireAt"> {
  if (wait?.kind !== "needs_input" || wait.state !== "open") return {};
  const qs = (wait.questions as NeedsInputQuestion[]).slice(0, 3).map((q) => ({
    question: str(q.question, 1000),
    ...(q.options?.length ? { options: q.options.slice(0, 6).map((o) => str(o, 300)) } : {}),
    personOnly: q.personOnly === true,
  }));
  return {
    ...(qs.length ? { questions: qs } : {}),
    ...(wait.expiresAt ? { questionsExpireAt: iso(wait.expiresAt) } : {}),
  };
}

function autoAllowed(store: Store, w: WorkerRecord, events: readonly DispatchEventRecord[]) {
  const all = events.filter((e) => e.kind === "auto_allowed");
  if (!all.length) return undefined;
  const runs = new Set(
    (store.db.prepare("SELECT id FROM runs WHERE worker_id = ?").all(w.id) as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
  const list = all
    .filter((e) => runs.has(str(rec(e.detail).runId, 200)))
    .slice(-AUTO_ALLOWED_SHOWN)
    .map((e) => {
      const x = rec(e.detail);
      return { at: iso(e.at), tool: str(x.tool, 120), summary: str(x.summary, 300) };
    });
  return list.length ? list : undefined;
}

/**
 * 11-05: why this worker's turns have no snapshot, from its latest snapshot
 * line: `not_git` holds for the worker; `snapshot_failed` until a later turn
 * keeps one.
 */
function snapshotSkipped(w: WorkerRecord, events: readonly DispatchEventRecord[]) {
  const mine = (e: DispatchEventRecord) => rec(e.detail).workerId === w.id;
  if (events.some((e) => e.kind === "snapshot.skipped" && mine(e) && rec(e.detail).reason === "not_git"))
    return "not_git" as const;
  const last = events
    .filter((e) => e.kind === "snapshot" || (e.kind === "snapshot.skipped" && mine(e)))
    .at(-1);
  return last?.kind === "snapshot.skipped" ? ("snapshot_failed" as const) : undefined;
}

const CAP_KINDS = ["cap.exhausted", "continued", "cap.expired", "cap.refused", "stopped"] as const;

/** Design §0.2.5: whether this worker ran out of budget, and what became of it. */
export function capView(store: Store, w: WorkerRecord): WorkerHarnessT["cap"] {
  const id = w.grants.dispatchId;
  if (!id) return undefined;
  const events = store.dispatches.eventsOf(id, CAP_KINDS);
  const i = events.findIndex((e) => e.kind === "cap.exhausted" && ofWorker(e, w));
  const out = events[i];
  if (!out) return undefined;
  const after = events.slice(i + 1);
  const st = store.dispatches.caps.state(id);
  const base = { n: Number(rec(out.detail).n) || 1, continues: st.continues, max: MAX_CONTINUES };
  if (after.some((e) => e.kind === "continued")) return { state: "continued", ...base };
  if (st.waiting) return { state: "waiting", ...base, expiresAt: iso(out.at + CAP_EXPIRE_MS) };
  const end = after.at(-1)?.kind;
  if (end === "cap.refused") {
    const why = store.dispatches.caps.refusal(id);
    return { state: "refused", ...base, ...(why ? { refusal: why } : {}) };
  }
  return { state: end === "stopped" ? "stopped" : "expired", ...base };
}

/** The harness part of `w`'s state; undefined for a plain worker or when the store cannot be read. */
export function harnessView(
  store: Store,
  w: WorkerRecord,
  mine: HarnessResult | undefined,
  sandbox?: WorkerHarnessT["sandbox"],
): WorkerHarnessT | undefined {
  const kind = w.grants.harness;
  if (!kind) return undefined;
  try {
    const id = w.grants.dispatchId;
    const d = id ? store.dispatches.get(id) : undefined;
    const events = id
      ? store.dispatches
          .eventsOf(id, VIEW_KINDS)
          .filter((e) => e.kind === "auto_allowed" || e.kind.startsWith("snapshot") || ofWorker(e, w))
      : [];
    const wait = store.dispatches.waitOf(w.id);
    const v = verification(events, mine);
    const gaps = mine?.review && !mine.review.met ? mine.review.gaps.slice(0, 10) : undefined;
    const allowed = autoAllowed(store, w, events);
    const review = reviewOf(events);
    const skipped = kind === "coding" ? snapshotSkipped(w, events) : undefined;
    const cap = capView(store, w);
    return {
      kind,
      phase: cap?.state === "continued" ? "continued" : harnessPhase(w, d, wait, mine, v.running),
      ...(id ? { dispatchId: id } : {}),
      ...(w.grants.doneWhen ? { doneWhen: w.grants.doneWhen.slice(0, 1000) } : {}),
      ...(v.view ? { verification: v.view } : {}),
      budget: {
        steps: w.steps,
        ...(w.budget.maxSteps ? { maxSteps: w.budget.maxSteps } : {}),
        tokens: w.tokens,
        ...(w.budget.maxTokens ? { maxTokens: w.budget.maxTokens } : {}),
        ...(w.cachedTokens ? { cachedTokens: w.cachedTokens } : {}),
        waitedMs: Math.max(0, Math.round(w.waitedMs)),
        ...(w.budget.maxRunMs ? { maxRunMs: w.budget.maxRunMs } : {}),
      },
      ...questionsOf(wait),
      ...(gaps?.length ? { gaps } : {}),
      ...(review ? { review } : {}),
      ...(allowed ? { autoAllowed: allowed } : {}),
      ...(skipped ? { snapshotSkipped: skipped } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(cap ? { cap } : {}),
    };
  } catch {
    return undefined;
  }
}
