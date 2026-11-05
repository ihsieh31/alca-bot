import { z } from "zod";
import { PROTOCOL_VERSION } from "./events.ts";
import {
  AccountId,
  BotId,
  DraftId,
  EventId,
  MessageId,
  newId,
  OfferId,
  PeerRequestId,
  RoutineId,
  RoutineRunId,
  RunId,
  SpillId,
  StreamId,
  ThreadId,
  TriggerEventId,
  TriggerId,
  WorkerId,
} from "./ids.ts";

/**
 * Agents channel (P3): host-scoped events about a bot's workers, triggers and
 * watchdog. Workers outlive the router run that started them, and triggers
 * fire with no run at all, so like the browser channel these events have
 * their own envelope and per-channel sequence. A worker's own run (its
 * text, tool calls and cards) stays on the main protocol under its own
 * `runId`; this channel only says which workers exist and how they are doing.
 */

export const WorkerStatus = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "stopped",
  "needs_review",
]);

export const WorkerResult = z.strictObject({
  /** inline: the whole result went into the router's context; spill: a summary + a handle to recall. */
  mode: z.enum(["inline", "spill"]),
  summary: z.string(),
  chars: z.number().int().nonnegative(),
  spillId: SpillId.optional(),
});

/**
 * Phase 6: what the worker panels show of a harness worker. Every field is
 * read from the store (the worker row, its dispatch, its open wait and the
 * dispatch's append-only events); a worker without a harness has none.
 */
export const HarnessPhase = z.enum([
  "queued",
  "running",
  "verifying",
  "waiting_input",
  "waiting_event",
  /** Its question was answered (or its event came): a continuation worker carries on. */
  "continued",
  "done",
  "partial",
  "unverified",
  "needs_review",
  "blocked",
  "failed",
  "stopped",
  "expired",
]);

export const HarnessCheck = z.strictObject({
  command: z.string(),
  /** null: stopped or timed out (never counted as green). */
  exitCode: z.number().int().nullable(),
  ok: z.boolean(),
  /** The end of its output, cut short. */
  summary: z.string(),
});

export const HarnessQuestion = z.strictObject({
  question: z.string(),
  /** options[0] is the worker's recommended answer. */
  options: z.array(z.string()).optional(),
  /** Only the person can answer (sign-in, payment, a secret, their own account). */
  personOnly: z.boolean(),
});

