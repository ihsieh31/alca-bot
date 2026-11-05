import { type IntervalHistogram, monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * Next round R2.2: measure before (and after) moving work off the main
 * thread. The hook sits on `openDatabase`, the one place every connection is
 * made, not in the repos. Per call it costs two `performance.now()` and one
 * Map update. Only the first 200 characters of the SQL text are kept and
 * never the parameters (they can be message text).
 *
 * The numbers feed log lines and 設定 → 資料; nothing here changes behaviour.
 */

export type SqlKind = "run" | "get" | "all" | "iterate" | "exec";

export interface SqlStat {
  sql: string;
  calls: number;
  totalMs: number;
  maxMs: number;
}

export interface SlowSql {
  at: string;
  ms: number;
  sql: string;
  kind: SqlKind;
  conn: "main" | "worker";
}

export interface PerfSnapshot {
  /** Event-loop delay since the last reset, in ms (monitorEventLoopDelay). */
  loop: { p50: number; p99: number; max: number; samples: number };
  /** The newest slow calls (ring buffer, 200). */
  slow: SlowSql[];
  /** The 20 statements with the most total time. */
  top: SqlStat[];
  /** Main-thread calls that look like a lock wait (≥ 50 ms and ≥ 5× that statement's mean). */
  lockWaitMs: { count: number; max: number };
  /** R2.3: the database worker's jobs. */
  jobs: Record<string, { lastMs: number; maxMs: number; at: string }>;
  thresholds: PerfThresholds;
}

export interface PerfThresholds {
  slowSqlMs: number;
  warnSqlMs: number;
  loopP99Ms: number;
  loopMaxMs: number;
  workerBatchMs: number;
}

export const DEFAULT_PERF: PerfThresholds = {
  slowSqlMs: 50,
  warnSqlMs: 200,
  loopP99Ms: 100,
  loopMaxMs: 1000,
  workerBatchMs: 25,
};

const RING = 200;
const TOP = 20;
const SQL_CHARS = 200;
/** ALCA_SQL_TRACE=1 logs every call at least this slow. */
const TRACE_MS = 10;
const LOCK_MIN_MS = 50;
/** Prepared statements kept per connection (SQL built per call, such as IN lists, rotate out). */
export const STMT_CACHE_MAX = 512;
/** exec() texts that leave the schema alone (the cache survives them). */
const TX_SQL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b[^;]*;?\s*$/i;
/** Prepared statements that can change the schema. */
const SCHEMA_SQL = /^\s*(CREATE|ALTER|DROP|ATTACH|DETACH|REINDEX)\b/i;
const STMT_CACHE_SIZE = Symbol.for("alca.store.stmtCacheSize");

/** Tests: the number of statements cached on a connection made by `instrument`. */
export function stmtCacheSize(db: DatabaseSync): number {
  return (db as unknown as Record<symbol, number>)[STMT_CACHE_SIZE] ?? 0;
}

type Warn = (line: string) => void;

const state = {
  thresholds: { ...DEFAULT_PERF } as PerfThresholds,
  stats: new Map<string, SqlStat>(),
  slow: [] as SlowSql[],
  lock: { count: 0, max: 0 },
  jobs: {} as PerfSnapshot["jobs"],
  warn: undefined as Warn | undefined,
  trace: process.env.ALCA_SQL_TRACE === "1",
  loop: undefined as IntervalHistogram | undefined,
};

/** Settings → thresholds (and where warnings go). Call again when the settings change. */
export function configurePerf(o: { thresholds?: Partial<PerfThresholds>; warn?: Warn }): void {
  if (o.thresholds) state.thresholds = { ...state.thresholds, ...o.thresholds };
  if (o.warn) state.warn = o.warn;
}

export function perfThresholds(): PerfThresholds {
  return state.thresholds;
}

/**
 * PERF-2026-11: the key of a statement in the stats. Nested `atomic()` blocks
 * use a fresh savepoint name each time (`alca_sp_<n>`); without folding them
 * every nested block added two never-repeating keys until the hourly reset.
 * Memoized: exec() texts repeat, and the regex used to run on every call.
 */
const CLIP_CACHE_MAX = 2048;
/** `IN (?, ?, ?)` built per call with a different length: one key for all lengths. */
const IN_LIST = /\(\s*\?(?:\s*,\s*\?)+\s*\)/g;
/**
 * PERF-2026-11 (4): distinct statements kept in the stats between hourly
 * resets. Past it, a new key replaces the one with the least total time (it
 * could never reach the top 20 anyway).
 */
export const STATS_MAX = 1000;
const clipCache = new Map<string, string>();
const clip = (sql: string): string => {
  let k = clipCache.get(sql);
  if (k !== undefined) return k;
  k = sql
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\balca_sp_\d+\b/g, "alca_sp_N")
    .replace(IN_LIST, "(?, …)")
    .slice(0, SQL_CHARS);
  if (clipCache.size >= CLIP_CACHE_MAX) clipCache.clear();
  clipCache.set(sql, k);
  return k;
};

