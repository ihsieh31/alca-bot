// Mac test 2026-11 B6: a worker report in the chat, in plain words. The
// router reads the report with its internal labels (status=…, NEEDS_INPUT n,
// its own instructions); the person's card shows the worker's words, the
// questions and what it needs, never those labels. Pure, unit-tested in Node.

/** The card's headline word and colour for a report (`status` / `ok` / `report` attributes). */
import { t } from "./i18n/index.ts";
export function reportWord(
  status: string,
  ok: string | undefined,
  report: string | undefined,
): {
  word: string;
  tone: string;
} {
  if (status === "succeeded" && report && report !== "done") {
    const r = HARNESS_REPORT[report];
    if (r) return r;
  }
  const s = status === "succeeded" && ok === "false" ? "failed" : status;
  return { word: REPORT_WORD[s] ?? t("desktop.reportText.ended"), tone: s };
}

const REPORT_WORD: Record<string, string> = {
  succeeded: t("common.done"),
  failed: t("common.notFinished"),
  stopped: t("common.stopped"),
  needs_review: t("common.needsYourConfirmation"),
  expired: t("desktop.reportText.sQuestionExpired"),
};

const HARNESS_REPORT: Record<string, { word: string; tone: string }> = {
  needs_input: { word: t("desktop.reportText.hasAQuestionForYou"), tone: "waiting" },
  partial: { word: t("desktop.reportText.onlyPartlyDone"), tone: "needs_review" },
  blocked: { word: t("common.stuck"), tone: "needs_review" },
  unverified: { word: t("desktop.reportText.doneButFailedVerification"), tone: "needs_review" },
};

/** Lines meant for the router only (its instructions), never shown on the card. */
const ROUTER_ONLY = [
  /^這些題目/,
  /^這是工人的說法/,
  /^相鄰：/,
  // O5b: the router's verdict line; the card already says it with its status word.
  /^結果：.*不是完成（not done）。$/,
];

/** One report line as the person reads it; undefined = not shown. */
export function reportLine(line: string): string | undefined {
  const l = line.trim();
  if (!l || ROUTER_ONLY.some((r) => r.test(l))) return undefined;
  const words = /^工人原話（[^）]*）：([\s\S]*)$/.exec(l);
  if (words) return words[1]?.trim() || undefined;
  const q = /^NEEDS_INPUT (\d+)(（只有本人能答）)?：(.*?)(；選項（第一個是推薦）：(.*))?$/.exec(l);
  if (q)
    return t("desktop.reportText.question", {
      p0: q[1],
      p1: q[3],
      p2: q[5] ? t("desktop.reportText.options", { p0: q[5] }) : "",
    });
  return l
    .replace(/^自稱的改動：/, "改動：")
    .replace(/^宣稱：/, "說明：")
    .replace(/^停止原因：watchdog\.[a-z_]+: /, "看門狗停下：")
    .replace(/^停止原因：user$/, "你停下了它。")
    .replace(/^結果摘要（全文 \d+ 字，未放進這裡）：/, "")
    .replace(/[（(]?status=[a-z_]+[）)]?/g, "")
    .trim();
}
