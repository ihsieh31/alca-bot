import { statSync } from "node:fs";
import { relative } from "node:path";
import type { HostTool } from "@alca/tools";
import type { ConfinePlan } from "../../../workspace/sandbox.ts";
import type { BashSessions } from "../bash.ts";
import type { InstructionBudget } from "../project.ts";
import type { ReadState } from "../text.ts";

/** Plan §4: what every coding tool shares — the worker's folder and its per-worker state. */

export type HostToolContext = Parameters<HostTool["run"]>[2];

export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface WorkerState {
  reads: ReadState;
  bash: BashSessions;
  instructions: InstructionBudget;
  todos: Todo[];
}

export interface ToolEnv {
  /** The worker's folder (bot folder, or its dispatch `workdir` inside it). */
  dir(ctx: HostToolContext | undefined): string;
  state(ctx: HostToolContext | undefined): WorkerState;
  /** Whether the current model reads images. */
  images: boolean;
  /** Keep a long output whole (returns where); undefined when nothing keeps it. */
  spill?: ((ctx: HostToolContext | undefined, title: string, body: string) => string | undefined) | undefined;
  /** ripgrep's path; false = never use it (the built-in walk). */
  rg: string | false;
  /** Next-round §5: the OS sandbox a worker's commands run in; undefined = none (exactly as before). */
  confine?: ((ctx: HostToolContext | undefined) => ConfinePlan | undefined) | undefined;
}

export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const shownPath = (root: string, p: string) => relative(root, p) || ".";

export const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Lines added / removed between two texts (for the short summary the model gets). */
export function lineDelta(a: string, b: string): { added: number; removed: number } {
  const al = a.split("\n");
  const bl = b.split("\n");
  let s = 0;
  while (s < al.length && s < bl.length && al[s] === bl[s]) s++;
  let e = 0;
  while (e < al.length - s && e < bl.length - s && al[al.length - 1 - e] === bl[bl.length - 1 - e]) e++;
  return { added: bl.length - s - e, removed: al.length - s - e };
}