/** Record one call. Exported for the worker's results and for tests. */
export function recordSql(sql: string, kind: SqlKind, ms: number, conn: "main" | "worker" = "main"): void {
  recordKey(clip(sql), kind, ms, conn);
}

/** recordSql with the key already clipped (statements clip once, when prepared). */
function recordKey(key: string, kind: SqlKind, ms: number, conn: "main" | "worker"): void {
  let s = state.stats.get(key);
  const mean = s && s.calls > 0 ? s.totalMs / s.calls : undefined;
  if (!s) {
    s = { sql: key, calls: 0, totalMs: 0, maxMs: 0 };
    if (state.stats.size >= STATS_MAX) evictLeast();
    state.stats.set(key, s);
  }
  s.calls += 1;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
  if (conn === "main" && mean !== undefined && s.calls > 5 && ms >= LOCK_MIN_MS && ms >= mean * 5) {
    state.lock.count += 1;
    if (ms > state.lock.max) state.lock.max = ms;
  }
  if (ms >= state.thresholds.slowSqlMs) {
    state.slow.push({ at: new Date().toISOString(), ms: round(ms), sql: key, kind, conn });
    if (state.slow.length > RING) state.slow.splice(0, state.slow.length - RING);
  }
  if (ms >= state.thresholds.warnSqlMs) state.warn?.(`慢查詢 ${round(ms)} ms（${conn}，${kind}）：${key}`);
  else if (state.trace && ms >= TRACE_MS) state.warn?.(`SQL ${round(ms)} ms（${conn}，${kind}）：${key}`);
}

function evictLeast(): void {
  let least: SqlStat | undefined;
  for (const v of state.stats.values()) if (!least || v.totalMs < least.totalMs) least = v;
  if (least) state.stats.delete(least.sql);
}

/** Tests: how many distinct statements the stats hold. */
export function perfStatsSize(): number {
  return state.stats.size;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

function wrapStatement(
  st: StatementSync,
  sql: string,
  conn: "main" | "worker",
  fresh: () => StatementSync,
): StatementSync {
  const key = clip(sql);
  const timed =
    <A extends unknown[], R>(kind: SqlKind, fn: (...a: A) => R) =>
    (...a: A): R => {
      const t0 = performance.now();
      try {
        return fn(...a);
      } finally {
        recordKey(key, kind, performance.now() - t0, conn);
      }
    };
  const run = st.run.bind(st);
  const get = st.get.bind(st);
  const all = st.all.bind(st);
  Object.defineProperties(st, {
    run: { value: timed("run", run), configurable: true },
    get: { value: timed("get", get), configurable: true },
    all: { value: timed("all", all), configurable: true },
    iterate: {
      // The whole iteration counts as one call (time spent inside next()).
      // A cached statement is shared: each iteration gets its own (an iteration can be left open).
      value: (...a: Parameters<StatementSync["iterate"]>) => {
        let spent = 0;
        const t0 = performance.now();
        const it = fresh().iterate(...a);
        spent += performance.now() - t0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          recordKey(key, "iterate", spent, conn);
        };
        const wrapped = {
          next: () => {
            const t = performance.now();
            try {
              const r = it.next();
              if (r.done) {
                spent += performance.now() - t;
                finish();
              }
              return r;
            } finally {
              if (!done) spent += performance.now() - t;
            }
          },
          return: (v?: unknown) => {
            finish();
            return it.return ? it.return(v) : { done: true as const, value: v };
          },
          [Symbol.iterator]() {
            return wrapped;
          },
        };
        return wrapped as unknown as ReturnType<StatementSync["iterate"]>;
      },
      configurable: true,
    },
  });
  return st;
}

/**
 * Time every statement of `db` (prepare → run/get/all/iterate) and every
 * `exec`. Returns the same object so callers keep their type.
 */