export const WorkerHarness = z.strictObject({
  kind: z.enum(["coding", "general"]),
  phase: HarnessPhase,
  dispatchId: z.string().optional(),
  doneWhen: z.string().optional(),
  /** Host verification (coding): the last round's checks, red or green. */
  verification: z
    .strictObject({
      state: z.enum(["running", "passed", "failed", "none"]),
      round: z.number().int().nonnegative(),
      checks: z.array(HarnessCheck),
      /** The failing part as the worker was shown it (cut short). */
      feedback: z.string().optional(),
    })
    .optional(),
  budget: z.strictObject({
    steps: z.number().int().nonnegative(),
    maxSteps: z.number().int().positive().optional(),
    /** Tokens counted against maxTokens: new tokens, plus prompt-cache reads at a tenth (mac B3). */
    tokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive().optional(),
    /** Prompt-cache reads, shown beside the count (a tenth of them is in `tokens`). */
    cachedTokens: z.number().int().nonnegative().optional(),
    /** Time spent waiting for a person, not counted against maxRunMs. */
    waitedMs: z.number().int().nonnegative(),
    maxRunMs: z.number().int().positive().optional(),
  }),
  /** An open NEEDS_INPUT (1–3 questions) the person can answer from the panel. */
  questions: z.array(HarnessQuestion).max(3).optional(),
  /** When text questions stop taking answers (questions with options never expire). */
  questionsExpireAt: z.iso.datetime({ offset: true }).optional(),
  /** The independent reviewer's gaps when it found the task not met. */
  gaps: z.array(z.string()).optional(),
  /**
   * Mac test 2026-11 B4: the independent reviewer's last outcome (absent when
   * the bot's reviewer is off, or no review was due yet): met, not met with
   * gaps, or skipped with a reason (engine_not_read_only, no_verdict, no_report).
   */
  review: z
    .strictObject({
      state: z.enum(["met", "gaps", "skipped"]),
      round: z.number().int().nonnegative(),
      gaps: z.array(z.string()).optional(),
      reason: z.string().optional(),
    })
    .optional(),
  /** Calls that ran only because the bot is at 完全授權 (newest last, at most 20). */
  autoAllowed: z
    .array(
      z.strictObject({
        at: z.iso.datetime({ offset: true }),
        tool: z.string(),
        summary: z.string(),
      }),
    )
    .optional(),
  /**
   * Design §0.2.5 (S10): this worker's step budget ran out with the task not
   * done. `waiting` = the person or the router may 續做 it (until `expiresAt`);
   * `continued` = a new worker carries on; otherwise it ended (and why).
   */
  cap: z
    .strictObject({
      state: z.enum(["waiting", "continued", "refused", "expired", "stopped"]),
      /** Which run-out this is (1 = the first execution). */
      n: z.number().int().positive(),
      continues: z.number().int().nonnegative(),
      max: z.number().int().positive(),
      refusal: z.string().optional(),
      expiresAt: z.iso.datetime({ offset: true }).optional(),
    })
    .optional(),
  /**
   * 11-05: a coding worker at 完全授權 whose turns have no snapshot to go back
   * to: the folder is not git (`not_git`), or the latest turn's snapshot
   * failed (`snapshot_failed`).
   */
  snapshotSkipped: z.enum(["not_git", "snapshot_failed"]).optional(),
  /**
   * Next round §5.4: the OS sandbox the worker's commands run in — Seatbelt,
   * bubblewrap, off (the bot's setting at this level), or unavailable (it
   * should be on and this computer has none: the panel warns). Omitted by
   * older cores.
   */
  sandbox: z.enum(["seatbelt", "bwrap", "off", "unavailable"]).optional(),
});

export const WorkerState = z.strictObject({
  workerId: WorkerId,
  botId: BotId,
  threadId: ThreadId,
  title: z.string().min(1),
  status: WorkerStatus,
  /** Prepared ahead of a request; outbound steps are still always confirmed. */
  speculative: z.boolean(),
  /** The worker's current (or last) run on the main protocol. */
  runId: RunId.optional(),
  /** The router run that dispatched it. */
  parentRunId: RunId.optional(),
  steps: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  finishedAt: z.iso.datetime({ offset: true }).optional(),
  lastActivityAt: z.iso.datetime({ offset: true }).optional(),
  /** Why it stopped (user, router, watchdog.<kind>, restart). */
  stopReason: z.string().optional(),
  result: WorkerResult.optional(),
  subscriptions: z.array(StreamId),
  /** Phase 6: the harness part (absent for a plain worker, and from older cores). */
  harness: WorkerHarness.optional(),
});

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  id: EventId,
  ts: z.iso.datetime({ offset: true }),
  /** Per host channel, starts at 0, +1 per event. */
  seq: z.number().int().nonnegative(),
};

function event<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({ ...envelope, type: z.literal(type), data });
}

export const WorkerUpdated = event("worker.updated", z.strictObject({ worker: WorkerState }));

export const TriggerFired = event(
  "trigger.fired",
  z.strictObject({
    triggerId: TriggerId,
    eventId: TriggerEventId,
    botId: BotId,
    source: z.string().min(1),
    streamId: StreamId.optional(),
    /** Stage 1 (code rules): dropped, passed to stage 2, or an explicit request (no stage 2). */
    rule: z.enum(["drop", "candidate", "explicit"]),
    /** Stage 2 (model judgment), when it ran. */
    judged: z.enum(["wake", "skip"]).optional(),
    outcome: z.enum(["dropped", "router", "workers"]),
  }),
);

