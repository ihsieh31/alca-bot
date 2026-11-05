import { z } from "zod";
import { ActionClass, PROTOCOL_VERSION } from "./events.ts";
import { BotId, EventId, MemoryId, newId, SkillId, ThreadId, WorkerId } from "./ids.ts";

/**
 * Learning channel (P5): host-scoped events about a bot's memory and skills.
 * Like the agents channel it has its own envelope and per-channel sequence.
 * Memory events never carry the remembered text (surfaces fetch it over the
 * loopback API or a scoped Link op); skill events carry the skill's name,
 * triggers and what its steps touch, so an approval sheet can be drawn.
 */

export const MemoryKind = z.enum(["fact", "preference", "person", "project"]);
/** `user`: the person said it outright (記住…) or confirmed / edited it; `inferred`: Alca guessed it from a turn. */
export const MemoryOrigin = z.enum(["user", "inferred"]);
/** `shared`: the user model every bot of the team reads; `bot`: this bot's own working notes. */
export const MemoryScope = z.enum(["shared", "bot"]);

export const SkillStatus = z.enum(["proposed", "active", "disabled", "rejected"]);

export const SkillSummary = z.strictObject({
  skillId: SkillId,
  botId: BotId,
  name: z.string().min(1),
  status: SkillStatus,
  /** Current approved version (0 while only proposed). */
  version: z.number().int().nonnegative(),
  /** A proposed version waiting for the person (a new skill, or a revision after a correction). */
  pendingVersion: z.number().int().positive().optional(),
  triggers: z.array(z.string()),
  stepCount: z.number().int().nonnegative(),
  /** Action classes its steps used; anything always-confirm is still asked at run time. */
  actionClasses: z.array(ActionClass),
  sourceThreadId: ThreadId.optional(),
  sourceWorkerId: WorkerId.optional(),
  uses: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }),
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

export const MemoryChanged = event(
  "memory.changed",
  z.strictObject({
    botId: BotId,
    memoryId: MemoryId,
    op: z.enum(["added", "superseded", "confirmed", "rescoped", "forgotten"]),
    kind: MemoryKind,
    origin: MemoryOrigin,
    scope: MemoryScope,
    /** For `superseded`: the item the new one replaced. */
    replaces: MemoryId.optional(),
    threadId: ThreadId.optional(),
  }),
);

export const SkillProposed = event("skill.proposed", z.strictObject({ skill: SkillSummary }));

export const SkillUpdated = event(
  "skill.updated",
  z.strictObject({
    skill: SkillSummary,
    op: z.enum(["approved", "rejected", "edited", "disabled", "enabled", "deleted", "used", "revision"]),
  }),
);

export const LearningEventSchema = z.discriminatedUnion("type", [MemoryChanged, SkillProposed, SkillUpdated]);

export type MemoryKindT = z.infer<typeof MemoryKind>;
export type MemoryOriginT = z.infer<typeof MemoryOrigin>;
export type MemoryScopeT = z.infer<typeof MemoryScope>;
export type SkillStatusT = z.infer<typeof SkillStatus>;
export type SkillSummaryT = z.infer<typeof SkillSummary>;
export type LearningEvent = z.infer<typeof LearningEventSchema>;
export type LearningEventType = LearningEvent["type"];
export type LearningEventData<T extends LearningEventType> = Extract<LearningEvent, { type: T }>["data"];

/** Validated, sequenced producer for the learning channel. */
export class LearningChannelEmitter {
  private seq = 0;
  private lastMs = 0;
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }
  emit<T extends LearningEventType>(
    type: T,
    data: LearningEventData<T>,
  ): Extract<LearningEvent, { type: T }> {
    const ms = Math.max(this.now().getTime(), this.lastMs);
    this.lastMs = ms;
    const e = LearningEventSchema.parse({
      v: PROTOCOL_VERSION,
      id: newId("event", ms),
      ts: new Date(ms).toISOString(),
      seq: this.seq,
      type,
      data,
    });
    this.seq += 1;
    return e as Extract<LearningEvent, { type: T }>;
  }
}
