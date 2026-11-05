import type { AlcaEvent } from "./events.ts";

export type SequenceViolationCode =
  | "first_not_run_started"
  | "seq_gap"
  | "seq_not_increasing"
  | "thread_mismatch"
  | "ts_regressed"
  | "after_finish"
  | "tool_completed_without_request"
  | "tool_completed_twice"
  | "approval_resolved_without_request"
  | "approval_resolved_twice"
  | "question_answered_without_ask"
  | "question_answered_twice"
  | "delta_after_completed";

export interface SequenceViolation {
  runId: string;
  seq: number;
  code: SequenceViolationCode;
  message: string;
}

type Pending = "open" | "closed";

/**
 * Incremental checker for one run's event stream.
 * Invariants: starts with run.started at seq 0, seq increments by exactly 1,
 * timestamps never go backwards, nothing follows run.finished, and every
 * *.completed / *.resolved / *.answered refers to an earlier open request.
 */
export class RunSequenceTracker {
  readonly runId: string;
  private nextSeq = 0;
  private threadId: string | undefined;
  private lastTs = Number.NEGATIVE_INFINITY;
  private finished = false;
  private readonly calls = new Map<string, Pending>();
  private readonly approvals = new Map<string, Pending>();
  private readonly questions = new Map<string, Pending>();
  private readonly completedMessages = new Set<string>();

  constructor(runId: string) {
    this.runId = runId;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get expectedSeq(): number {
    return this.nextSeq;
  }

  accept(e: AlcaEvent): SequenceViolation[] {
    const out: SequenceViolation[] = [];
    const v = (code: SequenceViolationCode, message: string) =>
      out.push({ runId: this.runId, seq: e.seq, code, message });

    if (this.nextSeq === 0 && e.type !== "run.started") {
      v("first_not_run_started", `first event is ${e.type}`);
    }
    if (e.seq > this.nextSeq) v("seq_gap", `expected seq ${this.nextSeq}, got ${e.seq}`);
    if (e.seq < this.nextSeq) v("seq_not_increasing", `seq ${e.seq} already seen`);
    this.nextSeq = Math.max(this.nextSeq, e.seq + 1);

    if (this.threadId === undefined) this.threadId = e.threadId;
    else if (e.threadId !== this.threadId) {
      v("thread_mismatch", `run belongs to ${this.threadId}, event says ${e.threadId}`);
    }
    const ts = Date.parse(e.ts);
    if (ts < this.lastTs) v("ts_regressed", `ts ${e.ts} is earlier than the previous event`);
    this.lastTs = Math.max(this.lastTs, ts);

    if (this.finished) v("after_finish", `${e.type} after run.finished`);
    this.track(e, v);
    return out;
  }

  private track(e: AlcaEvent, v: (code: SequenceViolationCode, message: string) => void): void {
    switch (e.type) {
      case "run.finished":
        this.finished = true;
        return;
      case "tool.requested":
        this.calls.set(e.data.callId, "open");
        return;
      case "tool.completed":
        closeOnce(this.calls, e.data.callId, v, "tool_completed", "tool call");
        return;
      case "approval.requested":
        this.approvals.set(e.data.approvalId, "open");
        return;
      case "approval.resolved":
        closeOnce(this.approvals, e.data.approvalId, v, "approval_resolved", "approval");
        return;
      case "question.asked":
        this.questions.set(e.data.questionId, "open");
        return;
      case "question.answered":
        closeOnce(this.questions, e.data.questionId, v, "question_answered", "question");
        return;
      case "message.completed":
        this.completedMessages.add(e.data.messageId);
        return;
      case "message.delta":
        if (this.completedMessages.has(e.data.messageId)) {
          v("delta_after_completed", `delta for completed message ${e.data.messageId}`);
        }
        return;
      default:
        return;
    }
  }
}

function closeOnce(
  map: Map<string, Pending>,
  key: string,
  v: (code: SequenceViolationCode, message: string) => void,
  prefix: "tool_completed" | "approval_resolved" | "question_answered",
  label: string,
): void {
  const state = map.get(key);
  if (state === undefined) {
    const code =
      prefix === "question_answered" ? "question_answered_without_ask" : `${prefix}_without_request`;
    v(code as SequenceViolationCode, `${label} ${key} was never requested`);
  } else if (state === "closed") {
    v(`${prefix}_twice` as SequenceViolationCode, `${label} ${key} closed twice`);
  }
  map.set(key, "closed");
}

export interface SequenceReport {
  ok: boolean;
  violations: SequenceViolation[];
  /** runIds that have not emitted run.finished yet. */
  openRuns: string[];
}

/** Check a (possibly interleaved) list of events, grouped per run, in arrival order. */
export function checkSequence(events: readonly AlcaEvent[]): SequenceReport {
  const trackers = new Map<string, RunSequenceTracker>();
  const violations: SequenceViolation[] = [];
  for (const e of events) {
    let t = trackers.get(e.runId);
    if (!t) {
      t = new RunSequenceTracker(e.runId);
      trackers.set(e.runId, t);
    }
    violations.push(...t.accept(e));
  }
  const openRuns = [...trackers.values()].filter((t) => !t.isFinished).map((t) => t.runId);
  return { ok: violations.length === 0, violations, openRuns };
}

/** Sort a batch received out of order (e.g. after a relay reconnect) by run, then seq. */
export function orderBySeq(events: readonly AlcaEvent[]): AlcaEvent[] {
  return [...events].sort((a, b) => (a.runId === b.runId ? a.seq - b.seq : a.runId < b.runId ? -1 : 1));
}
