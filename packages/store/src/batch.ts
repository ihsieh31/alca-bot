import { performance } from "node:perf_hooks";

/**
 * Next round R2.3: long deletes run as steps. A step is one committed batch;
 * between steps a driver may hand the write lock back (the database worker
 * waits, so the main thread's next write gets in). One implementation, two
 * drivers: `drainSync` (tests, the CLI, a core with no worker) and
 * `drainAsync` (the worker, and its inline twin).
 */

/** A generator that yields once per committed batch (the rows it touched) and returns the result. */
export type Steps<T> = Generator<number, T, void>;

export function drainSync<T>(g: Steps<T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

export interface DrainOptions {
  /** Called between batches; resolves when the next batch may start. */
  pause?: (lastBatchMs: number) => Promise<void>;
  /** Asked between batches: true = stop after the batch that just committed. */
  stop?: () => boolean;
  /** Each batch's time (R2.2 measurements, the warning past the target). */
  onBatch?: (ms: number, rows: number) => void;
}

export class StoppedError extends Error {
  constructor() {
    super("stopped between batches");
    this.name = "StoppedError";
  }
}

export async function drainAsync<T>(g: Steps<T>, sizer: BatchSizer, o: DrainOptions = {}): Promise<T> {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    o.onBatch?.(sizer.lastMs, r.value);
    if (o.stop?.()) {
      g.return(undefined as T);
      throw new StoppedError();
    }
    await (o.pause ? o.pause(sizer.lastMs) : new Promise<void>((res) => setImmediate(res)));
  }
}

/**
 * Batch size that follows a time target: start at 2,000 rows, then scale by
 * target / last batch time, between 200 and 50,000. `fixed` keeps one size.
 */
export class BatchSizer {
  size: number;
  lastMs = 0;
  private readonly target: number;
  private readonly min: number;
  private readonly max: number;

  constructor(o: { targetMs: number; start?: number; min?: number; max?: number }) {
    this.target = o.targetMs;
    this.min = o.min ?? 200;
    this.max = o.max ?? 50_000;
    this.size = Math.min(this.max, Math.max(this.min, o.start ?? 2_000));
  }

  static fixed(size: number): BatchSizer {
    return new BatchSizer({ targetMs: 0, start: size, min: size, max: size });
  }

  /** Run one batch, remember its time, adjust the next size. */
  time<R>(fn: () => R): R {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.lastMs = performance.now() - t0;
      if (this.target > 0) {
        const factor = this.target / Math.max(this.lastMs, 0.5);
        const next = Math.round(this.size * Math.min(4, Math.max(0.25, factor)));
        this.size = Math.min(this.max, Math.max(this.min, next));
      }
    }
  }
}
