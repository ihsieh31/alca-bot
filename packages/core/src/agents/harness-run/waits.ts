import { atomic, newStoreId, type Store, type WaitRecord, type WorkerRecord } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import { answeredGoal, answerRefusal } from "../../harness/needs-input.ts";
import type { StartWorkerInput } from "../workers.ts";

/**
 * Plan §2.8 / §2.9: what happens to a dispatch's open wait — a NEEDS_INPUT
 * answered, an awaited event that arrived, a question that expired, or a
 * stop that lands after the worker already ended with the question open.
 *
 * A wait is always claimed (compare-and-set, in the store) for a worker id
 * made up front, before any worker exists; only the winner creates the
 * continuation worker, on the same dispatch. The claim and that worker's rows
 * are one atomic block (design §0.2.1): if the worker cannot be created (the
 * per-bot cap, the engine no longer fits, the folder is gone) the claim rolls
 * back, the wait is open again and the dispatch is still waiting, instead of
 * a dispatch stuck `queued` for a worker that never existed.
 */

export interface WaitDeps {
  store: Store;
  now: () => Date;
  /** The level a bot's work runs at (B12). */
  levelOf: (botId: string, threadId: string) => string;
  /** The supervisor's `start`, in its two halves: the rows (atomic, may throw) … */
  insert: (input: StartWorkerInput) => WorkerRecord;
  /** … and the side effects, run only after the rows are committed. */
  launch: (w: WorkerRecord) => WorkerRecord;
}

/** Why a wait can no longer take an answer, in the words the router / person sees. */
function closedWhy(d: WaitDeps, wait: WaitRecord): string {
  if (wait.state === "expired") return "這題已經過期了";
  if (
    wait.state === "closed" &&
    !wait.claimedBy &&
    d.store.dispatches.get(wait.dispatchId)?.outcome === "stopped"
  )
    return "這件工作已經停止了";
  return "這題已經回答過了";
}

/** Answer a worker's NEEDS_INPUT: claim the wait, then start the continuation worker. */
export function answerWait(
  d: WaitDeps,
  workerId: string,
  answers: readonly string[],
  turnInitiator: string,
): WorkerRecord {
  const w = d.store.workers.get(workerId);
  const wait = w ? d.store.dispatches.waitOf(w.id) : undefined;
  if (!w || !wait || wait.kind !== "needs_input") throw new Error("這個工人沒有在等回答");
  if (wait.state !== "open") throw new Error(closedWhy(d, wait));
  const qs = wait.questions as Parameters<typeof answerRefusal>[0];
  const refusal = answerRefusal(qs, answers, turnInitiator, d.levelOf(w.botId, w.threadId));
  if (refusal) throw new Error(refusal);
  const by = turnInitiator === "user" ? "user" : "router";
  const id = newStoreId("wkr", d.now().getTime());
  const list = answers.map((a) => a.trim().slice(0, 4000));
  const next = atomic(d.store.db, () => {
    if (!d.store.dispatches.claim(wait.id, id, d.now().getTime(), { answers: list, by })) return null;
    return continueWith(d, w, id, wait.id, answeredGoal(w.goal, qs, list, by));
  });
  if (!next) throw new Error(closedWhy(d, d.store.dispatches.wait(wait.id) ?? wait));
  return d.launch(next);
}

/** An awaited event arrived: claim the wait (CAS) before any worker exists; null = already taken. */
export function wakeWait(
  d: WaitDeps,
  waitId: string,
  note: string,
  opts?: { fenced?: boolean },
): WorkerRecord | null {
  const wait = d.store.dispatches.wait(waitId);
  const w = wait ? d.store.workers.get(wait.workerId) : undefined;
  if (!wait || !w || wait.state !== "open") return null;
  const id = newStoreId("wkr", d.now().getTime());
  const next = atomic(d.store.db, () => {
    if (!d.store.dispatches.claim(wait.id, id, d.now().getTime())) return null;
    return continueWith(
      d,
      w,
      id,
      wait.id,
      // A trigger event arrives already fenced (`triggerBody`, every field defused).
      `${w.goal}\n\n等待的事件到了：${opts?.fenced ? note : defuseAlcaTags(note.slice(0, 4000))}`,
    );
  });
  return next ? d.launch(next) : null;
}

/**
 * The continuation worker's rows: same bot, thread, budget and grants; it
 * serves the same dispatch. Call inside the claim's atomic block, then launch.
 * No wait for a 續做 (design §0.2.5).
 */
export function continueWith(
  d: WaitDeps,
  w: WorkerRecord,
  id: string,
  waitId: string | undefined,
  goal: string,
): WorkerRecord {
  const { memoryIds, skillId, harness, dispatchId, doneWhen, workdir, ownsPaths, checks, resultSchema } =
    w.grants;
  return d.insert({
    id,
    botId: w.botId,
    threadId: w.threadId,
    ...(w.parentRunId ? { parentRunId: w.parentRunId } : {}),
    title: w.title,
    goal,
    initiator: w.initiator,
    budget: w.budget,
    grants: {
      ...(memoryIds ? { memoryIds } : {}),
      ...(skillId ? { skillId } : {}),
      ...(harness ? { harness } : {}),
      ...(dispatchId ? { dispatchId } : {}),
      ...(doneWhen ? { doneWhen } : {}),
      ...(workdir ? { workdir } : {}),
      ...(ownsPaths ? { ownsPaths } : {}),
      ...(checks ? { checks } : {}),
      ...(resultSchema ? { resultSchema } : {}),
      ...(waitId ? { waitId } : {}),
    },
  });
}

/** Text questions unanswered for 72 hours expire; the workers that asked them (each told once). */
export function expireWaits(d: WaitDeps): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  for (const wt of d.store.dispatches.expireWaits(d.now().getTime())) {
    const w = d.store.workers.get(wt.workerId);
    if (w) out.push(w);
  }
  return out;
}

/**
 * A stop for a worker that already ended with its question (or awaited event)
 * still open: the wait closes and the dispatch settles as `stopped`, recorded
 * in the ledger. False when it had no open wait.
 */
export function stopOpenWait(d: WaitDeps, w: WorkerRecord, reason: string): boolean {
  if (!w.finishedAt) return false;
  const wait = d.store.dispatches.waitOf(w.id);
  if (wait?.state !== "open") return false;
  return d.store.dispatches.stopWait(wait.id, reason, d.now().getTime());
}
