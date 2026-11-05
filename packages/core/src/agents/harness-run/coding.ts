import type { Engine } from "@alca/engines";
import type { WorkerRecord } from "@alca/store";
import type { CodingTools } from "../../harness/coding/tools/index.ts";
import { wrapHarnessTool } from "../../harness/history.ts";
import type { HostTool } from "../../turn.ts";

/**
 * Plan §4: the coding inner layer for engines whose tool loop is Alca's (API
 * engines, `ownsToolLoop: false`). A coding worker on such an engine gets the
 * coding tools (read, edit, write, apply_patch, grep, glob, bash…, todo) on
 * top of the host tools its profile allows; a CLI engine keeps its own
 * native tools (plan §0.1 B) and gets none of these. The worker's task
 * message carries the project's AGENTS.md (from the repo root down, 32 KiB);
 * its todo list is flushed into the handover before a compaction; its shell
 * sessions end with it.
 */

/** Whether a worker runs the coding inner layer of its own (an API engine on a coding dispatch). */
export function ownCodingLoop(w: WorkerRecord, engine: Engine): boolean {
  return w.grants.harness === "coding" && !engine.capabilities.ownsToolLoop;
}

/**
 * The coding tools a worker gets. Outputs other than `read` (which pages
 * itself at 50 KB) are capped and spilled like every harness tool's, with
 * the arguments checked against the schema first.
 */
export function codingToolsFor(
  coding: CodingTools | undefined,
  w: WorkerRecord,
  engine: Engine,
  spill: (tool: string, full: string) => string | undefined,
): HostTool[] {
  if (!coding || !ownCodingLoop(w, engine)) return [];
  return coding.tools().map((t) => (t.spec.name === "read" ? t : wrapHarnessTool(t, spill)));
}

/** The project instructions block of a coding worker's task message ([] when none or not coding). */
export function codingContext(
  coding: CodingTools | undefined,
  w: WorkerRecord,
  engine: Engine,
  dir: string | undefined,
): string[] {
  if (!coding || !dir || !ownCodingLoop(w, engine)) return [];
  const text = coding.instructions(w.id, dir);
  return text ? [text] : [];
}

/** The todo snapshot flushed into a compaction's handover ("" when none). */
export function codingTodos(coding: CodingTools | undefined, w: WorkerRecord): string {
  return coding?.todoSnapshot(w.id) ?? "";
}
