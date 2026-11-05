import type { Store, WorkerRecord } from "@alca/store";
import { generalToolset } from "../../harness/general/lazy.ts";
import { type AwaitRequest, waitTools } from "../../harness/general/waits.ts";
import { harnessTools } from "../../harness/profiles.ts";
import type { HostTool } from "../../turn.ts";
import type { Live } from "./run.ts";

/**
 * Plan §5: the general harness's inner layer — its tool set (the host's
 * general tools, its own web / browser tools, the waits, behind deferred
 * loading) and the `await_event` hand-off to the outer loop (decide rule 2).
 */

export interface GeneralDeps {
  store: Store;
  now: () => Date;
  live: (workerId: string) => Live | undefined;
  /** The execution still holds its dispatch (the writer fence). */
  fenced: (w: WorkerRecord, token: string | undefined) => boolean;
}

/** Whether a worker may start waiting now; an error text when not. */
export function awaitRefusal(d: GeneralDeps, workerId: string, req: AwaitRequest): string | undefined {
  const l = d.live(workerId);
  const w = d.store.workers.get(workerId);
  if (!l || !w) return "這個工人已經結束了";
  if (w.grants.harness !== "general") return "只有一般工人能等外部事件";
  if (!d.fenced(w, l.token)) return "這個工人已經被取代，結果不會被採用；請停止。";
  if (l.tally.report || l.tally.handoff) return "已經回報（或換手）了，不能再開始等待";
  l.tally.awaiting = true;
  l.tally.awaitRequest = req;
  return undefined;
}

/** A general worker's tools: host tools allowed for general, its extra tools and the waits, lazily loaded. */
export function generalToolsFor(
  d: GeneralDeps,
  base: readonly HostTool[],
  extra: readonly HostTool[],
): HostTool[] {
  const waits = waitTools(d.store, { awaiting: (id, req) => awaitRefusal(d, id, req) }, () =>
    d.now().getTime(),
  );
  return generalToolset(harnessTools("general", [...base, ...extra, ...waits]));
}
