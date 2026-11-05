import { parentPort, workerData } from "node:worker_threads";
import { StoppedError } from "./batch.ts";
import { openDatabase } from "./db.ts";
import { DB_JOBS, type JobContext } from "./db-jobs.ts";
import type { WorkerReply, WorkerRequest } from "./db-worker.ts";
import { configurePerf, perfSnapshot, resetPerf } from "./perf.ts";
import { bindSealer, Sealer, type SealWire } from "./seal.ts";

/**
 * R2.3: the database worker's thread. Its own connection, made by the same
 * `openDatabase` (foreign keys, busy_timeout, secure_delete, WAL); one job
 * at a time. Between batches it waits about as long as the batch took, so
 * the main thread's writes get the lock (SQLite has no queue for it).
 */

const port = parentPort;
if (!port) throw new Error("db-worker-main runs only as a worker thread");
const { path, seal } = workerData as { path: string; seal?: SealWire };
const db = openDatabase({ path, conn: "worker" });
// R7: the worker's connection seals and opens with the same key ring as the main one.
if (seal) bindSealer(db, new Sealer(seal));
const quiet = () => configurePerf({ thresholds: { warnSqlMs: Number.POSITIVE_INFINITY } }); // the main thread warns
quiet();
let stopping = false;
let chain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function handle(req: WorkerRequest): Promise<void> {
  let batches = 0;
  let maxBatchMs = 0;
  const ctx: JobContext = {
    db,
    dbPath: path,
    batchMs: req.batchMs,
    pause: (last) => sleep(Math.min(250, Math.max(1, Math.ceil(last)))),
    stop: () => stopping,
    onBatch: (_j, ms) => {
      batches += 1;
      if (ms > maxBatchMs) maxBatchMs = ms;
    },
  };
  let reply: WorkerReply;
  try {
    const fn = DB_JOBS[req.job] as (c: JobContext, ...a: unknown[]) => Promise<unknown>;
    const value = await fn(ctx, ...req.args);
    reply = { id: req.id, ok: true, value, slow: perfSnapshot().slow, batches, maxBatchMs };
  } catch (err) {
    reply = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof StoppedError ? { stopped: true } : {}),
      slow: perfSnapshot().slow,
      batches,
      maxBatchMs,
    };
  }
  resetPerf();
  quiet();
  port?.postMessage(reply);
}

port.on("message", (m: WorkerRequest | { close: true } | { exit: true }) => {
  if ("close" in m) {
    stopping = true;
    return;
  }
  if ("exit" in m) {
    void chain.then(() => {
      db.close();
      process.exit(0); // in a worker thread this ends the thread, not the process
    });
    return;
  }
  chain = chain.then(() => handle(m));
});
