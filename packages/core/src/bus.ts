import type { AlcaEvent } from "@alca/protocol";
import type { HumanWaits } from "./turn.ts";

export type Listener = (e: AlcaEvent) => void;

/**
 * In-process fan-out of protocol events, per thread (or "*" for all). Other
 * keys carry streams that are not a thread's chat, e.g. `worker:<id>` for a
 * worker's own run events (watched from the UI without the router seeing them).
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(threadId: string | "*", fn: Listener): () => void {
    let set = this.listeners.get(threadId);
    if (!set) {
      set = new Set();
      this.listeners.set(threadId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(threadId);
    };
  }

  watching(threadId: string): boolean {
    return (this.listeners.get(threadId)?.size ?? 0) > 0;
  }

  publish(e: AlcaEvent): void {
    this.publishTo(e.threadId, e);
    this.publishTo("*", e);
  }

  /** Deliver to one key's subscribers only. */
  publishTo(key: string, e: AlcaEvent): void {
    for (const fn of this.listeners.get(key) ?? []) {
      try {
        fn(e);
      } catch {
        // a broken subscriber must not break the run
      }
    }
  }
}

/** Promise latches keyed by approval / question id. */
export class HumanLatch implements HumanWaits {
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly done = new Set<string>();

  wait(id: string, signal: AbortSignal): Promise<void> {
    if (this.done.has(id)) return Promise.resolve();
    if (signal.aborted) return Promise.reject(new Error("aborted"));
    return new Promise((resolve, reject) => {
      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      const onAbort = () => {
        set.delete(wake);
        reject(new Error("aborted"));
      };
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      set.add(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  notify(id: string): void {
    this.done.add(id);
    const set = this.waiters.get(id);
    this.waiters.delete(id);
    for (const w of set ?? []) w();
  }
}
