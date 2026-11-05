/**
 * PERF-2026-11: reconnect timing shared by the core's host and the phone's
 * client. The first retry is short because a relay restart is the common
 * case and the phone cannot be online before the core is (the core's first
 * wait was every phone's reconnect floor: 2.8 s median with 1 s doubling).
 * Every wait gets ±20 % jitter, so cores and phones that lost one relay
 * together do not all come back in the same instant, and doubles up to a cap.
 */
export const FIRST_RETRY_MS = 250;
export const MAX_RETRY_MS = 30_000;

/** The wait to use now for a backoff step of `ms` (±20 %). */
export function jittered(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (0.8 + random() * 0.4));
}

/** The next backoff step after `ms`, capped at `max`. */
export function nextRetry(ms: number, max: number = MAX_RETRY_MS): number {
  return Math.min(ms * 2, max);
}
