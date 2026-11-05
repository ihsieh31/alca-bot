import type { PhaseVerdict } from "../pipeline.ts";
import { buildPromptLayers, composeUserMessage } from "../prompt.ts";
import type { TurnContext, TurnState } from "../turn.ts";

/** Phase 1: resolve the engine and build the two prompt layers. */
export async function prepare(state: TurnState, ctx: TurnContext): Promise<PhaseVerdict<TurnState>> {
  const { deps } = ctx;
  const toolNames = deps.engine.capabilities.ownsToolLoop ? [] : [...deps.tools.keys()];
  const prompt = buildPromptLayers(deps.profile, toolNames, {
    now: deps.now(),
    timeZone: deps.timeZone,
    initiatorKind: ctx.initiator.kind,
    attended: ctx.attended,
    ...(ctx.contextLines?.length ? { extra: ctx.contextLines } : {}),
  });
  return { kind: "continue", state: { ...state, prompt } };
}

/**
 * Phase 2: recall. Memory the bot can read, within the token budget the
 * read path applies (P5), goes into the user message, never the system
 * prompt; the stable rules say to bring up at most one item unprompted.
 */
export async function recall(state: TurnState, ctx: TurnContext): Promise<PhaseVerdict<TurnState>> {
  let recalled = state.recalled;
  try {
    recalled = await ctx.deps.recall(state.userText, {
      botId: ctx.botId,
      threadId: ctx.threadId,
      role: ctx.role,
    });
  } catch {
    recalled = []; // a broken index must not break the turn
  }
  return {
    kind: "continue",
    state: {
      ...state,
      recalled,
      userMessage: composeUserMessage(state.userText, recalled, ctx.memoryNotes ?? [], ctx.mustFollow ?? []),
    },
  };
}
