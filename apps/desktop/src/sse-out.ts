import type { ServerResponse } from "node:http";

/**
 * PERF-2026-11 (§6): what one SSE client may have queued in the core's memory
 * before it is cut off. `res.write` never refuses: a client that stops
 * reading (a frozen tab, a laptop lid, a dead Wi-Fi link that TCP has not
 * noticed yet) used to buffer every event in the core without limit.
 *
 * Run events cannot be dropped or merged (the UI rebuilds text from the
 * sequence), so past the cap the connection is closed instead. That is the
 * resync: the desktop UI's stream loop reconnects on its own (ui/api.ts `sse`,
 * 0.5–8 s backoff; an EventSource would too), and every stream replays what a
 * fresh client needs on connect (open runs, pending cards, worker history).
 */
export const SSE_MAX_BUFFERED = 4 * 1024 * 1024;

export interface SseOut {
  /** Queue one chunk; false once the client was cut off (nothing more is queued). */
  write(chunk: string): boolean;
  /**
   * Review 2026-11-05 #5: start counting. A stream opened with `replay: true`
   * writes its initial replay uncapped (it is written in one tick, before the
   * client could read anything, so capping it would cut every client whose
   * replay is large, in a reconnect loop); the cap then applies to what is
   * queued beyond what the replay left in the buffer, until that drains.
   */
  arm(): void;
  /** Bytes waiting in Node for this client right now. */
  readonly buffered: number;
  readonly closed: boolean;
}

export function sseOut(
  res: ServerResponse,
  o: { maxBuffered?: number; onOverflow?: (buffered: number) => void; replay?: boolean } = {},
): SseOut {
  const max = o.maxBuffered ?? SSE_MAX_BUFFERED;
  let closed = false;
  let armed = !o.replay;
  /** What the replay left queued when the cap was armed (forgotten once the socket drains). */
  let base = 0;
  res.once("close", () => {
    closed = true;
  });
  return {
    write(chunk: string): boolean {
      if (closed || res.destroyed) return false;
      if (armed && res.writableLength + chunk.length > base + max) {
        closed = true;
        o.onOverflow?.(res.writableLength);
        // Drop what is queued: a reconnect replays it.
        res.destroy();
        return false;
      }
      res.write(chunk);
      return true;
    },
    arm() {
      if (armed) return;
      armed = true;
      base = res.writableLength;
      if (base > 0)
        res.once("drain", () => {
          base = 0;
        });
    },
    get buffered() {
      return res.writableLength;
    },
    get closed() {
      return closed || res.destroyed;
    },
  };
}
