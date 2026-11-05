import type { Candidate } from "./proactive-pick.ts";

/**
 * Gap analysis 2026-11 P3 + P4: candidates the add-on already paid for that
 * did not become a card on the scan that found them.
 *
 * - `runner_up`: scored over the threshold but another candidate won the
 *   scan (only one homework runs at a time). Kept for RUNNER_UP_HOURS (or
 *   until its due time), offered when no homework is running.
 * - `watch`: dated, scored under the threshold because it was still far off
 *   (a deadline seen 10 days out). Re-scored without a model call at the
 *   checkpoints before it is due (3 days, 1 day, 6 hours), and offered the
 *   first time it passes; dropped once it is due.
 *
 * Every entry is re-scored and revalidated (suppress rules, evidence still
 * there, not a duplicate of a card already made) before it becomes a card.
 * Plain data in the add-on's state; no user content beyond the candidate
 * itself, which the state already held for homework.
 */

export type QueueKind = "runner_up" | "watch";

export interface QueueEntry {
  kind: QueueKind;
  candidate: Candidate;
  addedAt: string;
  /** The entry is dropped at this time. */
  expiresAt: string;
  /** watch: when to re-score next (a checkpoint before `dueAt`). */
  nextAt?: string;
}

export const RUNNER_UP_HOURS = 24;
export const QUEUE_MAX = 30;
/** Re-score a watched item this long before it is due (newest checkpoint last). */
export const CHECKPOINTS_MS: readonly number[] = [3 * 86400_000, 86400_000, 6 * 3600_000];

const iso = (ms: number) => new Date(ms).toISOString();

/** The next checkpoint after `now` for an item due at `dueAt`; undefined = none left. */
export function nextCheck(now: Date, dueAt: string): string | undefined {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return undefined;
  for (const before of CHECKPOINTS_MS) {
    const at = due - before;
    if (at > now.getTime()) return iso(at);
  }
  return undefined;
}

export function runnerUp(c: Candidate, now: Date): QueueEntry {
  const until = now.getTime() + RUNNER_UP_HOURS * 3600_000;
  const due = c.dueAt ? Date.parse(c.dueAt) : Number.POSITIVE_INFINITY;
  return {
    kind: "runner_up",
    candidate: c,
    addedAt: iso(now.getTime()),
    expiresAt: iso(Math.min(until, due)),
  };
}

/** A watch entry, or undefined when the candidate has no checkpoint left (or no due time). */
export function watch(c: Candidate, now: Date): QueueEntry | undefined {
  if (!c.dueAt) return undefined;
  const next = nextCheck(now, c.dueAt);
  if (!next) return undefined;
  return { kind: "watch", candidate: c, addedAt: iso(now.getTime()), expiresAt: c.dueAt, nextAt: next };
}

const shares = (a: Candidate, b: Candidate) => a.evidenceIds.some((id) => b.evidenceIds.includes(id));

/** Add entries (one per piece of evidence: a newer entry replaces an older one); expired ones go; at most QUEUE_MAX. */
export function enqueue(queue: readonly QueueEntry[], add: readonly QueueEntry[], now: Date): QueueEntry[] {
  let out = prune(queue, now);
  for (const e of add) out = [...out.filter((o) => !shares(o.candidate, e.candidate)), e];
  return out.slice(-QUEUE_MAX);
}

export function prune(queue: readonly QueueEntry[], now: Date): QueueEntry[] {
  return queue.filter((e) => Date.parse(e.expiresAt) > now.getTime());
}

/** Entries to look at now: every runner-up, and watched items whose checkpoint came. */
export function dueEntries(queue: readonly QueueEntry[], now: Date): QueueEntry[] {
  return queue.filter(
    (e) => e.kind === "runner_up" || (e.nextAt !== undefined && Date.parse(e.nextAt) <= now.getTime()),
  );
}

/** Without these evidence ids (the entry became a card or was dropped). */
export function without(queue: readonly QueueEntry[], c: Candidate): QueueEntry[] {
  return queue.filter((e) => !shares(e.candidate, c));
}

/** A watched entry that did not pass: on to its next checkpoint, or out. */
export function reschedule(queue: readonly QueueEntry[], e: QueueEntry, now: Date): QueueEntry[] {
  const rest = without(queue, e.candidate);
  if (e.kind !== "watch" || !e.candidate.dueAt) return rest;
  const next = nextCheck(now, e.candidate.dueAt);
  return next ? [...rest, { ...e, nextAt: next }] : rest;
}
