/**
 * Turn pipeline contract.
 * One turn = an explicit sequence of phases; each phase is a function that
 * returns a verdict instead of mutating shared state in place. The runner
 * (`runner.ts`) is the only thing that sequences them.
 */

export const TURN_PHASES = [
  "prepare",
  "recall",
  "infer",
  "plan_tools",
  "gate",
  "execute",
  "reflect",
  "persist",
] as const;

export type TurnPhase = (typeof TURN_PHASES)[number];

export type HaltReason = "completed" | "failed" | "cancelled" | "interrupted" | "max_turns" | "loop_guard";

export type PhaseVerdict<S> =
  | { kind: "continue"; state: S }
  /** Skip straight to a later phase (e.g. no tool calls → reflect). */
  | { kind: "jump"; to: TurnPhase; state: S }
  /** Pause for a human (approval card, question card, handoff); the same phase runs again afterwards. */
  | { kind: "await"; reason: "approval" | "question" | "handoff"; waitFor: readonly string[]; state: S }
  /** Only from `reflect`: start another engine pass at `infer` (bounded by max passes and the loop guard). */
  | { kind: "repeat"; state: S }
  /** Stop the turn; the runner still runs `persist` to close it. */
  | { kind: "halt"; reason: HaltReason; state: S };

export interface PhaseContext {
  threadId: string;
  runId: string;
  /** True when a person is watching; loop guard warns instead of hard-stopping. */
  attended: boolean;
  signal: AbortSignal;
}

export type PhaseHandler<S, C extends PhaseContext = PhaseContext> = (
  state: S,
  ctx: C,
) => Promise<PhaseVerdict<S>>;

export type TurnPipeline<S, C extends PhaseContext = PhaseContext> = {
  readonly [P in TurnPhase]: PhaseHandler<S, C>;
};

/** Phases may only jump forward; jumping back would let a turn loop forever. */
export function isForwardJump(from: TurnPhase, to: TurnPhase): boolean {
  return TURN_PHASES.indexOf(to) > TURN_PHASES.indexOf(from);
}

export function nextPhase(p: TurnPhase): TurnPhase | undefined {
  return TURN_PHASES[TURN_PHASES.indexOf(p) + 1];
}
