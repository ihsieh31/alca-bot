import type { FinishT } from "./turn.ts";

/**
 * Limits every run lives under (P13): a global cap on runs doing work at
 * once (`engineering.maxConcurrentRuns`) and a time budget for a thread /
 * router turn (`engineering.turnTimeoutSec`). Time spent waiting for a person
 * (an approval or a question) or for a free slot is not counted, and a run
 * waiting for a person gives its slot back, so runs parked on approvals can
 * never starve the others.
 */

/** Why a run was aborted when its turn ran out of time; the runner reads it from `signal.reason`. */
export class TurnTimeout extends Error {
  readonly seconds: number;
  constructor(seconds: number) {
    super(`turn timed out after ${seconds}s`);
    this.name = "TurnTimeout";
    this.seconds = seconds;
  }
}

export const TURN_TIMEOUT_CODE = "turn.timeout";

/** The finish a run gets when it was aborted: a timeout is a failure the person sees, anything else an interrupt. */
export function abortedFinish(signal: AbortSignal): FinishT {
  const r: unknown = signal.reason;
  if (r instanceof TurnTimeout)
    return { reason: "failed", error: { code: TURN_TIMEOUT_CODE, message: r.message } };
  return { reason: "interrupted" };
}

/**
 * A counting semaphore whose size is read on every acquire (settings can
 * change while running). Two lanes: a conversation turn (a person or a
 * router talking) goes ahead of queued workers, and workers leave one slot
 * free for conversations when the cap is 2 or more, so a bot can always
 * answer while its workers run (full duplex). FIFO within a lane.
 */
export type SlotLane = "turn" | "worker";

export class RunSlots {
  private readonly max: () => number;
  private used = 0;
  private readonly queue: Array<{ wake: () => void; lane: SlotLane }> = [];

  constructor(max: () => number) {
    this.max = max;
  }

  get inUse(): number {
    return this.used;
  }

  get waiting(): number {
    return this.queue.length;
  }

  private limit(): number {
    const n = Math.floor(this.max());
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  /** Resolves with a release function once a slot is free; rejects if `signal` aborts first. */
  private fits(lane: SlotLane): boolean {
    const limit = this.limit();
    return this.used < (lane === "worker" && limit > 1 ? limit - 1 : limit);
  }

  acquire(signal?: AbortSignal, lane: SlotLane = "turn"): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    const grant = (): (() => void) => {
      this.used++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        this.used--;
        this.drain();
      };
    };
    const ahead = this.queue.some((q) => lane === "worker" || q.lane === "turn");
    if (this.fits(lane) && !ahead) return Promise.resolve(grant());
    return new Promise((resolve, reject) => {
      const entry = {
        lane,
        wake: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(grant());
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error("aborted"));
        this.drain();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (lane === "turn") {
        const i = this.queue.findIndex((q) => q.lane === "worker");
        this.queue.splice(i < 0 ? this.queue.length : i, 0, entry);
      } else this.queue.push(entry);
    });
  }

  private drain(): void {
    for (let i = 0; i < this.queue.length; ) {
      const q = this.queue[i] as { wake: () => void; lane: SlotLane };
      if (!this.fits(q.lane)) {
        if (q.lane === "turn") return; // nothing fits after a turn that does not
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      q.wake();
    }
  }
}

/** A run's hold on a slot: given back while it waits for a person, taken again after. */
export class SlotHold {
  private readonly slots: RunSlots;
  private readonly lane: SlotLane;
  private release: (() => void) | undefined;

  constructor(slots: RunSlots, lane: SlotLane = "turn") {
    this.slots = slots;
    this.lane = lane;
  }

  get held(): boolean {
    return !!this.release;
  }

  async take(signal: AbortSignal): Promise<void> {
    if (this.release) return;
    this.release = await this.slots.acquire(signal, this.lane);
  }

  give(): void {
    const r = this.release;
    this.release = undefined;
    r?.();
  }
}

/** A stopwatch with a budget: counts only while running, calls `onExpire` once when the budget is spent. */
export class TurnClock {
  private readonly budgetMs: number;
  private readonly onExpire: () => void;
  private spentMs = 0;
  private startedAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expired = false;
  private stopped = false;
  private paused = 0;

  constructor(budgetMs: number, onExpire: () => void) {
    this.budgetMs = budgetMs;
    this.onExpire = onExpire;
  }

  get hasExpired(): boolean {
    return this.expired;
  }

  start(): void {
    if (this.stopped || this.expired || this.startedAt !== undefined || this.paused > 0) return;
    this.startedAt = Date.now();
    const left = Math.max(0, this.budgetMs - this.spentMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      this.expired = true;
      this.onExpire();
    }, left);
    this.timer.unref?.();
  }

  /** Pauses nest (two cards waiting at once): the clock runs again when the last one is answered. */
  pause(): void {
    this.paused++;
    if (this.startedAt === undefined) return;
    this.spentMs += Date.now() - this.startedAt;
    this.startedAt = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  resume(): void {
    if (this.paused > 0) this.paused--;
    if (this.paused === 0) this.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
