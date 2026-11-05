import { createHash } from "node:crypto";
import { type LoopGuardPolicy, loopGuardVerdict } from "@alca/tools";
import { changesFiles, commandOf, isCheckCommand, POLL_TOOLS } from "./harness/actions.ts";

export type LoopPattern = "repeated_failure" | "ab_cycle" | "no_progress";

export interface GuardVerdict {
  kind: "ok" | "warn" | "stop";
  pattern?: LoopPattern;
  repeats: number;
  /** True the first time this pattern reaches this level (emit a warning once, not every call). */
  fresh: boolean;
}

export interface ObservedCall {
  tool: string;
  args: unknown;
  ok: boolean;
  output: string;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function callSignature(tool: string, args: unknown): string {
  return hash(`${tool}\u0000${stable(args)}`);
}

/** A call and what it returned: two of these are equal only when the result did not change. */
export function outcomeKey(sig: string, ok: boolean, output: string): string {
  return `${sig}:${ok ? 1 : 0}:${hash(output)}`;
}

/** A known check command (tests, typecheck, lint) that came back red: a normal failure, not being stuck. */
function redCheck(call: ObservedCall): boolean {
  if (call.ok && !/\bexit(?:\s*code)?\s*[:=]?\s*[1-9]/i.test(call.output)) return false;
  const args = (call.args ?? {}) as Record<string, unknown>;
  const c = commandOf(call.tool, args);
  return c !== undefined && isCheckCommand(c);
}

/**
 * Detects a turn going in circles (plan §2.4: the one set of stop rules).
 * Everything is judged on "call signature + result hash": a call only counts
 * as a repeat when its result did not change either.
 *
 * - repeated_failure: the same call failing again and again, in a row (a
 *   success in between starts over). A known check command that comes back
 *   red (tests, typecheck, lint) is a normal failure and does not count.
 * - ab_cycle: two different (call, result) pairs alternating A, B, A, B …
 * - no_progress: (call, result) pairs already seen. A poll of a background
 *   process whose output changed is never a repeat; a change to the files
 *   (an edit) is new information and clears what was seen.
 *
 * Each pattern's count goes through the shared thresholds: a person watching
 * gets warnings (from the 3rd); an unattended run is hard-stopped (the 6th).
 */
export class LoopGuard {
  private readonly policy: LoopGuardPolicy;
  private readonly attended: boolean;
  private readonly sigs: string[] = [];
  private readonly seenOutcomes = new Set<string>();
  private failStreak = 0;
  private lastFailSig: string | undefined;
  private staleStreak = 0;
  private readonly lastPoll = new Map<string, string>();
  private readonly reported = new Map<LoopPattern, GuardVerdict["kind"]>();

  constructor(policy: LoopGuardPolicy, attended: boolean) {
    this.policy = policy;
    this.attended = attended;
  }

  observe(call: ObservedCall): GuardVerdict {
    const sig = callSignature(call.tool, call.args);
    const outcome = outcomeKey(sig, call.ok, call.output);
    const args = (call.args ?? {}) as Record<string, unknown>;
    const pollMoved = POLL_TOOLS.has(call.tool) && this.lastPoll.get(sig) !== outcome;
    if (POLL_TOOLS.has(call.tool)) this.lastPoll.set(sig, outcome);

    if (redCheck(call)) {
      // a red test / build: neither stuck nor progress for the failure count
    } else if (!call.ok && sig === this.lastFailSig) this.failStreak += 1;
    else this.failStreak = call.ok ? 0 : 1;
    if (!redCheck(call)) this.lastFailSig = call.ok ? undefined : sig;

    if (changesFiles(call.tool, args, call.ok)) {
      // the files changed: earlier results may legitimately come back
      this.seenOutcomes.clear();
      this.staleStreak = 0;
    } else if (pollMoved || !this.seenOutcomes.has(outcome)) {
      this.seenOutcomes.add(outcome);
      this.staleStreak = 0;
    } else this.staleStreak += 1;
    if (!pollMoved) this.sigs.push(outcome);

    const counts: Array<[LoopPattern, number]> = [
      ["repeated_failure", this.failStreak],
      ["ab_cycle", this.cycleCount()],
      ["no_progress", this.staleStreak],
    ];
    let best: GuardVerdict = { kind: "ok", repeats: 0, fresh: false };
    for (const [pattern, repeats] of counts) {
      const kind = loopGuardVerdict(repeats, this.attended, this.policy);
      const rank = { ok: 0, warn: 1, stop: 2 } as const;
      if (
        rank[kind] > rank[best.kind] ||
        (rank[kind] === rank[best.kind] && repeats > best.repeats && kind !== "ok")
      ) {
        best = { kind, pattern, repeats, fresh: false };
      }
    }
    if (best.pattern && best.kind !== "ok") {
      const prev = this.reported.get(best.pattern);
      best.fresh = prev !== best.kind;
      this.reported.set(best.pattern, best.kind);
    }
    return best;
  }

  /** Number of completed A,B cycles at the end of the history (A ≠ B). */
  private cycleCount(): number {
    const s = this.sigs;
    const n = s.length;
    if (n < 4) return 0;
    const a = s[n - 2];
    const b = s[n - 1];
    if (a === b) return 0;
    let len = 0;
    for (let i = n - 1; i >= 0; i--) {
      const expect = (n - 1 - i) % 2 === 0 ? b : a;
      if (s[i] !== expect) break;
      len++;
    }
    // Two calls per cycle; the first pair is the pattern itself, so repeats = cycles - 1.
    return Math.max(0, Math.floor(len / 2) - 1);
  }
}
