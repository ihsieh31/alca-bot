import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { StoppedError } from "./batch.ts";
import { DB_JOBS, type JobArgs, type JobContext, type JobName, type JobResult } from "./db-jobs.ts";
import { DEFAULT_PERF, recordJob, recordSql, type SlowSql } from "./perf.ts";
import type { SealWire } from "./seal.ts";

/**
 * Next round R2.3: one database worker. The heavy jobs (`DB_JOBS`) run on a
 * `worker_threads` thread over a second connection made by the same
 * `openDatabase` (same pragmas). Jobs run one at a time — there is never a
 * second background writer. `inline` runs the same jobs on the main
 * connection instead (`:memory:`, tests): one implementation, two places.
 *
 * Rules that make the second connection safe (R2.3):
 * - every main-thread transaction takes the write lock up front (`atomic`);
 * - the worker writes only in short batches and waits about as long as the
 *   batch took before the next one, so a main-thread write waits ~one batch;
 * - the retention gate is opened and closed inside the worker's own
 *   transaction, so the main connection never sees it open;
 * - `close()` lets the batch in progress commit, cancels the rest.
 */

export interface DbWorkerOptions {
  path: string;
  /** The main connection (inline mode runs the jobs on it). */
  db: DatabaseSync;
  /** Run jobs on the main thread (default for ":memory:"). */
  inline?: boolean;
  /** Target batch time (settings `engineering.perf.workerBatchMs`). */
  batchMs?: () => number;
  log?: (level: "info" | "warn" | "error", line: string) => void;
  /** R7: the data key ring as plain data, so the worker's connection seals and opens too. */
  seal?: SealWire;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  job: string;
  started: number;
}

export interface WorkerRequest {
  id: number;
  job: JobName;
  args: unknown[];
  batchMs: number;
}

interface ReplyBase {
  id: number;
  slow: SlowSql[];
  batches: number;
  maxBatchMs: number;
}

export type WorkerReply =
  | (ReplyBase & { ok: true; value: unknown })
  | (ReplyBase & { ok: false; error: string; stopped?: boolean });

export class CancelledError extends Error {
  constructor(job: string) {
    super(`${job} cancelled (the store is closing)`);
    this.name = "CancelledError";
  }
}

const memoryPath = (p: string) => p === ":memory:" || p.startsWith("file::memory:");

export class DbWorker {
  readonly mode: "worker" | "inline";
  private readonly o: DbWorkerOptions;
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private inFlight = 0;

  constructor(o: DbWorkerOptions) {
    this.o = o;
    this.mode = o.inline || memoryPath(o.path) ? "inline" : "worker";
  }

  /** Jobs waiting or running. */
  get busy(): number {
    return this.inFlight;
  }

  private batchMs(): number {
    return this.o.batchMs?.() ?? DEFAULT_PERF.workerBatchMs;
  }

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./db-worker-main.ts", import.meta.url), {
      workerData: { path: this.o.path, ...(this.o.seal ? { seal: this.o.seal } : {}) },
      execArgv: process.execArgv,
    });
    w.unref();
    w.on("message", (m: WorkerReply) => this.reply(m));
    w.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
    w.on("exit", (code) => {
      this.worker = undefined;
      if (this.pending.size) this.failAll(new Error(`database worker exited (${code})`));
    });
    this.worker = w;
    return w;
  }

  private reply(m: WorkerReply): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    for (const s of m.slow) recordSql(s.sql, s.kind, s.ms, "worker");
    this.finish(p.job, p.started, m.batches, m.maxBatchMs);
    if (m.ok) p.resolve(m.value);
    else p.reject(m.stopped ? new CancelledError(p.job) : new Error(m.error));
  }

  private finish(job: string, started: number, batches: number, maxBatchMs: number): void {
    recordJob(job, Date.now() - started);
    const target = this.batchMs();
    // R2.2: a batch far over its target means the size adjustment is not working.
    if (batches > 1 && maxBatchMs >= Math.max(100, target * 4))
      this.o.log?.("warn", `資料庫背景工作 ${job} 單批 ${Math.round(maxBatchMs)} ms（目標 ${target} ms）`);
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err);
    }
  }

  /** Queue one job; jobs run one at a time, in order. */
  run<K extends JobName>(job: K, ...args: JobArgs<K>): Promise<JobResult<K>> {
    if (this.closing) return Promise.reject(new CancelledError(job));
    this.inFlight += 1;
    const go = () => this.exec(job, args);
    const next = this.queue.then(go, go);
    this.queue = next.catch(() => undefined);
    return next.finally(() => {
      this.inFlight -= 1;
    });
  }

  private exec<K extends JobName>(job: K, args: JobArgs<K>): Promise<JobResult<K>> {
    if (this.closing) return Promise.reject(new CancelledError(job));
    if (this.mode === "inline") return this.execInline(job, args);
    const id = this.nextId++;
    const w = this.spawn();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, job, started: Date.now() });
      const req: WorkerRequest = { id, job, args, batchMs: this.batchMs() };
      w.postMessage(req);
    });
  }

  private async execInline<K extends JobName>(job: K, args: JobArgs<K>): Promise<JobResult<K>> {
    const started = Date.now();
    let batches = 0;
    let maxBatchMs = 0;
    const ctx: JobContext = {
      db: this.o.db,
      dbPath: this.o.path,
      batchMs: this.batchMs(),
      pause: () => new Promise((r) => setImmediate(r)),
      stop: () => this.closing,
      onBatch: (_j, ms) => {
        batches += 1;
        if (ms > maxBatchMs) maxBatchMs = ms;
      },
    };
    try {
      const fn = DB_JOBS[job] as (c: JobContext, ...a: unknown[]) => Promise<JobResult<K>>;
      return await fn(ctx, ...(args as unknown[]));
    } catch (err) {
      if (err instanceof StoppedError) throw new CancelledError(job);
      throw err;
    } finally {
      this.finish(job, started, batches, maxBatchMs);
    }
  }

  /** Let the batch in progress commit, cancel what has not started, stop the thread. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const w = this.worker;
    w?.postMessage({ close: true });
    await this.queue.catch(() => undefined);
    if (!w) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        void w.terminate().finally(resolve);
      }, 10_000);
      t.unref();
      w.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      w.postMessage({ exit: true });
    });
  }
}