export const WatchdogFlagged = event(
  "watchdog.flagged",
  z.strictObject({
    workerId: WorkerId,
    botId: BotId,
    kind: z.enum(["stuck", "looping", "over_budget"]),
    detail: z.string(),
    action: z.literal("stopped"),
  }),
);

/** P6: a routine looked (checks before the model) — what it found and whether an AI run started. */
export const RoutineChecked = event(
  "routine.checked",
  z.strictObject({
    routineId: RoutineId,
    runId: RoutineRunId,
    botId: BotId,
    threadId: ThreadId,
    /** quiet: nothing new (0 tokens); new: an AI run started; read_failed: could not read (cursor kept, backing off). */
    outcome: z.enum(["quiet", "new", "read_failed", "capped", "ai_done", "ai_invalid", "ai_failed"]),
    items: z.number().int().nonnegative(),
    workerId: WorkerId.optional(),
    /** Why a read failed, in words (never the provider's key). */
    error: z.string().optional(),
    nextAt: z.iso.datetime({ offset: true }).optional(),
  }),
);

/** P6: connected accounts changed (connected, active, removed, grants) — ids only. */
export const ConnectorChanged = event(
  "connector.changed",
  z.strictObject({
    accountId: AccountId.optional(),
    op: z.enum(["key", "connecting", "active", "failed", "removed", "renamed", "grants", "trigger"]),
  }),
);

/** P6: a worker prepared something ahead (提前做); sending it is a new, confirmed request. */
export const DraftReady = event(
  "draft.ready",
  z.strictObject({
    draftId: DraftId,
    botId: BotId,
    threadId: ThreadId,
    title: z.string(),
    kind: z.enum(["reply", "message", "note"]),
  }),
);

/**
 * P7: a bot asked a teammate (peer_ask) or handed it work (peer_delegate).
 * Ids, bots, status and a short title only — the conversation itself stays
 * in the peer thread on the main protocol.
 */
export const PeerUpdated = event(
  "peer.updated",
  z.strictObject({
    requestId: PeerRequestId,
    kind: z.enum(["ask", "delegate"]),
    fromBotId: BotId,
    toBotId: BotId,
    /** The person's conversation the chain started from (cards from the peer show there). */
    rootThreadId: ThreadId,
    fromThreadId: ThreadId,
    peerThreadId: ThreadId.optional(),
    depth: z.number().int().min(1),
    status: z.enum(["running", "done", "failed", "denied", "refused", "stopped"]),
    title: z.string(),
    reason: z.string().optional(),
  }),
);

/** P7: the team changed (a bot was added, edited, archived; the lead or the team rules changed). */
export const TeamChanged = event(
  "team.changed",
  z.strictObject({
    botId: BotId.optional(),
    op: z.enum(["created", "updated", "archived", "restored", "lead", "rules", "providers"]),
  }),
);

