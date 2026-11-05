import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Identifier prefixes used across the Alca Event Protocol.
 * Format: `<prefix>_<10 char time><16 char random>` in Crockford base32,
 * so ids sort roughly by creation time and are safe in URLs and file names.
 */
export const ID_PREFIXES = {
  event: "evt",
  session: "ses",
  thread: "thr",
  run: "run",
  message: "msg",
  call: "call",
  approval: "apr",
  question: "qst",
  handoff: "hof",
  space: "spc",
  bot: "bot",
  tab: "tab",
  // P3 super-agent core
  worker: "wkr",
  spill: "spl",
  trigger: "trg",
  triggerEvent: "tev",
  stream: "str",
  // P5 memory + learning
  memory: "mem",
  skill: "skl",
  // P6 connectors + routines
  account: "acc",
  routine: "rtn",
  routineRun: "rrn",
  draft: "drf",
  // P7 team
  peer: "peer",
  peerEvent: "pev",
  provider: "eng",
  // P14 offers
  offer: "ofr",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";

function encodeTime(ms: number): string {
  let out = "";
  let rest = Math.floor(ms);
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += CROCKFORD.charAt(b % 32);
  return out;
}

export function newId(kind: IdKind, now: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${encodeTime(now)}${encodeRandom(16)}`;
}

export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_${ID_BODY}$`);
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && idPattern(kind).test(value);
}

/** Zod schema for one id kind. */
export function idSchema(kind: IdKind) {
  return z.string().regex(idPattern(kind), { message: `expected a ${ID_PREFIXES[kind]}_ id` });
}

export const EventId = idSchema("event");
export const SessionId = idSchema("session");
export const ThreadId = idSchema("thread");
export const RunId = idSchema("run");
export const MessageId = idSchema("message");
export const CallId = idSchema("call");
export const ApprovalId = idSchema("approval");
export const QuestionId = idSchema("question");
export const HandoffId = idSchema("handoff");
export const SpaceId = idSchema("space");
export const BotId = idSchema("bot");
export const TabId = idSchema("tab");
export const WorkerId = idSchema("worker");
export const SpillId = idSchema("spill");
export const TriggerId = idSchema("trigger");
export const TriggerEventId = idSchema("triggerEvent");
export const StreamId = idSchema("stream");
export const MemoryId = idSchema("memory");
export const SkillId = idSchema("skill");
export const AccountId = idSchema("account");
export const RoutineId = idSchema("routine");
export const RoutineRunId = idSchema("routineRun");
export const DraftId = idSchema("draft");
export const PeerRequestId = idSchema("peer");
export const OfferId = idSchema("offer");