export function instrument(
  db: DatabaseSync,
  o: { conn: "main" | "worker" } = { conn: "main" },
): DatabaseSync {
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  // PERF-2026-11: one compiled + wrapped statement per SQL text and connection
  // (LRU, STMT_CACHE_MAX). The repos call db.prepare(sql) on every call;
  // compiling and wrapping cost ~25 µs each time against ~6 µs to run a cached
  // one. Why sharing is safe:
  // - node:sqlite's run/get/all step to the end and reset the statement before
  //   they return, and everything here is single-threaded, so the next caller
  //   (in this or another transaction) always starts from a reset statement;
  // - iterate() can be left open, so each iteration gets its own statement;
  // - after a schema change a compiled statement can keep the old column list
  //   (`SELECT *` after ALTER TABLE: node:sqlite keeps reporting the old
  //   columns), so any exec() that is not plain transaction control, and any
  //   prepared DDL, empties the cache (migrations run through exec()). Schema
  //   changes happen on the main connection only (migrations at open);
  // - close()/open() empty it too (a closed database finalizes its statements);
  // - no repo calls the statement setters (setReadBigInts, setReturnArrays, …):
  //   on a shared statement they would leak to every caller. Prepare a raw
  //   statement for that instead.
  const cache = new Map<string, StatementSync>();
  const close = db.close.bind(db);
  const open = db.open.bind(db);
  Object.defineProperties(db, {
    prepare: {
      value: (sql: string) => {
        const hit = cache.get(sql);
        if (hit) {
          // LRU: move to the newest end.
          cache.delete(sql);
          cache.set(sql, hit);
          return hit;
        }
        const st = wrapStatement(prepare(sql), sql, o.conn, () => prepare(sql));
        if (SCHEMA_SQL.test(sql)) {
          // DDL: never cached, and running it drops what was compiled against the old schema.
          const run = st.run;
          Object.defineProperty(st, "run", {
            value: (...a: Parameters<StatementSync["run"]>) => {
              try {
                return run(...a);
              } finally {
                cache.clear();
              }
            },
            configurable: true,
          });
          return st;
        }
        if (cache.size >= STMT_CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(sql, st);
        return st;
      },
      configurable: true,
    },
    exec: {
      value: (sql: string) => {
        const t0 = performance.now();
        try {
          return exec(sql);
        } finally {
          if (!TX_SQL.test(sql)) cache.clear();
          recordKey(clip(sql), "exec", performance.now() - t0, o.conn);
        }
      },
      configurable: true,
    },
    close: {
      value: () => {
        cache.clear();
        return close();
      },
      configurable: true,
    },
    open: {
      value: () => {
        cache.clear();
        return open();
      },
      configurable: true,
    },
  });
  /** Tests: how many statements this connection holds. */
  Object.defineProperty(db, STMT_CACHE_SIZE, { get: () => cache.size, configurable: true });
  return db;
}

/** R2.3: one background job's time. */
export function recordJob(name: string, ms: number): void {
  const prev = state.jobs[name];
  state.jobs[name] = {
    lastMs: round(ms),
    maxMs: round(Math.max(ms, prev?.maxMs ?? 0)),
    at: new Date().toISOString(),
  };
}

/** Start sampling the event loop (the core start does this once). Idempotent. */
export function startLoopMonitor(): void {
  if (state.loop) return;
  state.loop = monitorEventLoopDelay({ resolution: 20 });
  state.loop.enable();
}

export function stopLoopMonitor(): void {
  state.loop?.disable();
  state.loop = undefined;
}

const ns = (v: number) => (Number.isFinite(v) ? round(v / 1e6) : 0);

/** What has been measured; `reset` starts the next window (the hourly sweep does). */
export function perfSnapshot(reset = false): PerfSnapshot {
  const h = state.loop;
  const samples = h ? h.count : 0;
  const snap: PerfSnapshot = {
    loop: {
      p50: h && samples ? ns(h.percentile(50)) : 0,
      p99: h && samples ? ns(h.percentile(99)) : 0,
      max: h && samples ? ns(h.max) : 0,
      samples,
    },
    slow: [...state.slow],
    top: [...state.stats.values()]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, TOP)
      .map((s) => ({ ...s, totalMs: round(s.totalMs), maxMs: round(s.maxMs) })),
    lockWaitMs: { count: state.lock.count, max: round(state.lock.max) },
    jobs: { ...state.jobs },
    thresholds: { ...state.thresholds },
  };
  if (reset) {
    h?.reset();
    state.stats.clear();
    state.lock = { count: 0, max: 0 };
  }
  return snap;
}

/** Slow calls past the hourly thresholds, as warning lines (empty when quiet). */
export function loopWarnings(s: PerfSnapshot): string[] {
  const out: string[] = [];
  const t = s.thresholds;
  if (s.loop.samples && (s.loop.p99 >= t.loopP99Ms || s.loop.max >= t.loopMaxMs))
    out.push(`事件迴圈延遲偏高：p99 ${s.loop.p99} ms、max ${s.loop.max} ms`);
  return out;
}

/** Tests: forget everything measured. */
export function resetPerf(): void {
  state.stats.clear();
  state.slow = [];
  state.lock = { count: 0, max: 0 };
  state.jobs = {};
  state.thresholds = { ...DEFAULT_PERF };
  state.warn = undefined;
  state.loop?.reset();
}
