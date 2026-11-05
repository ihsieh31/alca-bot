export type JobKind = "turn" | "tool" | "subagent" | "schedule" | "watch" | "browser_task";
export type JobStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  parentId: string | null;
  threadId: string | null;
  runId: string | null;
  kind: JobKind;
  status: JobStatus;
  title: string | null;
  attempt: number;
  /** Set once anything left the machine (mail, post, payment, HTTP write). Sticky. */
  outboundObserved: boolean;
  /** Recovery found outbound activity: a person must look before anything re-runs. */
  needsReview: boolean;
  leaseOwner: string | null;
  leaseUntil: string | null;
  input: Record<string, unknown>;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Owning bot (a single-agent user is a team of one). */
  botId: string | null;
}

export interface JobEvent {
  jobId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export const TERMINAL: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "cancelled"]);

const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Job event types that prove something left the machine. Once one of these is
 * in a job's log, the job is never re-run automatically.
 */
export const OUTBOUND_EVENT_TYPES = Object.freeze([
  "outbound.sent",
  "outbound.paid",
  "outbound.posted",
] as const);
export type OutboundEventType = (typeof OUTBOUND_EVENT_TYPES)[number];

export function isOutboundEvent(type: string): type is OutboundEventType {
  return (OUTBOUND_EVENT_TYPES as readonly string[]).includes(type);
}

/** Map an action class to the outbound event it produces, if any. */
export function outboundEventFor(actionClass: string): OutboundEventType | undefined {
  switch (actionClass) {
    case "send":
      return "outbound.sent";
    case "payment":
      return "outbound.paid";
    case "publish":
      return "outbound.posted";
    default:
      return undefined;
  }
}

/** Schedules are at-most-once: a job that has sent anything out is never auto-retried. */
export function canAutoRetry(
  job: Pick<Job, "status" | "outboundObserved" | "attempt">,
  maxAttempts = 3,
): boolean {
  return job.status === "failed" && !job.outboundObserved && job.attempt < maxAttempts;
}
