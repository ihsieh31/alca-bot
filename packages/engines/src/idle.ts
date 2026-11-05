/**
 * Proactivity item 10: a persistent CLI engine (Claude Code, Codex app-server)
 * held one process per conversation forever — every thread, router and worker
 * the person ever opened kept a CLI alive. This tracker records when each
 * conversation last used its process and, on a periodic sweep, releases the
 * ones idle longer than `idleMs` that are not mid-turn. A released
 * conversation keeps its session / thread id, so its next turn starts a new
 * process and resumes (`--resume` / `thread/resume`).
 *
 * The sweep timer starts on first use, is unref'd (it never keeps the host
 * alive), and `stop()` clears it (the engine's `dispose`).
 */

/** Default idle limit before a conversation's process is released (10 minutes). */
export const DEFAULT_IDLE_MS = 10 * 60_000;

/**
 * The idle limit in effect: `ALCA_ENGINE_IDLE_MINUTES` when set to a number
 * (0 = never release for idleness), else 10 minutes.
 */
export function defaultIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALCA_ENGINE_IDLE_MINUTES?.trim();
  if (!raw) return DEFAULT_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 60_000) : DEFAULT_IDLE_MS;
}

export interface IdleOptions {
  /** Release a process idle longer than this (ms). 0 or negative turns the sweep off. Default `defaultIdleMs()`. */
  idleMs?: number;
  /** How often to sweep (ms). Default: a quarter of `idleMs`, between 1 s and 60 s. */
  sweepEveryMs?: number;
  /** Clock (tests). */
  now?: () => number;
}

export class IdleReaper {
  readonly idleMs: number;
  private readonly every: number;
  private readonly now: () => number;
  private readonly lastUsed = new Map<string, number>();
  private readonly busy = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private sweeping: Promise<string[]> | undefined;
  /** Conversations released for idleness so far (observability and tests). */
  released = 0;

  private readonly release: (key: string) => Promise<void>;

  constructor(release: (key: string) => Promise<void>, opts: IdleOptions = {}) {
    this.release = release;
    this.idleMs = opts.idleMs ?? defaultIdleMs();
    this.every = opts.sweepEveryMs ?? Math.min(60_000, Math.max(1000, Math.floor(this.idleMs / 4)));
    this.now = opts.now ?? Date.now;
  }

  /** The conversation used its process now. */
  touch(key: string): void {
    this.lastUsed.set(key, this.now());
    this.arm();
  }

  /** A turn started on this conversation: never swept until `end`. */
  begin(key: string): void {
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
    this.touch(key);
  }

  /** The turn ended; the idle clock starts now. */
  end(key: string): void {
    const n = (this.busy.get(key) ?? 1) - 1;
    if (n > 0) this.busy.set(key, n);
    else this.busy.delete(key);
    this.touch(key);
  }

  /** The process is gone (released, replaced, disposed): stop tracking it. */
  forget(key: string): void {
    this.lastUsed.delete(key);
  }

  lastUsedAt(key: string): number | undefined {
    return this.lastUsed.get(key);
  }

  isBusy(key: string): boolean {
    return (this.busy.get(key) ?? 0) > 0;
  }

  /** Release every conversation idle past the limit and not mid-turn; returns the keys released. */
  sweep(): Promise<string[]> {
    this.sweeping ??= this.doSweep().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async doSweep(): Promise<string[]> {
    if (this.idleMs <= 0) return [];
    const cutoff = this.now() - this.idleMs;
    const due = [...this.lastUsed].filter(([k, t]) => t <= cutoff && !this.isBusy(k)).map(([k]) => k);
    const done: string[] = [];
    for (const key of due) {
      // A turn may have started while an earlier release was awaited.
      if (this.isBusy(key) || (this.lastUsed.get(key) ?? 0) > cutoff) continue;
      this.lastUsed.delete(key);
      try {
        await this.release(key);
        this.released++;
        done.push(key);
      } catch {
        // A failed stop is retried on a later turn's replacement; nothing to do here.
      }
    }
    if (this.lastUsed.size === 0) this.disarm();
    return done;
  }

  private arm(): void {
    if (this.timer || this.idleMs <= 0) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.every);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Engine dispose: clear the timer and all state. */
  stop(): void {
    this.disarm();
    this.lastUsed.clear();
    this.busy.clear();
  }

  /** Is the sweep timer running (tests)? */
  get armed(): boolean {
    return this.timer !== undefined;
  }
}
