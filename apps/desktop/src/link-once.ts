import { RpcError } from "@alca/link";
import { atomic, type ClientOp, type Store } from "@alca/store";

/** A phone's own key for one queued operation (random, made on the phone). */
const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export interface OnceOptions<T> {
  /**
   * Run reservation, operation and result in one SQLite transaction, so a
   * crash leaves either all of it or none (for an operation whose writes all
   * happen synchronously and never open a transaction of their own, such as
   * creating a thread).
   */
  atomic?: boolean;
  /**
   * For a reservation still pending (the core crashed between running the
   * operation and storing its result, or the operation threw after writing):
   * find what the operation did since the key was reserved. Return nothing if
   * it never happened, and it runs now.
   */
  recover?: (reservedAt: string) => T | undefined;
}

/**
 * P13: run a phone operation at most once per client key. A queued send that
 * is flushed again (its answer was lost, the phone went offline mid-request,
 * the core restarted) gets the first result back with `duplicate: true` and
 * nothing is sent twice. Without a key the operation runs as before.
 *
 * The key is reserved (pending, committed) *before* the operation runs and
 * finished with the result right after, so there is no window in which a
 * retry could slip through unseen: a retry that finds a pending reservation
 * resolves it with `recover` instead of running again blind. An operation
 * that throws before writing anything frees its key (a busy thread can be
 * retried with the same key).
 */
export function once<T extends Record<string, unknown>>(
  store: Store,
  deviceId: string,
  key: unknown,
  op: ClientOp,
  run: () => T,
  o: OnceOptions<T> = {},
): T | (T & { duplicate: true }) {
  if (key === undefined || key === null) return run();
  if (typeof key !== "string" || !CLIENT_KEY.test(key))
    throw new RpcError("bad_request", "clientKey is malformed");
  const ops = store.clientOps;
  const body = (): T | (T & { duplicate: true }) => {
    const seen = ops.get(deviceId, key);
    if (seen && seen.op !== op)
      throw new RpcError("conflict", "this clientKey was used for another operation");
    if (seen?.state === "done") return { ...(seen.result as T), duplicate: true };
    let reservedAt: string;
    if (seen) {
      reservedAt = seen.createdAt;
      const found = o.recover?.(reservedAt);
      if (found) {
        ops.finish(deviceId, key, found);
        return { ...found, duplicate: true };
      }
    } else {
      const now = new Date();
      ops.reserve(deviceId, key, op, now);
      reservedAt = now.toISOString();
    }
    let result: T;
    try {
      result = run();
    } catch (e) {
      const found = o.recover?.(reservedAt);
      if (found) ops.finish(deviceId, key, found);
      else ops.release(deviceId, key);
      throw e;
    }
    ops.finish(deviceId, key, result);
    return result;
  };
  return o.atomic ? atomic(store.db, body) : body();
}

/** The window around a reservation in which its message must have been written. */
export function recoveryWindow(reservedAt: string): { from: string; to: string } {
  const t = Date.parse(reservedAt);
  return { from: new Date(t - 5_000).toISOString(), to: new Date(t + 60_000).toISOString() };
}
