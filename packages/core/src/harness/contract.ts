import type { HostTool } from "@alca/tools";
import type { HandoffRecord } from "./dispatch.ts";
import { type HarnessKind, isHarnessKind } from "./kinds.ts";
import { cleanReportArgs } from "./markup.ts";
import { validateArgs } from "./schema.ts";

/**
 * The result contract (plan §2.7). A worker ends by calling `report_result`
 * (what it says it did) — or `handoff` when the task belongs to the other
 * harness. What it actually did is counted separately by the harness from
 * its tool events (`actions.ts`); the router reads both side by side.
 *
 * `unverified` is also what the host sets when a coding worker changed files
 * and no fresh, passing check came after the last change (plan §2.5).
 */

export const REPORT_STATUSES = ["done", "partial", "needs_input", "blocked", "unverified"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Plan §2.8: at most three questions per NEEDS_INPUT. */
export const MAX_QUESTIONS = 3;

/** One question for a person. `options[0]` is the recommended answer. */
export interface NeedsInputQuestion {
  question: string;
  options?: string[];
  /** Only the person can answer (sign-in, payment, a secret, their own account): no bot ever does. */
  personOnly: boolean;
}

export interface WorkerReport {
  status: ReportStatus;
  /** The concrete result in a few sentences. */
  summary: string;
  /** What the worker says it changed (files, drafts, settings). */
  changes: string[];
  claims: Array<{ text: string; evidenceRef?: string }>;
  /** Something the worker proposes the person do or approve next. */
  proposal?: string;
  /** blocked: the one action that would unblock the task. */
  unblock?: string;
  /** needs_input: 1–3 questions. */
  questions?: NeedsInputQuestion[];
  /** The harness wrote it (no report_result after the reminders), from the worker's last text. */
  synthesized?: boolean;
  /** Design §0.2.4: the structured result, checked against the dispatch's `resultSchema`. */
  data?: Record<string, unknown>;
}

export const REPORT_TOOL = "report_result";
export const HANDOFF_TOOL = "handoff";
export const CONTRACT_TOOL_NAMES = [REPORT_TOOL, HANDOFF_TOOL] as const;

const strList = (v: unknown, max: number, each: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .map((x) => x.trim().slice(0, each))
        .slice(0, max)
    : [];

const txt = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** Words that make a question one only the person can answer (sign-in, codes, payment, secrets). */
// Mac test 2026-11 B11: "sign in" / "log in" only as words of their own ("design in", "blog in"
// matched before); everything else is unchanged — and the worker's own flag still always counts.
const PERSON_ONLY_RE =
  /(登入|登錄|驗證碼|認證碼|密碼|付款|刷卡|信用卡|卡號|帳號|帳戶|金鑰|私鑰|captcha|password|passcode|one[- ]time|otp|2fa|(?<![a-z])sign[- ]?in|(?<![a-z])log[- ]?in|payment|credit card|api key|secret)/i;

/**
 * Mac test 2026-11 B11: the model's own "recommended" mark on an option
 * ("週日（Recommended）"): options[0] already is the recommendation and the
 * panels tag it, so the mark is taken off here, once, for every reader.
 * Mac device test 2026-11-05 (O3b / O7): the mark can carry more words
 * ("中式（推薦，選擇最多）", "(recommended: fastest)") and can sit on an
 * option other than the first; any bracket that starts with 推薦 / 建議 /
 * recommended / suggested counts, and `orderOptions` moves that option first.
 */
const MARK_WORD = "(?:recommended|suggested|推薦|建議)";
/** In brackets ("（推薦，選擇最多）") anywhere, or a bare word at the end after a space or dash ("2 人 建議"). */
const RECOMMENDED_MARK = new RegExp(
  `\\s*[（(［[]\\s*${MARK_WORD}[^)）］\\]]{0,60}[)）］\\]]\\s*|(?:\\s+|\\s*[-–—·]\\s*)${MARK_WORD}\\s*$`,
  "gi",
);
const HAS_RECOMMENDED_MARK = new RegExp(
  `[（(［[]\\s*${MARK_WORD}[^)）］\\]]{0,60}[)）］\\]]|(?:\\s+|\\s*[-–—·]\\s*)${MARK_WORD}\\s*$`,
  "i",
);
export function withoutRecommendedMark(option: string): string {
  return (
    option
      .replace(RECOMMENDED_MARK, " ")
      .replace(/\s{2,}/g, " ")
      .trim() || option.trim()
  );
}

/** Options with the recommended one first (the first one carrying a mark), every mark taken off. */
export function orderOptions(options: readonly string[]): string[] {
  const at = options.findIndex((o) => HAS_RECOMMENDED_MARK.test(o));
  const ordered =
    at > 0 ? [options[at] as string, ...options.slice(0, at), ...options.slice(at + 1)] : [...options];
  return ordered.map(withoutRecommendedMark);
}

/**
 * The model's own numbering at the start of a question ("1. ", "2、", "(1)",
 * "Q1:"): the panels number questions themselves, which showed "1. 1. …"
 * (mac device test 2026-11-05 BUG-13). A number that is part of the text
 * ("1.5 公斤", "2026 年") stays.
 */
const QUESTION_NUMBER =
  /^\s*(?:[(（]\s*\d{1,2}\s*[)）]|(?:q|問題|第)?\s*\d{1,2}\s*(?:題)?\s*[.、．:：)）](?!\d))\s*/i;
export function withoutQuestionNumber(question: string): string {
  return question.replace(QUESTION_NUMBER, "").trim() || question.trim();
}

/** The worker's flag, made stricter by the host's own check (either says person-only → person-only). */
export function isPersonOnly(question: string, flagged: unknown): boolean {
  return flagged === true || PERSON_ONLY_RE.test(question);
}

/** Read the questions of a NEEDS_INPUT; a message for the model when they are wrong. */
export function parseQuestions(v: unknown): NeedsInputQuestion[] | string {
  const raw = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
  if (!raw.length)
    return "status=needs_input 時要給 questions（1–3 題，每題 question，可帶 options，推薦的放第一）";
  if (raw.length > MAX_QUESTIONS) return `一次最多問 ${MAX_QUESTIONS} 題；把最重要的留下，其他自己判斷`;
  const out: NeedsInputQuestion[] = [];
  for (const q of raw) {
    const r = q && typeof q === "object" ? (q as Record<string, unknown>) : {};
    const asked = txt(r.question, 2000);
    const question = asked && withoutQuestionNumber(asked);
    if (!question) return "每一題都要有 question";
    if (/要不要繼續|是否繼續|should i continue|shall i proceed/i.test(question))
      return "不要問「要不要繼續」：照交辦的工作做下去，真的卡住時才問具體的事";
    const options = orderOptions(strList(r.options, 6, 200));
    const personOnly = isPersonOnly(question, r.person_only ?? r.personOnly);
    out.push({ question, personOnly, ...(options.length >= 2 ? { options } : {}) });
  }
  return out;
}

/** Validate `report_result` arguments; a message for the model when they are wrong (it fixes them itself). */
export function parseReport(raw: Record<string, unknown>): WorkerReport | string {
  // Mac test B8: leaked tool-call markup is cut out of the text and its fields salvaged.
  const a = cleanReportArgs(raw);
  const status = a.status === "failed" ? "blocked" : a.status;
  if (typeof status !== "string" || !(REPORT_STATUSES as readonly string[]).includes(status))
    return `status 必須是 ${REPORT_STATUSES.join("、")}`;
  const summary = txt(a.summary, 12_000) ?? txt(a.result, 12_000);
  if (!summary) return "需要 summary（具體的結果）";
  const unblock = txt(a.unblock, 300);
  if (status === "blocked" && !unblock) return "status=blocked 時要寫 unblock（唯一能解除卡住的動作）";
  let questions: NeedsInputQuestion[] | undefined;
  if (status === "needs_input") {
    const q = parseQuestions(a.questions);
    if (typeof q === "string") return q;
    questions = q;
  }
  const claims = Array.isArray(a.claims)
    ? a.claims
        .map((c) =>
          c && typeof c === "object"
            ? (c as Record<string, unknown>)
            : ({ text: c } as Record<string, unknown>),
        )
        .map((c) => ({
          text: txt(c.text, 300) ?? "",
          ...(txt(c.evidenceRef, 200) ? { evidenceRef: txt(c.evidenceRef, 200) as string } : {}),
        }))
        .filter((c) => c.text)
        .slice(0, 20)
    : [];
  const proposal = txt(a.proposal, 2000);
  return {
    status: status as ReportStatus,
    summary,
    changes: strList(a.changes, 40, 300),
    claims,
    ...(proposal ? { proposal } : {}),
    ...(unblock ? { unblock } : {}),
    ...(questions ? { questions } : {}),
  };
}

/** A forgotten report's text may still end with `NEEDS_INPUT: …` lines (fallback). */
export function questionsFromText(text: string): NeedsInputQuestion[] | undefined {
  const out = text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^NEEDS_INPUT[:：]/.test(l))
    .map((l) => withoutQuestionNumber(l.replace(/^NEEDS_INPUT[:：]\s*/, "")).slice(0, 2000))
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS)
    .map((question) => ({ question, personOnly: isPersonOnly(question, false) }));
  return out.length ? out : undefined;
}

