import { EVENT_WAIT_LIMIT, type Store } from "@alca/store";
import type { HostTool } from "@alca/tools";

/**
 * Plan §5: `await_event` and `list_waits` for the general harness. A worker
 * that has to wait for something outside (a reply, a page change, a time)
 * says what it waits for and ends its turn instead of polling. The outer
 * loop then ends the execution (decide rule 2) and the dispatch waits with
 * an open `event` wait in the ledger; `workers.wake(waitId)` — from a
 * trigger, or the clock when `wakeInMinutes` comes — starts a continuation
 * worker on the same dispatch.
 *
 * There is no `close_wait`: a woken worker's wait closes when it reports,
 * and a worker may not end another task's wait.
 */

export const EVENT_WAIT_DEFAULT_HOURS = 72;
export const EVENT_WAIT_MAX_HOURS = 168;

export interface AwaitRequest {
  note: string;
  /** When the clock wakes it (ms), or null for an outside event only. */
  wakeAt: number | null;
  expiresAt: number;
  /** Design §0.2.2: the stream whose next event wakes it (a `worker_start.subscribe`-style key, resolved). */
  streamId?: string;
}

export interface WaitSink {
  /** The worker asks to wait; an error text when it may not (no harness, already reported…). */
  awaiting(workerId: string, req: AwaitRequest): string | undefined;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export function waitTools(store: Store, sink: WaitSink, now: () => number = Date.now): HostTool[] {
  return [
    {
      spec: {
        name: "await_event",
        description:
          "要等外部事件（信件回覆、頁面變化、某個時間）時呼叫：note 寫清楚等什麼、到了要做什麼；要在某個時間醒來就給 wakeInMinutes；要等某個事件串流（例如 github:pr/7）的下一個事件就給 stream。呼叫後立刻結束這一回合，不要再呼叫其他工具，也不要用重複查詢代替等待；事件到了 Alca 會叫一個新的工人接著做。",
        inputSchema: obj(
          {
            note: { type: "string", minLength: 1, maxLength: 500 },
            wakeInMinutes: { type: "integer", minimum: 1, maximum: EVENT_WAIT_MAX_HOURS * 60 },
            expiresInHours: { type: "integer", minimum: 1, maximum: EVENT_WAIT_MAX_HOURS },
            stream: { type: "string", minLength: 1, maxLength: 200 },
          },
          ["note"],
        ),
      },
      actionClass: "read",
      run: async (a, _signal, ctx) => {
        if (!ctx?.workerId || !ctx.botId) throw new Error("await_event 只給工人用");
        const note = typeof a.note === "string" ? a.note.trim() : "";
        if (!note || note.length > 500) throw new Error("note 需要 1–500 字");
        const open = store.dispatches.openEventWaits(ctx.botId).length;
        if (open >= EVENT_WAIT_LIMIT)
          throw new Error(
            `這個 bot 已經有 ${EVENT_WAIT_LIMIT} 個開著的等待；請改用 report_result 回報 blocked，說明在等什麼`,
          );
        const t = now();
        const hours = Math.min(
          EVENT_WAIT_MAX_HOURS,
          Math.max(
            1,
            typeof a.expiresInHours === "number" ? Math.floor(a.expiresInHours) : EVENT_WAIT_DEFAULT_HOURS,
          ),
        );
        const wakeAt =
          typeof a.wakeInMinutes === "number" && a.wakeInMinutes >= 1
            ? t + Math.floor(a.wakeInMinutes) * 60_000
            : null;
        const expiresAt = Math.max(t + hours * 3600_000, (wakeAt ?? 0) + 3600_000);
        const key = typeof a.stream === "string" ? a.stream.trim() : "";
        if (key.length > 200) throw new Error("stream 最長 200 字");
        const streamId = key ? store.triggers.ensureStream(ctx.botId, key, key).id : undefined;
        const refused = sink.awaiting(ctx.workerId, {
          note,
          wakeAt,
          expiresAt,
          ...(streamId ? { streamId } : {}),
        });
        if (refused) throw new Error(refused);
        return JSON.stringify({
          waiting: true,
          ...(wakeAt ? { wakeAt: new Date(wakeAt).toISOString() } : {}),
          ...(key ? { stream: key } : {}),
          expiresAt: new Date(expiresAt).toISOString(),
          openWaits: open + 1,
          limit: EVENT_WAIT_LIMIT,
          next: "end_turn_now",
        });
      },
    },
    {
      spec: {
        name: "list_waits",
        description: "列出這個 bot 開著的等待（note、何時開的、何時醒來）。",
        inputSchema: obj({}),
      },
      actionClass: "read",
      run: async (_a, _signal, ctx) => {
        if (!ctx?.botId) throw new Error("list_waits 需要 bot");
        return JSON.stringify(
          store.dispatches.openEventWaits(ctx.botId).map((w) => {
            const q = (w.questions[0] ?? {}) as { note?: string; wakeAt?: number | null };
            return {
              waitId: w.id,
              note: q.note ?? "",
              openedAt: new Date(w.createdAt).toISOString(),
              ...(q.wakeAt ? { wakeAt: new Date(q.wakeAt).toISOString() } : {}),
              ...(w.expiresAt ? { expiresAt: new Date(w.expiresAt).toISOString() } : {}),
            };
          }),
        );
      },
    },
  ];
}
