/** A completion claim that is not negated (沒有完成／無法完成 are honest) or quoted (不要說「完成了」). */
const DONE_CLAIM =
  /(?<![沒未無不「『"])(?<!沒有)(?<!無法)(?<!還沒)(已經完成|已完成|完成了|做完了|辦好了|搞定|成功了|順利完成|都做了|做好了|都做好|處理好了|弄好了)/;
/**
 * O5b: the same claim in English (a reply follows the user's language),
 * unless negated. Review #15: narrowed to a claim about the work as a whole
 * ("it's done", "all done", "I've completed …", "successfully finished") —
 * a bare "finished" / "completed" is also how an honest report reads ("the
 * worker finished, but the build failed", "3 of 5 steps completed").
 */
const DONE_CLAIM_EN =
  /\b(?:all done|both done|(?:it|that|this|everything|work|task|tasks|job|change|changes)(?:'s| is| are| has been| have been) (?:all )?done|(?:i|we|it|they)(?:'ve| have|'s| has) (?:now )?(?:successfully )?(?:completed|finished|done) (?:it|them|that|this|both|all|everything|the\b)|successfully (?:completed|finished|done)|(?:completed|finished|done) successfully)\b/i;
/** A sentence that also says something went wrong is an honest report, not a done claim. */
const CONTRAST_EN =
  /\b(?:but|however|except|although|though|yet|fail(?:ed|s|ure)?|error|couldn't|could not|didn't|did not|not|never|unable)\b|n't\b/i;
const claimsDoneEn = (r: string) =>
  r.split(/(?<=[.!?;])\s+|\n+/u).some((s) => DONE_CLAIM_EN.test(s) && !CONTRAST_EN.test(s));
const claimsDone = (r: string) => DONE_CLAIM.test(r) || claimsDoneEn(r);
/** The note follows the reply's language: English when the reply has no CJK at all. */
const english = (replies: readonly string[]) => {
  const all = replies.join("\n");
  return (
    /[A-Za-z]/u.test(all) &&
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(all)
  );
};

/**
 * The router answered a failed worker's report with "done" (C2): the note the
 * core adds under its reply, or undefined when the reply is honest or the
 * turn was not about a failed worker.
 */
export function failedWorkerNote(input: string, replies: readonly string[]): string | undefined {
  const head = /^<alca:worker [^>]*>/m.exec(input)?.[0];
  if (!head || !/ ok="false"/.test(head)) return undefined;
  if (!replies.some(claimsDone)) return undefined;
  const en = english(replies);
  const title = /title="([^"]*)"/.exec(head)?.[1] ?? (en ? "task" : "工作");
  const why =
    /^失敗的步驟：(.+)$/m.exec(input)?.[1] ??
    /^停止原因：(.+)$/m.exec(input)?.[1] ??
    /^結果：(.+?)。/m.exec(input)?.[1] ??
    (en ? "a step failed" : "有步驟失敗");
  return en
    ? `Alca note: the worker "${title}" did not actually succeed (${why.slice(0, 200)}). The "done" above is not correct.`
    : `Alca 註記：工人「${title}」其實沒有做成（${why.slice(0, 200)}）。上面說的「完成」不正確。`;
}