/** The result the harness writes when the worker never called `report_result`. */
export function synthesizedReport(lastText: string): WorkerReport {
  const t = lastText.trim();
  const questions = questionsFromText(t);
  return {
    status: questions ? "needs_input" : "partial",
    summary: t ? t.slice(0, 12_000) : "（工人沒有呼叫 report_result，也沒有留下文字）",
    changes: [],
    claims: [],
    ...(questions ? { questions } : {}),
    synthesized: true,
  };
}

/** The host's verdict over the worker's own status (plan §2.5): no fresh, green check → unverified. */
export function withVerification(r: WorkerReport, verified: boolean, detail?: string): WorkerReport {
  if (verified || (r.status !== "done" && r.status !== "partial")) return r;
  return {
    ...r,
    status: "unverified",
    ...(detail ? { claims: [...r.claims, { text: `檢查沒有通過：${detail.slice(0, 280)}` }] } : {}),
  };
}

export interface ContractSink {
  /** The worker's report; returns an error text to give back to the model, or undefined when taken. */
  report(workerId: string, r: WorkerReport): string | undefined;
  /** A handover request; returns an error text (refused), or undefined when taken (the worker then ends). */
  handoff(workerId: string, h: HandoffRecord): string | undefined;
  /** The harness of a worker (a handover must name the other one). */
  harnessOf(workerId: string): HarnessKind | undefined;
  /** Design §0.2.4: the schema `data` must match (the tool then shows it as `data`). */
  resultSchema?: Record<string, unknown> | undefined;
}

