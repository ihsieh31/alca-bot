import { estimateTokens } from "@alca/memory";
import type { ActionClassT } from "@alca/protocol";
import type { MemoryApplies, MemoryRecord, Store } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";

/**
 * P14 B2: the person's standing instructions for a kind of action
 * (「寫信不要提到我的學校」 → send_message) are not left to search. When a
 * worker's task (or the person's message to the router) is about that kind
 * of action, the matching memories go into the request, fenced as
 * `<alca:must-follow>`: at most five, within 200 tokens, on top of the
 * recall budget. An approval card for that kind of action names them
 * (「已套用：…」) so the person sees what was put in front of the worker.
 */

export const MUST_FOLLOW_MAX = 5;
export const MUST_FOLLOW_TOKENS = 200;

/** The kind of action a gated call is (its action class, or the tool itself for drafts). */
export function appliesForCall(actionClass: ActionClassT | string, tool: string): MemoryApplies[] {
  if (tool === "draft_save") return ["send_message"];
  if (actionClass === "send") return ["send_message"];
  if (actionClass === "publish") return ["publish"];
  if (actionClass === "payment") return ["purchase"];
  return [];
}

/** The memories a bot must follow for these kinds of action (its memory mode respected). */
export function mustFollowItems(
  store: Store,
  botId: string,
  kinds: readonly MemoryApplies[],
  mode: "team" | "own" | "off" = "team",
): MemoryRecord[] {
  if (!kinds.length || mode === "off") return [];
  let items = store.memory.applying(botId, kinds, MUST_FOLLOW_MAX * 2);
  if (mode === "own") items = items.filter((m) => m.botId === botId && m.scope === "bot");
  // A 「別再提…」 rule is for the 主動留意 add-on only, not for every action.
  items = items.filter((m) => m.appliesTo.some((a) => a !== "proactive"));
  const out: MemoryRecord[] = [];
  let used = 0;
  for (const m of items) {
    const cost = estimateTokens(m.body) + 2;
    if (used + cost > MUST_FOLLOW_TOKENS) continue;
    used += cost;
    out.push(m);
    if (out.length >= MUST_FOLLOW_MAX) break;
  }
  return out;
}

const unfence = (s: string) => defuseAlcaTags(s).replaceAll("\n", " ");

/** The fenced block for a request; empty when there is nothing to follow. */
export function mustFollowBlock(items: readonly MemoryRecord[]): string {
  if (!items.length) return "";
  return [
    "<alca:must-follow>",
    "使用者對這類動作的固定指示（使用者自己說的，一定要照做）：",
    ...items.map((m) => `- ${unfence(m.body)}`),
    "</alca:must-follow>",
  ].join("\n");
}
