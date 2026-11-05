// Tool registry (progressive disclosure), path-aware scheduling, loop guard.

export * from "./contracts.ts";
export * from "./fence.ts";
export * from "./registry.ts";

export type ToolActionClass =
  | "read"
  | "write"
  | "execute"
  | "network"
  | "payment"
  | "send"
  | "delete"
  | "publish";

export interface ToolDefinition {
  name: string;
  /** One line shown by tool search; full schema only on describe (progressive disclosure). */
  summary: string;
  inputSchema: Record<string, unknown>;
  actionClass: ToolActionClass;
  source: "builtin" | "mcp" | "script";
}

/** Paths a single call will read or write, declared before it runs. */
export interface PathClaims {
  reads: readonly string[];
  writes: readonly string[];
}

/** Read side of a registry: what an engine sees before it picks a tool. */
export interface ToolRegistry {
  search(query: string, limit?: number): Promise<Pick<ToolDefinition, "name" | "summary">[]>;
  describe(name: string): Promise<ToolDefinition | undefined>;
}

export interface LoopGuardPolicy {
  warnAfterRepeats: number;
  hardStopAfterRepeats: number;
}

const norm = (p: string) => p.replace(/\/+$/, "") || "/";
const overlaps = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`) || x === "/" || y === "/";
};

/** Two calls may run in parallel unless one writes a path (or ancestor) the other touches. */
export function canRunInParallel(a: PathClaims, b: PathClaims): boolean {
  for (const w of a.writes) for (const p of [...b.reads, ...b.writes]) if (overlaps(w, p)) return false;
  for (const w of b.writes) for (const p of a.reads) if (overlaps(w, p)) return false;
  return true;
}

/**
 * Loop guard verdict for N identical consecutive calls.
 * Attended (someone watching): only warn. Unattended: hard stop.
 */
export function loopGuardVerdict(
  repeats: number,
  attended: boolean,
  policy: LoopGuardPolicy,
): "ok" | "warn" | "stop" {
  if (repeats >= policy.hardStopAfterRepeats) return attended ? "warn" : "stop";
  if (repeats >= policy.warnAfterRepeats) return "warn";
  return "ok";
}
