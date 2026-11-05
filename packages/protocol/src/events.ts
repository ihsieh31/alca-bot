import { z } from "zod";
import {
  ApprovalId,
  BotId,
  CallId,
  EventId,
  HandoffId,
  MessageId,
  QuestionId,
  RunId,
  SessionId,
  ThreadId,
  WorkerId,
} from "./ids.ts";

export const PROTOCOL_VERSION = 0 as const;

/** Who caused the run. This is the authority the policy layer checks. */
export const Initiator = z.strictObject({
  kind: z.enum(["user", "schedule", "agent", "webhook"]),
  id: z.string().min(1),
});

/** Who emitted this particular event. May differ from the initiator. */
export const Actor = z.strictObject({
  kind: z.enum(["user", "agent", "tool", "system"]),
  id: z.string().min(1),
});

/** Action classes that the host always confirms, regardless of permission level. */
export const ActionClass = z.enum([
  "read",
  "write",
  "execute",
  "network",
  "payment",
  "send",
  "delete",
  "publish",
]);

export const FinishReason = z.enum([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
  "max_turns",
  "awaiting_input",
  "handed_off",
]);

const Usage = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
});

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  id: EventId,
  ts: z.iso.datetime({ offset: true }),
  sessionId: SessionId.optional(),
  threadId: ThreadId,
  runId: RunId,
  seq: z.number().int().nonnegative(),
  initiator: Initiator,
  actor: Actor,
};

function event<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({ ...envelope, type: z.literal(type), data });
}

export const RunStarted = event(
  "run.started",
  z.strictObject({
    engine: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    parentRunId: RunId.optional(),
  }),
);

export const MessageDelta = event(
  "message.delta",
  z.strictObject({
    messageId: MessageId,
    role: z.literal("assistant"),
    delta: z.string(),
  }),
);

export const MessageCompleted = event(
  "message.completed",
  z.strictObject({
    messageId: MessageId,
    role: z.enum(["user", "assistant", "system"]),
    text: z.string(),
  }),
);

export const ToolRequested = event(
  "tool.requested",
  z.strictObject({
    callId: CallId,
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    actionClass: ActionClass,
  }),
);

export const ToolCompleted = event(
  "tool.completed",
  z.strictObject({
    callId: CallId,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    durationMs: z.number().int().nonnegative(),
  }),
);

export const ApprovalRequested = event(
  "approval.requested",
  z.strictObject({
    approvalId: ApprovalId,
    callId: CallId.optional(),
    /** Bot whose action needs the yes (multi-bot teams). */
    botId: BotId.optional(),
    /** Worker session whose tool call this is (router/worker split, P3). */
    workerId: WorkerId.optional(),
    actionClass: ActionClass,
    summary: z.string().min(1),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    /** P14: the person's standing instructions for this kind of action that were put in front of the worker. */
    applied: z.array(z.string().min(1).max(200)).max(5).optional(),
  }),
);

export const ApprovalResolved = event(
  "approval.resolved",
  z.strictObject({
    approvalId: ApprovalId,
    decision: z.enum(["approved", "denied", "expired"]),
    by: Actor,
  }),
);

export const QuestionAsked = event(
  "question.asked",
  z.strictObject({
    questionId: QuestionId,
    prompt: z.string().min(1),
    choices: z.array(z.string().min(1)).optional(),
  }),
);

export const QuestionAnswered = event(
  "question.answered",
  z.strictObject({
    questionId: QuestionId,
    answer: z.string(),
  }),
);

export const HandoffRequested = event(
  "handoff.requested",
  z.strictObject({
    handoffId: HandoffId,
    to: z.enum(["user", "agent"]),
    targetId: z.string().min(1).optional(),
    surface: z.enum(["chat", "browser"]),
    reason: z.string().min(1),
  }),
);

export const RunFinished = event(
  "run.finished",
  z.strictObject({
    reason: FinishReason,
    usage: Usage.optional(),
  }),
);

export const ErrorEvent = event(
  "error",
  z.strictObject({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
  }),
);

/** The single source of truth: every event the protocol knows. */
export const AlcaEventSchema = z.discriminatedUnion("type", [
  RunStarted,
  MessageDelta,
  MessageCompleted,
  ToolRequested,
  ToolCompleted,
  ApprovalRequested,
  ApprovalResolved,
  QuestionAsked,
  QuestionAnswered,
  HandoffRequested,
  RunFinished,
  ErrorEvent,
]);

export type AlcaEvent = z.infer<typeof AlcaEventSchema>;
export type EventType = AlcaEvent["type"];
export type EventOf<T extends EventType> = Extract<AlcaEvent, { type: T }>;
export type EventData<T extends EventType> = EventOf<T>["data"];
export type InitiatorT = z.infer<typeof Initiator>;
export type ActorT = z.infer<typeof Actor>;
export type ActionClassT = z.infer<typeof ActionClass>;
export type FinishReasonT = z.infer<typeof FinishReason>;

export const EVENT_TYPES: readonly EventType[] = AlcaEventSchema.options.map((o) => o.shape.type.value);
