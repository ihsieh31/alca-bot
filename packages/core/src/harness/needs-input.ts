import { defuseAlcaTags } from "@alca/tools";
import type { NeedsInputQuestion } from "./contract.ts";

/**
 * Plan §2.8: who answers a worker's NEEDS_INPUT, and when a question expires.
 *
 * - A person-only question (sign-in, payment, a secret, the person's own
 *   account, a code) → always the person. No bot answers it, at any level.
 * - Otherwise the router may answer itself when the bot's effective level
 *   (its own, or the team's; the strictest in a peer chain) is autonomous or
 *   the bot's own 完全授權 (Phase 5). Person-only questions still go to the person.
 * - Everything else goes to the person; the router relays their words from a
 *   turn the person started.
 * - Text questions (no options) expire after 72 hours; questions with options
 *   never expire.
 */

export type AnswerBy = "user" | "router";

export const TEXT_QUESTION_TTL_MS = 72 * 3600_000;

/** Whether the router may answer these questions itself. */
export function routerMayAnswer(qs: readonly NeedsInputQuestion[], level: string): boolean {
  return (
    qs.length > 0 && !qs.some((q) => q.personOnly) && (level === "autonomous" || level === "full_access")
  );
}

/** When an open NEEDS_INPUT expires (ms since epoch), or null when it never does. */
export function expiresAt(qs: readonly NeedsInputQuestion[], askedAt: number): number | null {
  return qs.some((q) => !q.options?.length) ? askedAt + TEXT_QUESTION_TTL_MS : null;
}

/**
 * Whether an answer handed in by the router is acceptable. `turnInitiator` is
 * who started the router turn that calls `worker_answer`: a person's own
 * message relays their answer; any other turn (a worker report, a trigger)
 * is the router answering by itself.
 */
export function answerRefusal(
  qs: readonly NeedsInputQuestion[],
  answers: readonly string[],
  turnInitiator: string,
  level: string,
): string | undefined {
  if (answers.length !== qs.length)
    return `要回答 ${qs.length} 題（照題號順序，每題一個答案），收到 ${answers.length} 個`;
  if (answers.some((a) => !a.trim())) return "每一題都要有答案";
  if (turnInitiator === "user") return undefined;
  if (qs.some((q) => q.personOnly))
    return "有題目只有使用者本人能回答（登入、付款、密碼、驗證碼、本人帳號）；請問使用者，等他回覆後再轉交他的原話";
  if (!routerMayAnswer(qs, level)) return "這個 bot 不是自主等級：請問使用者，等他回覆後再轉交答案";
  return undefined;
}

/** The task a continuation worker gets after an answer. */
export function answeredGoal(
  goal: string,
  qs: readonly NeedsInputQuestion[],
  answers: readonly string[],
  by: AnswerBy,
): string {
  const who = by === "router" ? "總機代答" : "使用者回答";
  return [
    goal,
    "",
    `上一個工人問了 ${qs.length} 題，回答（${who}）：`,
    ...qs.map((q, i) => `${i + 1}. ${defuseAlcaTags(q.question)} → ${defuseAlcaTags(answers[i] ?? "")}`),
    "照這些回答接著做；前手已經做過、已生效的步驟不要重做，先用 history_search 看前手做了什麼、再檢查現況。",
  ].join("\n");
}
