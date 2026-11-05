import type { Store } from "@alca/store";
import type { HostTool } from "@alca/tools";
import { defuseAlcaTags } from "@alca/tools";
import { validateArgs } from "./schema.ts";
import { shapeToolOutput } from "./truncate.ts";

/**
 * Plan §2.1 / §2.8: what a harness worker gets around its tools — arguments checked
 * against the schema before a tool runs, outputs capped (the whole output
 * spilled), and `history_search` / `history_read` to look back at its own
 * earlier steps after older output was cut or compacted away.
 */

/** Errors of this kind are the model's to fix; the stop rules do not count them. */
export const SCHEMA_ERROR_MARK = "參數不符 schema";

export function wrapHarnessTool(
  t: HostTool,
  spill: (tool: string, full: string) => string | undefined,
): HostTool {
  return {
    ...t,
    run: async (args, signal, ctx) => {
      const v = validateArgs(t.spec.name, t.spec.inputSchema, args);
      if (!v.ok) throw new Error(v.message);
      const out = await t.run(v.args, signal, ctx);
      return shapeToolOutput(t.spec.name, out, (full) => spill(t.spec.name, full)).text;
    },
  };
}

interface Entry {
  id: string;
  kind: string;
  text: string;
}

/**
 * Plan §2.8 (B8): the runs of every worker of one dispatch, so a worker that
 * continues a task (after an answer, a wake or a restart) sees what the ones
 * before it did. A worker without a dispatch sees only its own runs.
 */
export function dispatchRuns(store: Store, workerId: string): string[] {
  const w = store.workers.get(workerId);
  const dispatchId = w?.grants.dispatchId;
  const rows = dispatchId
    ? store.db
        .prepare(
          `SELECT r.id FROM runs r JOIN workers w ON w.id = r.worker_id
           WHERE json_extract(w.grants, '$.dispatchId') = ? ORDER BY r.started_at, r.rowid`,
        )
        .all(dispatchId)
    : store.db.prepare("SELECT id FROM runs WHERE worker_id = ? ORDER BY started_at, rowid").all(workerId);
  return (rows as Array<{ id: string }>).map((r) => r.id);
}

/** Whether a spilled body belongs to a worker of the same dispatch. */
function sameDispatch(store: Store, workerId: string, ownerId: string): boolean {
  if (ownerId === workerId) return true;
  const a = store.workers.get(workerId)?.grants.dispatchId;
  return !!a && a === store.workers.get(ownerId)?.grants.dispatchId;
}

/** R7.7: the events history_search reads; stream chunks are never opened. */
const HISTORY_TYPES = ["tool.requested", "tool.completed", "message.completed"] as const;

function entriesOf(store: Store, workerId: string): Entry[] {
  const runs = dispatchRuns(store, workerId).map((id) => ({ id }));
  const out: Entry[] = [];
  const names = new Map<string, string>();
  for (const r of runs)
    for (const e of store.runs.events(r.id, -1, { types: HISTORY_TYPES })) {
      const p = (e.payload ?? {}) as { id?: string; data?: Record<string, unknown> };
      const d = p.data ?? {};
      const id = `${r.id}#${e.seq}`;
      if (e.type === "tool.requested") {
        names.set(String(d.callId), String(d.tool));
        out.push({ id, kind: `呼叫 ${String(d.tool)}`, text: JSON.stringify(d.args ?? {}) });
      } else if (e.type === "tool.completed") {
        const body = d.ok
          ? typeof d.result === "string"
            ? d.result
            : JSON.stringify(d.result ?? "")
          : String(d.error ?? "");
        out.push({
          id,
          kind: `結果 ${names.get(String(d.callId)) ?? ""}${d.ok ? "" : "（失敗）"}`,
          text: body,
        });
      } else if (e.type === "message.completed")
        out.push({
          id,
          kind: d.role === "assistant" ? "你的文字" : "任務／訊息",
          text: String(d.text ?? ""),
        });
    }
  return out;
}

export function historyTools(store: Store): HostTool[] {
  return [
    {
      spec: {
        name: "history_search",
        description:
          "在這件工作先前的步驟裡找東西（你和前手工人的工具呼叫、結果、寫過的文字）；回傳編號與片段，用 history_read 看全文。",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      actionClass: "read",
      run: async (a, _s, ctx) => {
        if (!ctx?.workerId) throw new Error("history_search 只給工人用");
        const q = String(a.query ?? "").toLowerCase();
        const limit = Math.min(20, typeof a.limit === "number" ? a.limit : 8);
        const hits = entriesOf(store, ctx.workerId)
          .filter((e) => e.text.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q))
          .slice(-limit);
        if (!hits.length) return "沒有符合的步驟。";
        return hits
          .map((h) => {
            const at = h.text.toLowerCase().indexOf(q);
            const from = Math.max(0, at - 80);
            return `${h.id}（${h.kind}）：${defuseAlcaTags(h.text.slice(from, from + 240))}`;
          })
          .join("\n");
      },
    },
    {
      spec: {
        name: "history_read",
        description:
          "用 history_search 給的編號（run_…#n）或截斷提示裡的全文編號（spl_…）取回全文；長內容用 offset 分頁。",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      actionClass: "read",
      run: async (a, _s, ctx) => {
        if (!ctx?.workerId) throw new Error("history_read 只給工人用");
        const id = String(a.id ?? "");
        const offset = typeof a.offset === "number" ? Math.max(0, a.offset) : 0;
        let body: string | undefined;
        if (id.startsWith("spl_")) {
          const s = store.workers.spill(id);
          if (s && sameDispatch(store, ctx.workerId, s.ownerId)) body = s.body;
        } else body = entriesOf(store, ctx.workerId).find((e) => e.id === id)?.text;
        if (body === undefined) throw new Error(`找不到 ${id}（只能讀這件工作的步驟）`);
        const page = body.slice(offset, offset + 8000);
        const more =
          offset + 8000 < body.length
            ? `\n[還有 ${body.length - offset - 8000} 字，用 offset=${offset + 8000} 繼續]`
            : "";
        return `${defuseAlcaTags(page)}${more}`;
      },
    },
  ];
}
