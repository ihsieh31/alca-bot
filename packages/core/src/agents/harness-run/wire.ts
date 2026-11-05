import type { AgentsEventData } from "@alca/protocol";
import type { DispatchEventRecord, Store } from "@alca/store";

/**
 * Design §0.2.3: a ledger row as the agents channel and the resume route
 * send it. Only these short detail fields leave the host — never a check's
 * output, a call's summary or a snapshot ref.
 */
const DETAIL_KEYS = [
  "level",
  "outcome",
  "status",
  "wakeAt",
  "streamId",
  "tool",
  "round",
  "ok",
  "met",
  "reason",
  "steps",
  "n",
  "actionClass",
] as const;

export function dispatchWire(e: DispatchEventRecord): AgentsEventData<"dispatch.event"> {
  const raw = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, unknown>;
  const detail: Record<string, string | number | boolean | null> = {};
  for (const k of DETAIL_KEYS) {
    const v = raw[k];
    if (typeof v === "string") detail[k] = v.slice(0, 200);
    else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || v === null)
      detail[k] = v;
  }
  const workerId = typeof raw.workerId === "string" ? raw.workerId.slice(0, 64) : undefined;
  return {
    dispatchId: e.dispatchId,
    seq: e.seq,
    kind: e.kind.slice(0, 40),
    at: new Date(e.at).toISOString(),
    ...(e.runId ? { runId: e.runId.slice(0, 64) } : {}),
    ...(e.turnId ? { turnId: e.turnId.slice(0, 64) } : {}),
    ...(e.waitId ? { waitId: e.waitId.slice(0, 64) } : {}),
    ...(workerId ? { workerId } : {}),
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

/** What a resume returns: the events after the cursor, or why it must start over. */
export type DispatchResume =
  | { kind: "events"; events: AgentsEventData<"dispatch.event">[]; next: number }
  | { kind: "not_found" }
  | { kind: "gone"; minSeq: number | null; refetch: string };

export const DISPATCH_REFETCH =
  "這段紀錄已超過保留期被清除。請重新讀取工人狀態（GET /api/workers/:id），再不帶 after 從頭讀 GET /api/dispatches/:id/events。";

/** Design §0.2.3: `GET /api/dispatches/:id/events?after=<seq>` (and the phone's `dispatches.events`). */
export function resumeDispatch(
  store: { dispatches: Pick<Store["dispatches"], "get" | "cursorGone" | "eventsAfter"> },
  id: string,
  after: number,
): DispatchResume {
  const cursor = Number.isFinite(after) ? Math.floor(after) : 0;
  if (!store.dispatches.get(id)) {
    // A client that holds a cursor saw this dispatch: it was pruned, not never there.
    return cursor > 0 ? { kind: "gone", minSeq: null, refetch: DISPATCH_REFETCH } : { kind: "not_found" };
  }
  const gone = store.dispatches.cursorGone(id, cursor);
  if (gone) return { kind: "gone", minSeq: gone.minSeq, refetch: DISPATCH_REFETCH };
  const events = store.dispatches.eventsAfter(id, Math.max(0, cursor)).map(dispatchWire);
  return { kind: "events", events, next: events.at(-1)?.seq ?? Math.max(0, cursor) };
}