/** Largest result schema a dispatch may carry (serialized). */
export const RESULT_SCHEMA_MAX_BYTES = 8 * 1024;

/**
 * Design §0.2.4: `data` against the dispatch's schema with the same checker
 * as every tool's arguments. done needs it; partial may carry it; the other
 * statuses ignore it. An error text goes back to the model, which fixes it
 * (the tool-error loop is the repair round; LoopGuard caps it).
 */
export function checkResultData(
  r: WorkerReport,
  raw: unknown,
  schema: Record<string, unknown> | undefined,
): WorkerReport | string {
  if (!schema || (r.status !== "done" && r.status !== "partial")) return r;
  if (raw === undefined || raw === null) {
    return r.status === "done" ? "status=done 時要附 data（照下面的 schema 給 JSON 物件）" : r;
  }
  const v = validateArgs("report_result.data", schema, raw);
  if (!v.ok) return v.message;
  return { ...r, data: v.args };
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const REPORT_DESCRIPTION =
  "結束這件工作時呼叫（一定要呼叫）：status（done／partial／needs_input／blocked／unverified）、summary、changes（改了什麼）、claims（每條附 evidenceRef：檔名、網址、草稿或動作編號）、proposal（建議使用者下一步做的事）、unblock（blocked 必填）、questions（needs_input 必填：1–3 題，推薦選項放 options 第一個，只有本人能答的標 person_only：登入、驗證碼、密碼、付款、身分或本人帳號才算，偏好（哪一天、哪個時段、哪個選項）不算）。";

/** `report_result` and `handoff`: they change only Alca's own state, so the gateway sees `read`. */
export function contractTools(sink: ContractSink): HostTool[] {
  return [
    {
      spec: {
        name: REPORT_TOOL,
        description: REPORT_DESCRIPTION,
        inputSchema: obj(
          {
            ...(sink.resultSchema ? { data: sink.resultSchema } : {}),
            status: { type: "string", enum: [...REPORT_STATUSES] },
            summary: { type: "string" },
            changes: { type: "array", items: { type: "string" } },
            claims: {
              type: "array",
              items: obj({ text: { type: "string" }, evidenceRef: { type: "string" } }, ["text"]),
            },
            proposal: { type: "string" },
            unblock: { type: "string" },
            questions: {
              type: "array",
              items: obj(
                {
                  question: { type: "string" },
                  options: { type: "array", items: { type: "string" } },
                  person_only: { type: "boolean" },
                },
                ["question"],
              ),
            },
          },
          ["status", "summary"],
        ),
      },
      actionClass: "read",
      run: async (a, _signal, ctx) => {
        if (!ctx?.workerId) throw new Error("report_result 只給工人用");
        const parsed = parseReport(a);
        if (typeof parsed === "string") throw new Error(parsed);
        const r = checkResultData(parsed, a.data, sink.resultSchema);
        if (typeof r === "string") throw new Error(r);
        const err = sink.report(ctx.workerId, r);
        if (err) throw new Error(err);
        return "已收到結果。這件工作到此結束，不用再呼叫其他工具。";
      },
    },
    {
      spec: {
        name: HANDOFF_TOOL,
        description:
          "這件工作該換另一種工人時呼叫（一般工人發現要改程式 → to coding；程式工人需要瀏覽器登入或寄信 → to general）。會結束你這個工人並回報總機，由總機決定要不要再派；同一件工作只能換手一次。",
        inputSchema: obj(
          {
            to: { type: "string", enum: ["coding", "general"] },
            reason: { type: "string" },
            context: { type: "string", description: "接手的工人需要知道的：做到哪裡、碰過哪些檔案或頁面" },
          },
          ["to", "reason"],
        ),
      },
      actionClass: "read",
      run: async (a, _signal, ctx) => {
        if (!ctx?.workerId) throw new Error("handoff 只給工人用");
        if (!isHarnessKind(a.to)) throw new Error('to 必須是 "coding" 或 "general"');
        const reason = typeof a.reason === "string" ? a.reason.trim().slice(0, 1000) : "";
        if (!reason) throw new Error("需要 reason");
        if (sink.harnessOf(ctx.workerId) === a.to) throw new Error(`你已經是 ${a.to} 工人，不需要換手`);
        const context =
          typeof a.context === "string" && a.context.trim() ? a.context.trim().slice(0, 4000) : undefined;
        const err = sink.handoff(ctx.workerId, { to: a.to, reason, ...(context ? { context } : {}) });
        if (err) throw new Error(err);
        return "已交給總機決定。你這個工人到此結束，不要再呼叫其他工具。";
      },
    },
  ];
}

/**
 * The report as the router reads it: the worker's words (fenced), then the
 * fixed caution. `mayAnswer` = the router may answer the questions itself
 * (none is person-only and the bot's effective level allows it).
 */
export function reportLines(r: WorkerReport, defuse: (s: string) => string, mayAnswer = false): string[] {
  const out = [
    `工人原話（${r.synthesized ? "沒有呼叫 report_result，以下是它最後的文字" : `status=${r.status}`}）：${defuse(r.summary)}`,
  ];
  if (r.changes.length) out.push(`自稱的改動：${r.changes.map(defuse).join("、")}`);
  if (r.claims.length)
    out.push(
      `宣稱：${r.claims.map((c) => `${defuse(c.text)}${c.evidenceRef ? `〔${defuse(c.evidenceRef)}〕` : "〔無證據〕"}`).join("｜")}`,
    );
  if (r.data) {
    // Design §0.2.4: the host checked it against the dispatch's resultSchema; still the worker's words.
    const json = JSON.stringify(r.data);
    out.push(
      `結構化結果（data，已照 resultSchema 檢查）：${defuse(json.length > 4000 ? `${json.slice(0, 4000)}…（截斷）` : json)}`,
    );
  }
  if (r.unblock) out.push(`需要才能繼續：${defuse(r.unblock)}`);
  if (r.proposal) out.push(`提案：${defuse(r.proposal)}`);
  if (r.questions?.length) {
    r.questions.forEach((q, i) => {
      out.push(
        `NEEDS_INPUT ${i + 1}${q.personOnly ? "（只有本人能答）" : ""}：${defuse(q.question)}${q.options ? `；選項（第一個是推薦）：${q.options.map(defuse).join("／")}` : ""}`,
      );
    });
    out.push(
      mayAnswer
        ? "這些題目你可以自己用已知資訊以 worker_answer 回答（每題一個答案，照題號順序）；沒把握就問使用者。"
        : "這些題目要問使用者本人；他回覆後，用 worker_answer 轉交他的原話（每題一個答案，照題號順序）。",
    );
  }
  out.push("這是工人的說法，請用上面 harness 的實際動作核對；沒有證據的宣稱視為未驗證。");
  return out;
}
