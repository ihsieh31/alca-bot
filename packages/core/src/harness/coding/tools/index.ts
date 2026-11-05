import type { HostTool } from "@alca/tools";
import type { ConfinePlan } from "../../../workspace/sandbox.ts";
import { realish } from "../../../workspace/workdir.ts";
import { BashSessions } from "../bash.ts";
import { loadInstructions } from "../project.ts";
import { ReadState } from "../text.ts";
import { bashTools } from "./bash.ts";
import type { HostToolContext, Todo, ToolEnv, WorkerState } from "./common.ts";
import { editTool, writeTool } from "./edit.ts";
import { patchTool } from "./patch.ts";
import { readTool } from "./read.ts";
import { findRipgrep, globTool, grepTool } from "./search.ts";
import { formatTodos, todoTool } from "./todo.ts";

/**
 * Plan §4: the coding harness's own tools for engines whose tool loop is
 * Alca's (API engines) — read, edit, write, apply_patch, grep, glob, bash
 * (+ poll / input / kill) and todo. Every path is confined to the worker's
 * folder. They are ordinary host tools: the gate, the work-folder guards
 * (ownsPaths), undo snapshots and the shell floor apply as to any other.
 * State (what was read, shell sessions, the todo list, which AGENTS.md were
 * loaded) is per worker and dropped by `release` when the worker ends.
 */

export interface CodingToolsOptions {
  /** The folder a worker works in (its bot's folder, or the dispatch `workdir` inside it). */
  dirFor(ctx: { botId: string; workerId?: string }): string | undefined;
  /** Whether the current model reads images (read returns a note otherwise). */
  images?: boolean;
  /** Keep a long output whole; returns where (the model is told). */
  spill?: (o: { botId: string; workerId?: string; title: string; body: string }) => string | undefined;
  /** ripgrep's path; false = the built-in walk; default: `rg` when installed. */
  rg?: string | false;
  /** Next-round §5: the OS sandbox a worker's commands run in (its bot at its level). */
  confineFor?: (ctx: { botId: string; workerId?: string }) => ConfinePlan | undefined;
}

const freshState = (): WorkerState => ({
  reads: new ReadState(),
  bash: new BashSessions(),
  instructions: { seen: new Set(), used: 0 },
  todos: [],
});

export class CodingTools {
  private readonly o: CodingToolsOptions;
  private readonly states = new Map<string, WorkerState>();
  private readonly env: ToolEnv;

  constructor(o: CodingToolsOptions) {
    this.o = o;
    this.env = {
      dir: (ctx) => this.dir(ctx),
      state: (ctx) => this.stateOf(ctx?.workerId ?? ctx?.threadId ?? "_"),
      images: o.images ?? false,
      rg: o.rg ?? findRipgrep(),
      confine: (ctx) =>
        ctx
          ? o.confineFor?.({ botId: ctx.botId, ...(ctx.workerId ? { workerId: ctx.workerId } : {}) })
          : undefined,
      spill: (ctx, title, body) =>
        ctx
          ? o.spill?.({ botId: ctx.botId, ...(ctx.workerId ? { workerId: ctx.workerId } : {}), title, body })
          : undefined,
    };
  }

  private stateOf(key: string): WorkerState {
    let s = this.states.get(key);
    if (!s) {
      s = freshState();
      this.states.set(key, s);
    }
    return s;
  }

  private dir(ctx: HostToolContext | undefined): string {
    if (!ctx) throw new Error("沒有 bot，無法決定工作資料夾");
    const d = this.o.dirFor({ botId: ctx.botId, ...(ctx.workerId ? { workerId: ctx.workerId } : {}) });
    if (!d) throw new Error("這個 bot 沒有工作資料夾，程式工具不能使用");
    // Mac test B1: tool paths come back real (confine resolves symlinks), so the root must be
    // real too — /var/folders/… is /private/var/folders/… — or every shown path, rg's cwd and
    // the AGENTS.md walk are off by the link. Resolving never widens: confine already did.
    return realish(d);
  }

  /** The tool set. */
  tools(): HostTool[] {
    const e = this.env;
    return [
      readTool(e),
      editTool(e),
      writeTool(e),
      patchTool(e),
      grepTool(e),
      globTool(e),
      ...bashTools(e),
      todoTool(e),
    ];
  }

  /**
   * The project instructions for a worker's folder (AGENTS.md / CLAUDE.md
   * from the repo root down, 32 KiB) as a task-message block. The files
   * loaded count against the worker's budget, so a sub-folder's file read
   * later adds only what is left.
   */
  instructions(workerId: string, dir: string): string {
    try {
      const r = loadInstructions(realish(dir));
      const s = this.stateOf(workerId);
      for (const f of r.files) s.instructions.seen.add(f);
      s.instructions.used = Math.max(s.instructions.used, r.used);
      return r.text;
    } catch {
      return "";
    }
  }

  /** The worker's todo list now (the compaction flush); undefined when it has none. */
  todos(workerId: string): readonly Todo[] | undefined {
    const t = this.states.get(workerId)?.todos;
    return t?.length ? t : undefined;
  }

  /** The todo list as text ("" when none). */
  todoSnapshot(workerId: string): string {
    return formatTodos(this.todos(workerId) ?? []);
  }

  /** Shell sessions a worker still has running (tests, diagnostics). */
  running(workerId: string): number {
    return this.states.get(workerId)?.bash.running() ?? 0;
  }

  /** A worker is done: end its shell sessions and forget what it read. */
  release(workerId: string): void {
    this.states.get(workerId)?.bash.closeAll();
    this.states.delete(workerId);
  }

  /** Alca is closing: end every session. */
  closeAll(): void {
    for (const s of this.states.values()) s.bash.closeAll();
    this.states.clear();
  }
}
