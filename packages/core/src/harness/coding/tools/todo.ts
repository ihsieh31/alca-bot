import type { HostTool } from "@alca/tools";
import { obj, type Todo, type ToolEnv } from "./common.ts";

/**
 * Plan §4 / §2.6: `todo` — the worker's own checklist for multi-step work,
 * rewritten whole on every call, one item in progress at a time. The host
 * keeps the latest list per worker: before a compaction it is flushed into
 * the handover (todo snapshot), so the plan survives the new session.
 */

const MARK: Record<Todo["status"], string> = {
  completed: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
  cancelled: "[-]",
};

/** The list as the model and the handover see it; "" when empty. */
export function formatTodos(todos: readonly Todo[]): string {
  if (!todos.length) return "";
  const done = todos.filter((t) => t.status === "completed").length;
  return `${todos.map((t) => `${MARK[t.status]} ${t.content}`).join("\n")}\n完成 ${done} / 共 ${todos.length}`;
}

export function todoTool(env: ToolEnv): HostTool {
  return {
    spec: {
      name: "todo",
      description:
        "多步驟（≥3 步）工作的清單，每次整份覆寫；同時只能有一個 in_progress。內容會在壓縮時保留給下一個工作階段。",
      inputSchema: obj(
        {
          todos: {
            type: "array",
            items: obj(
              {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
              },
              ["content", "status"],
            ),
          },
        },
        ["todos"],
      ),
    },
    actionClass: "read",
    run: async (a, _s, ctx) => {
      const list = (Array.isArray(a.todos) ? a.todos : []) as Array<{
        id?: string;
        content: string;
        status: Todo["status"];
      }>;
      if (list.length > 50) throw new Error("最多 50 項。");
      const busy = list.filter((t) => t.status === "in_progress").length;
      if (busy > 1) throw new Error(`同時只能有一個 in_progress 項目（目前 ${busy} 個）。`);
      for (const t of list)
        if (!t.content?.trim() || t.content.length > 500) throw new Error("每一項都要有內容（500 字以內）。");
      const s = env.state(ctx);
      s.todos = list.map((t, i) => ({
        id: t.id ?? `t${i + 1}`,
        content: t.content.trim(),
        status: t.status,
      }));
      return formatTodos(s.todos) || "（清單已清空）";
    },
  };
}
