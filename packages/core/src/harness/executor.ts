import { validateArgs } from "./schema.ts";

/**
 * P15 B2 (plan v11.1 §1 S6–S8): the tool executor of one model step.
 *
 * - `shared` tools take a read lock (in parallel, at most 8 at once),
 *   `exclusive` ones the write lock; the lock is fair, so read → write → read
 *   runs in three phases and a read after a write sees it.
 * - Results go back in call order whatever order they finished in; every call
 *   gets exactly one result (an aborted or never-started call a placeholder).
 * - Unknown tool, bad JSON, schema mismatch and duplicate call ids are tool
 *   errors the model can fix; nothing throws out of the executor.
 * - Gate checks (approvals) run one at a time.
 */

export const MAX_PARALLEL_SHARED = 8;
export const GRACEFUL_CANCEL_MS = 2000;

export interface ExecToolSpec {
  name: string;
  schema?: Record<string, unknown>;
  concurrency: "shared" | "exclusive";
  run(args: Record<string, unknown>, ctx: { signal: AbortSignal; callId: string }): Promise<string>;
}

export interface ExecCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  argsError?: string;
  index: number;
}

export interface ExecResult {
  callId: string;
  ok: boolean;
  content: string;
  aborted?: boolean;
}

export type GateVerdict = { blocked: false } | { blocked: true; reason: string; stopRun?: boolean };

class FairRWLock {
  private readers = 0;
  private writer = false;
  private readonly queue: Array<{ write: boolean; go: () => void }> = [];

  acquire(write: boolean): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({
        write,
        go: () =>
          resolve(() => {
            if (write) this.writer = false;
            else this.readers--;
            this.drain();
          }),
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length) {
      const next = this.queue[0] as { write: boolean; go: () => void };
      if (next.write) {
        if (this.writer || this.readers > 0) return;
        this.writer = true;
      } else {
        if (this.writer) return;
        this.readers++;
      }
      this.queue.shift();
      next.go();
    }
  }
}

class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(n: number) {
    this.free = n;
  }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiters.push(r));
    return () => {
      const w = this.waiters.shift();
      if (w) w();
      else this.free++;
    };
  }
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

export interface ExecutorOptions {
  tools: ReadonlyMap<string, ExecToolSpec>;
  signal: AbortSignal;
  gate?: (call: ExecCall & { args: Record<string, unknown> }) => Promise<GateVerdict>;
  /** Shape a result before it is recorded (truncation + spill). */
  shape?: (tool: string, out: string) => string;
  onStart?: (c: ExecCall) => void;
  onEnd?: (c: ExecCall, r: ExecResult) => void;
  maxShared?: number;
  graceMs?: number;
}

export class ToolExecutor {
  private readonly o: ExecutorOptions;
  private readonly rw = new FairRWLock();
  private readonly shared: Semaphore;
  private readonly approvals = new Mutex();
  private readonly calls: ExecCall[] = [];
  private readonly tasks = new Map<number, Promise<void>>();
  private readonly results = new Map<number, ExecResult>();
  private readonly ids = new Set<string>();
  pausedForUser = false;

  constructor(o: ExecutorOptions) {
    this.o = o;
    this.shared = new Semaphore(o.maxShared ?? MAX_PARALLEL_SHARED);
  }

  started(c: ExecCall): boolean {
    return this.tasks.has(c.index);
  }

  private record(c: ExecCall, r: Omit<ExecResult, "callId">): void {
    if (this.results.has(c.index)) return;
    const res = { callId: c.id, ...r };
    this.results.set(c.index, res);
    this.o.onEnd?.(c, res);
  }

  /** Record a result without running (e.g. the final step, a cut response). */
  reject(c: ExecCall, why: string): void {
    if (!this.calls.includes(c)) this.calls.push(c);
    this.record(c, { ok: false, content: why });
  }

  start(c: ExecCall): void {
    if (this.tasks.has(c.index) || this.results.has(c.index)) return;
    this.calls.push(c);
    if (this.ids.has(c.id)) {
      this.record(c, { ok: false, content: `重複的呼叫 id：${c.id}` });
      return;
    }
    this.ids.add(c.id);
    this.tasks.set(c.index, this.runOne(c));
  }

  private async runOne(c: ExecCall): Promise<void> {
    const { o } = this;
    this.o.onStart?.(c);
    const spec = o.tools.get(c.name) ?? this.caseFix(c);
    if (!spec) {
      const names = [...o.tools.keys()].slice(0, 20).join(", ");
      return this.record(c, { ok: false, content: `未知工具 ${c.name || "（空）"}；可用：${names}` });
    }
    if (c.argsError) return this.record(c, { ok: false, content: c.argsError });
    const v = validateArgs(spec.name, spec.schema, c.args ?? {});
    if (!v.ok) return this.record(c, { ok: false, content: v.message });
    if (o.gate) {
      const verdict = await this.approvals.run(() =>
        (o.gate as NonNullable<ExecutorOptions["gate"]>)({ ...c, args: v.args }),
      );
      if (verdict.blocked) {
        if (verdict.stopRun) this.pausedForUser = true;
        return this.record(c, { ok: false, content: verdict.reason });
      }
    }
    if (o.signal.aborted) return this.record(c, { ok: false, content: "dispatch 前已取消", aborted: true });
    const release = await this.rw.acquire(spec.concurrency === "exclusive");
    const slot = spec.concurrency === "shared" ? await this.shared.acquire() : () => undefined;
    const t0 = Date.now();
    try {
      if (o.signal.aborted) return this.record(c, { ok: false, content: "dispatch 前已取消", aborted: true });
      const out = await spec.run(v.args, { signal: o.signal, callId: c.id });
      this.record(c, { ok: true, content: o.shape ? o.shape(spec.name, out) : out });
    } catch (e) {
      if (o.signal.aborted)
        this.record(c, {
          ok: false,
          content: `使用者中止，已執行 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`,
          aborted: true,
        });
      else this.record(c, { ok: false, content: String((e as Error)?.message ?? e) });
    } finally {
      slot();
      release();
    }
  }

  /** A name that differs only in case from exactly one tool is fixed. */
  private caseFix(c: ExecCall): ExecToolSpec | undefined {
    const hits = [...this.o.tools.values()].filter((t) => t.name.toLowerCase() === c.name.toLowerCase());
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** Wait for every started call. */
  async waitAll(): Promise<void> {
    await Promise.all(this.tasks.values());
  }

  /** On cancel: give running calls a grace to finish, then placeholders for every call without a result. */
  async settleAll(): Promise<void> {
    const grace = this.o.graceMs ?? GRACEFUL_CANCEL_MS;
    await Promise.race([this.waitAll(), new Promise((r) => setTimeout(r, grace))]);
    for (const c of this.calls)
      if (!this.results.has(c.index))
        this.record(c, {
          ok: false,
          content: this.tasks.has(c.index) ? "使用者中止；可能已部分執行" : "dispatch 前已取消",
          aborted: true,
        });
  }

  /** Every call's result in call order (missing ones as "not run"). */
  resultsInOrder(): ExecResult[] {
    return [...this.calls]
      .sort((a, b) => a.index - b.index)
      .map((c) => this.results.get(c.index) ?? { callId: c.id, ok: false, content: "未執行", aborted: true });
  }
}