/** P14: an add-on reached its daily cap for a bot and stops until the next local day. */
export const AddonCapped = event(
  "addon.capped",
  z.strictObject({
    botId: BotId,
    addonId: z.string().min(1).max(40),
    /** Local day (YYYY-MM-DD) the cap is for. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.enum(["tokens", "runs"]),
  }),
);

const OfferCategory = z.enum(["project", "errand", "money_account", "social", "study", "other"]);
const OfferStatus = z.enum(["pending", "accepted", "declined", "ignored", "expired"]);

/** P14: an offer was recorded (end of a reply) or shown (an add-on's card). Text is what the person sees. */
export const OfferCreated = event(
  "offer.created",
  z.strictObject({
    offerId: OfferId,
    botId: BotId,
    threadId: ThreadId.optional(),
    source: z.string().min(1).max(60),
    category: OfferCategory,
    text: z.string(),
    dueAt: z.iso.datetime({ offset: true }).optional(),
  }),
);

/** P14: what the person did with an offer (or that it was ignored / expired). */
export const OfferUpdated = event(
  "offer.updated",
  z.strictObject({
    offerId: OfferId,
    botId: BotId,
    threadId: ThreadId.optional(),
    status: OfferStatus,
    workerId: WorkerId.optional(),
  }),
);

/** P14: 回覆檢查 rewrote a router reply once; surfaces replace the text and mark it 已修改. */
export const ReplyRevised = event(
  "reply.revised",
  z.strictObject({
    botId: BotId,
    threadId: ThreadId,
    messageId: MessageId,
    text: z.string().min(1),
    issues: z.array(z.string().min(1).max(80)).max(6),
  }),
);

/**
 * Next round §3: the hourly audit check failed (a broken hash chain, or the
 * log ends before the outside anchor). Sent once per distinct failure; the
 * details are in 設定 → 資料 (`alca db verify`), never in the event.
 */
export const SystemAlert = event(
  "system.alert",
  z.strictObject({
    kind: z.literal("audit_broken"),
    /** First row that does not verify (absent when only the anchor disagrees). */
    id: z.number().int().nonnegative().optional(),
    reason: z.enum(["prev_hash", "hash", "detail_json", "id_gap", "behind"]),
    at: z.iso.datetime({ offset: true }),
  }),
);

/**
 * Design §0.2.3: one row of a dispatch's ledger (`dispatch_events`, the only
 * source), sent once it is committed. `seq` is the ledger's own (strictly
 * increasing, shared by all dispatches); resume with
 * `GET /api/dispatches/:id/events?after=<seq>` (410 when the cursor was
 * pruned). `detail` carries only whitelisted short fields, never tool output.
 */
export const DispatchEvent = event(
  "dispatch.event",
  z.strictObject({
    dispatchId: z.string().min(1).max(64),
    seq: z.number().int().positive(),
    kind: z.string().min(1).max(40),
    at: z.iso.datetime({ offset: true }),
    runId: z.string().max(64).optional(),
    turnId: z.string().max(64).optional(),
    waitId: z.string().max(64).optional(),
    workerId: z.string().max(64).optional(),
    detail: z
      .record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
      .optional(),
  }),
);

export const AgentsEventSchema = z.discriminatedUnion("type", [
  WorkerUpdated,
  TriggerFired,
  WatchdogFlagged,
  RoutineChecked,
  ConnectorChanged,
  DraftReady,
  PeerUpdated,
  TeamChanged,
  AddonCapped,
  OfferCreated,
  OfferUpdated,
  ReplyRevised,
  SystemAlert,
  DispatchEvent,
]);

export type WorkerStatusT = z.infer<typeof WorkerStatus>;
export type WorkerStateT = z.infer<typeof WorkerState>;
export type WorkerHarnessT = z.infer<typeof WorkerHarness>;
export type HarnessPhaseT = z.infer<typeof HarnessPhase>;
export type AgentsEvent = z.infer<typeof AgentsEventSchema>;
export type AgentsEventType = AgentsEvent["type"];
export type AgentsEventData<T extends AgentsEventType> = Extract<AgentsEvent, { type: T }>["data"];

/** Validated, sequenced producer for the agents channel. */
export class AgentsChannelEmitter {
  private seq = 0;
  private lastMs = 0;
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }
  emit<T extends AgentsEventType>(type: T, data: AgentsEventData<T>): Extract<AgentsEvent, { type: T }> {
    const ms = Math.max(this.now().getTime(), this.lastMs);
    this.lastMs = ms;
    const e = AgentsEventSchema.parse({
      v: PROTOCOL_VERSION,
      id: newId("event", ms),
      ts: new Date(ms).toISOString(),
      seq: this.seq,
      type,
      data,
    });
    this.seq += 1;
    return e as Extract<AgentsEvent, { type: T }>;
  }
}
