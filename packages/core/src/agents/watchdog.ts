import type { AgentsEventData } from "@alca/protocol";
import type { Store, WorkerRecord } from "@alca/store";
import type { WorkerSupervisor, WorkersPolicy } from "./workers.ts";

/**
 * Watchdog (plan v4): a separate, clock-driven check that does not run inside
 * any worker. It looks at what the store and the supervisor say about each
 * live worker and stops the ones that are
 *
 * - stuck: running (not waiting for a person) with no activity for `stuckSec`;
 * - looping: the same call (tool + args) with the same result `loopRepeats`
 *   times within the last `loopWindow` calls (plan §2.4: call signature +
 *   result hash, so a poll whose output keeps changing is not a loop);
 * - over budget: more steps (one step = one `tool.completed`, for every
 *   engine), running time (time waiting for a person is not counted) or tokens
 *   than the worker's budget. A harness worker is interrupted by its
 *   supervisor at its step budget and gets one report-only pass; the watchdog
 *   only stops it when it overruns that pass too.
 *
 * A stopped worker reports to its router like any other (status `stopped`,
 * reason `watchdog.<kind>`), and each stop is logged in `watchdog_events`.
 */

/** Steps a harness worker may spend in its report-only pass after the budget ran out. */
export const REPORT_PASS_STEPS = 2;

export type WatchdogKind = "stuck" | "looping" | "over_budget";

export interface WatchdogFinding {
  workerId: string;
  botId: string;
  kind: WatchdogKind;
  detail: string;
}

export function inspectWorker(
  w: WorkerRecord,
  recent: readonly string[],
  p: WorkersPolicy,
  now: Date,
): WatchdogFinding | undefined {
  if (w.status !== "running" && w.status !== "waiting") return undefined;
  const at = (iso: string | null) => (iso ? Date.parse(iso) : now.getTime());
  const base = { workerId: w.id, botId: w.botId };
  const window = recent.slice(-p.loopWindow);
  const counts = new Map<string, number>();
  let top = 0;
  for (const s of window) {
    const n = (counts.get(s) ?? 0) + 1;
    counts.set(s, n);
    top = Math.max(top, n);
  }
  if (top >= p.loopRepeats)
    return { ...base, kind: "looping", detail: `最近 ${window.length} 次呼叫裡同一個呼叫重複了 ${top} 次` };
  const maxSteps = (w.budget.maxSteps ?? p.maxSteps) + (w.grants?.harness ? REPORT_PASS_STEPS : 0);
  if (w.steps > maxSteps)
    return { ...base, kind: "over_budget", detail: `步數 ${w.steps} 超過上限 ${maxSteps}` };
  const maxTokens = w.budget.maxTokens ?? p.maxTokens;
  if (w.tokens > maxTokens)
    return { ...base, kind: "over_budget", detail: `用量 ${w.tokens} tokens 超過上限 ${maxTokens}` };
  const waitingNow =
    w.status === "waiting" && w.waitingSince ? now.getTime() - Date.parse(w.waitingSince) : 0;
  const runMs = now.getTime() - at(w.startedAt) - w.waitedMs - waitingNow;
  const maxRunMs = w.budget.maxRunMs ?? p.maxRunSec * 1000;
  if (runMs > maxRunMs)
    return {
      ...base,
      kind: "over_budget",
      detail: `執行了 ${Math.round(runMs / 1000)} 秒，超過上限 ${Math.round(maxRunMs / 1000)} 秒`,
    };
  if (w.status === "running") {
    const idle = now.getTime() - at(w.lastActivityAt ?? w.startedAt);
    if (idle > p.stuckSec * 1000)
      return { ...base, kind: "stuck", detail: `${Math.round(idle / 1000)} 秒沒有任何進度` };
  }
  return undefined;
}

export interface WatchdogOptions {
  store: Store;
  workers: WorkerSupervisor;
  policy: () => WorkersPolicy;
  emit: (d: AgentsEventData<"watchdog.flagged">) => void;
  now?: () => Date;
}

export class Watchdog {
  private readonly o: WatchdogOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(o: WatchdogOptions) {
    this.o = o;
  }

  /** Look once; stop what must be stopped. Returns what was found. */
  async tick(): Promise<WatchdogFinding[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const now = this.o.now?.() ?? new Date();
      const p = this.o.policy();
      const found: WatchdogFinding[] = [];
      for (const w of this.o.store.workers.active()) {
        if (!this.o.workers.isLive(w.id)) continue;
        const f = inspectWorker(w, this.o.workers.recentCalls(w.id), p, now);
        if (!f) continue;
        found.push(f);
        this.o.store.triggers.addWatchdog(f, now);
        this.o.emit({ ...f, action: "stopped" });
        await this.o.workers.stop(w.id, `watchdog.${f.kind}: ${f.detail}`);
      }
      return found;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    const every = Math.max(1, this.o.policy().watchdogSec) * 1000;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
