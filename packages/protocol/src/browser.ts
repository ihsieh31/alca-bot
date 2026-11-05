import { z } from "zod";
import { ActionClass, Actor, PROTOCOL_VERSION } from "./events.ts";
import { BotId, EventId, newId, SpaceId, TabId, ThreadId, WorkerId } from "./ids.ts";

/**
 * Alca Browser channel: host-scoped events about Spaces (not tied to a run).
 * A Space lives longer than any one run, and a person can take it over while
 * no run is active, so these events have their own envelope and sequence.
 * When a control change happens during a run that uses the Space, the host
 * also emits a run-scoped `handoff.requested` on the main protocol.
 */

export const SpaceProfile = z.enum(["shared", "isolated"]);
export const SpaceController = z.enum(["agent", "user"]);
export const SpaceStatus = z.enum(["idle", "working", "queued", "waiting_user"]);

export const BrowserTab = z.strictObject({
  tabId: TabId,
  title: z.string(),
  url: z.string(),
  loading: z.boolean(),
});

export const BrowserActionKind = z.enum([
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "select",
  "press",
  "scroll",
  "wait",
  "read",
  "screenshot",
  "script",
  "close_tab",
]);

export const SpaceState = z.strictObject({
  spaceId: SpaceId,
  /** The bot that owns this Space. Only it may drive the Space; ownership never changes. */
  botId: BotId,
  title: z.string().min(1),
  threadId: ThreadId.optional(),
  /** The worker session using this Space (P3: each worker task has its own Space). */
  workerId: WorkerId.optional(),
  /** shared: same profile (and logins) as the user's own browsing; isolated: own cookie jar. */
  profile: SpaceProfile,
  /** Isolated Spaces only: the profile directory survives a restart. */
  persistent: z.boolean(),
  controller: SpaceController,
  status: SpaceStatus,
  tabs: z.array(BrowserTab),
  activeTabId: TabId.optional(),
  lastAction: z
    .strictObject({ kind: BrowserActionKind, label: z.string(), ok: z.boolean(), at: z.iso.datetime() })
    .optional(),
  /** Why control went to the user (takeover, captcha, permission prompt). */
  handoffReason: z.string().optional(),
});

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  id: EventId,
  ts: z.iso.datetime({ offset: true }),
  /** Per host channel, starts at 0, +1 per event. Frames are not sequenced. */
  seq: z.number().int().nonnegative(),
};

function event<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({ ...envelope, type: z.literal(type), data });
}

export const SpaceUpdated = event("space.updated", z.strictObject({ space: SpaceState }));
export const SpaceClosed = event("space.closed", z.strictObject({ spaceId: SpaceId, botId: BotId }));
export const SpaceControlChanged = event(
  "space.control",
  z.strictObject({
    spaceId: SpaceId,
    botId: BotId,
    controller: SpaceController,
    by: Actor,
    reason: z.string().min(1),
  }),
);
export const SpaceAction = event(
  "space.action",
  z.strictObject({
    spaceId: SpaceId,
    botId: BotId,
    tabId: TabId.optional(),
    kind: BrowserActionKind,
    label: z.string(),
    ok: z.boolean(),
    /** Set when the sensitive-action gate classified the step. */
    gated: ActionClass.optional(),
    error: z.string().optional(),
  }),
);

/** First-run Chromium download (Chrome for Testing) progress. */
export const BrowserInstall = event(
  "browser.install",
  z.strictObject({
    phase: z.enum(["idle", "checking", "downloading", "verifying", "extracting", "ready", "failed"]),
    version: z.string().optional(),
    platform: z.string().optional(),
    received: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    entries: z.number().int().nonnegative().optional(),
    entriesTotal: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  }),
);

export const BrowserEventSchema = z.discriminatedUnion("type", [
  SpaceUpdated,
  SpaceClosed,
  SpaceControlChanged,
  SpaceAction,
  BrowserInstall,
]);

/** Screencast frame. Sent on the same channel but never stored or sequenced. */
export const SpaceFrame = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("space.frame"),
  spaceId: SpaceId,
  botId: BotId,
  tabId: TabId,
  mime: z.enum(["image/jpeg", "image/png"]),
  /** base64 */
  data: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type SpaceStateT = z.infer<typeof SpaceState>;
export type BrowserTabT = z.infer<typeof BrowserTab>;
export type BrowserActionKindT = z.infer<typeof BrowserActionKind>;
export type BrowserEvent = z.infer<typeof BrowserEventSchema>;
export type BrowserEventType = BrowserEvent["type"];
export type BrowserEventData<T extends BrowserEventType> = Extract<BrowserEvent, { type: T }>["data"];
export type SpaceFrameT = z.infer<typeof SpaceFrame>;

/** Validated, sequenced producer for the browser channel. */
export class BrowserChannelEmitter {
  private seq = 0;
  private lastMs = 0;
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }
  emit<T extends BrowserEventType>(type: T, data: BrowserEventData<T>): Extract<BrowserEvent, { type: T }> {
    const ms = Math.max(this.now().getTime(), this.lastMs);
    this.lastMs = ms;
    const e = BrowserEventSchema.parse({
      v: PROTOCOL_VERSION,
      id: newId("event", ms),
      ts: new Date(ms).toISOString(),
      seq: this.seq,
      type,
      data,
    });
    this.seq += 1;
    return e as Extract<BrowserEvent, { type: T }>;
  }
}
