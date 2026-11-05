import type { DatabaseSync } from "node:sqlite";
import type { DispatchEventRecord } from "./dispatches.ts";

/**
 * Design §0.2.3: `dispatch_events` is the one source; observers (the agents
 * channel) see each row only once it is committed. Every write here is a
 * synchronous block, so by the next microtask the block that wrote a row has
 * either committed or rolled back. The feed then keeps the rows that are
 * still there (a rolled-back row is gone; AUTOINCREMENT may hand its seq to
 * a later row, so only the latest pending row per seq counts, and the stored
 * row must match it) and hands them on in seq order. A transaction still
 * open across a tick is waited out.
 */
export class DispatchEventFeed {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(e: DispatchEventRecord) => void>();
  private pending: DispatchEventRecord[] = [];
  private scheduled = false;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  observe(fn: (e: DispatchEventRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A row was just inserted (maybe inside a block that may still roll back). */
  wrote(e: DispatchEventRecord): void {
    if (!this.listeners.size) return;
    this.pending.push(e);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    let open: boolean;
    try {
      open = this.db.isTransaction;
    } catch {
      this.pending = [];
      this.scheduled = false;
      return; // the database closed under us: nobody is listening any more
    }
    if (open) {
      setImmediate(() => this.flush());
      return;
    }
    this.scheduled = false;
    const latest = new Map<number, DispatchEventRecord>();
    for (const e of this.pending) latest.set(e.seq, e);
    this.pending = [];
    const want = [...latest.values()].sort((a, b) => a.seq - b.seq);
    if (!want.length) return;
    const marks = want.map(() => "?").join(",");
    let stored: Array<{ seq: number; dispatch_id: string; kind: string }>;
    try {
      stored = this.db
        .prepare(`SELECT seq, dispatch_id, kind FROM dispatch_events WHERE seq IN (${marks})`)
        .all(...want.map((e) => e.seq)) as typeof stored;
    } catch {
      return;
    }
    const kept = new Map(stored.map((r) => [r.seq, r]));
    for (const e of want) {
      const r = kept.get(e.seq);
      if (!r || r.dispatch_id !== e.dispatchId || r.kind !== e.kind) continue;
      for (const fn of this.listeners) {
        try {
          fn(e);
        } catch {
          // an observer's failure never touches the ledger or the other observers
        }
      }
    }
  }
}
