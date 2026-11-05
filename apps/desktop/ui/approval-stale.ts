// Mac test 2026-11 B10: an approval card belongs to the worker that asked.
// Once that worker has ended (it gave up, finished or was stopped) the card can
// no longer be answered, so the timeline marks it 已失效 and drops its buttons.
// Pure (no DOM), so it is unit-tested in Node; timeline.ts draws it.

/** Harness phases in which a worker may still be waiting on an approval. */
import { t } from "./i18n/index.ts";

const LIVE_PHASES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "verifying",
  "waiting_input",
  "waiting_event",
]);
/** Plain worker statuses in which it may still be waiting on an approval. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "waiting"]);

/** The word on a card whose worker ended before anyone answered it. */
export const STALE_WORD = t("desktop.approvalStale.expired");

/** Whether a worker is over: a harness worker by its phase, a plain one by its status. */
export function workerEnded(w: { status: string; harness?: { phase: string } | undefined }): boolean {
  if (w.harness) return !LIVE_PHASES.has(w.harness.phase);
  return !LIVE_STATUSES.has(w.status);
}

/**
 * The still-open approvals (in `pending` order) that `workerId` asked for.
 * `owner` maps an approval id to the worker that asked; a card with no worker
 * (the bot's own turn) is never stale.
 */
export function staleApprovals(
  pending: readonly string[],
  owner: (approvalId: string) => string | undefined,
  workerId: string,
): string[] {
  if (!workerId) return [];
  return pending.filter((id) => owner(id) === workerId);
}
