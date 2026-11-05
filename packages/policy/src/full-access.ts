import { shellClass, shellCommandOf } from "./classify.ts";
import type { ActionClass } from "./rules.ts";
import { splitCommands, substitutions } from "./shell.ts";

/**
 * Phase 5: what the 完全授權 level (`full_access`) lets run without a card.
 *
 * Only what the person agreed to (2026-11-04 23:35), nothing wider:
 * - changing files and running commands (write / execute / network);
 * - `git push` — and only a plain `git push`: every simple command of the
 *   line that the classifier calls a publish must be one;
 * - deleting files, inside the work folder or outside it (shell `rm`,
 *   `rmdir`, `unlink`, `find -delete`, `git clean`, an ACP agent's native
 *   delete) — never a database `DROP` / `DELETE FROM`, never a connected
 *   app's delete tool.
 *
 * Payment and outward sends (mail, messages, POSTs) are never allowed here:
 * one such part anywhere in the line keeps the whole call asking. Reads are
 * not attributed to the level (they run at every level).
 */
export const FULL_ACCESS_REASON = "放行原因：完全授權";

/** A plain `git push` (optionally `git -C dir push`), with no `-c` that could alias it to something else. */
const GIT_PUSH = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git(?:\s+-C\s+\S+)?\s+push(?:\s|$)/;
const SQL_DELETE = /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE(\s+TABLE)?|DELETE\s+FROM)\b/i;
const OUTWARD: readonly ActionClass[] = ["payment", "send"];
const MAX_DEPTH = 4;

/** Every part of a command line is either ordinary, a plain git push, or a file delete. */
function lineAllowed(text: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (OUTWARD.includes(shellClass(text))) return false;
  for (const words of splitCommands(text)) {
    const seg = words.join(" ").trim();
    if (!seg) continue;
    const cls = shellClass(seg);
    if (OUTWARD.includes(cls)) return false;
    if (cls === "publish" && !GIT_PUSH.test(seg)) return false;
    if (cls === "delete" && SQL_DELETE.test(seg)) return false;
  }
  for (const sub of substitutions(text)) if (!lineAllowed(sub, depth + 1)) return false;
  return true;
}

/**
 * Does 完全授權 let this (resolved) call run without asking? false = the
 * ordinary decision applies (always-confirm classes still ask).
 */
export function fullAccessAllows(
  actionClass: ActionClass,
  action: string,
  args: Record<string, unknown> = {},
): boolean {
  if (OUTWARD.includes(actionClass) || actionClass === "read") return false;
  const cmd = shellCommandOf(action, args);
  if (actionClass === "write" || actionClass === "execute" || actionClass === "network")
    return cmd === undefined || lineAllowed(cmd);
  if (actionClass === "publish") return cmd !== undefined && lineAllowed(cmd);
  if (actionClass === "delete") {
    if (cmd !== undefined) return lineAllowed(cmd);
    // An ACP agent's native file delete (its `kind`), never a connected app's tool.
    return args.kind === "delete" && !action.startsWith("mcp__") && !action.startsWith("mcp:");
  }
  return false;
}
