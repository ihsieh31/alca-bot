import type { WorkerGrants } from "@alca/store";
import type { PromptLanguage } from "../conversation-rules.ts";
import { RESULT_SCHEMA_MAX_BYTES } from "./contract.ts";
import { type BudgetOverride, type HarnessKind, isHarnessKind, parseBudgetOverride } from "./kinds.ts";
import { readResultSchema } from "./schema.ts";

/**
 * Plan §2.1 / §6 (Phase 5): how the router (總機) dispatches to a harness.
 * `worker_start` may name the harness; when it does not, the host picks it
 * in this order: the bot's own default (bot settings) → a heuristic (a
 * `workdir`, or a goal about code, files or a repo → coding) → general. The
 * host then checks the engine's capabilities. Handover between harnesses is
 * a report to the router, never an automatic chain, and a task hands over at
 * most once (A3).
 */

/**
 * Router prompt lines (stable layer, one fixed copy per language): how to
 * choose (A2), with fictional examples either way.
 */
export const HARNESS_CHOICE_RULES: Readonly<Record<PromptLanguage, readonly string[]>> = Object.freeze({
  zh: Object.freeze([
    "派工時選 harness：要改程式或檔案內容、跑測試或建置、看 repo → coding；網頁與瀏覽器、連接的 app 或 MCP（含其中的檔案）、查資料、寫文件草稿、排程、整理資料 → general；不確定 → general。沒選時 Alca 依 bot 設定、再依工作內容判斷，最後用 general。可以用 doneWhen 寫一句完成條件。",
    "使用者明說要「程式工人」、coding 或寫程式來做時，一律指定 harness=coding（不要改派一般工人）。",
    "例：「修好 parser 那個失敗的測試」→ coding；「把 README 的安裝步驟改成 pnpm」→ coding；「幫我比價三家飯店並整理成表」→ general；「把這份會議記錄整理成 markdown 存到資料夾」→ general（整理文件不是改程式）；「查一下明天台北的天氣再擬一封信」→ general。",
    '工人回報裡有 handoff="coding" 或 handoff="general" 表示它判斷這件事該換另一種工人：由你決定要不要再派（帶 handoffFrom＝原工人編號）；同一件工作只能換手一次。',
    "worker_start 回「不能做 coding 工作」時，是這個 bot 的引擎不適合：改派給其他 bot，或照實告訴使用者；不要自己換引擎。",
  ]),
  en: Object.freeze([
    "When dispatching, pick a harness: changing code or file contents, running tests or builds, reading a repo → coding; web pages and the browser, connected apps or MCP servers (their files too), research, drafting documents, scheduling, tidying data → general; not sure → general. If you pick none, Alca uses the bot's setting, then the task itself, then general. You may add a one-sentence doneWhen.",
    'When the person explicitly asks for a coding worker, "coding", or for it to be done by writing code, always set harness=coding (never dispatch a general worker instead).',
    'Examples: "fix the failing parser test" → coding; "change the README install steps to pnpm" → coding; "compare three hotels and put them in a table" → general; "turn these meeting notes into markdown in the folder" → general (tidying a document is not changing code); "check tomorrow\'s weather in Taipei, then draft an email" → general.',
    'A worker report with handoff="coding" or handoff="general" means the worker thinks another kind of worker should take over: you decide whether to dispatch again (with handoffFrom = the original worker id); a task hands over at most once.',
    "If worker_start answers that the engine cannot do coding work, this bot's engine does not fit: dispatch to another bot or tell the person plainly; never switch engines yourself.",
  ]),
});

/** Where a dispatch's harness came from (Phase 5). */
export type HarnessSource = "router" | "bot" | "heuristic" | "default";

/** A goal about code, files or a repository (plan §6 heuristic); documents and notes alone are not. */
const CODE_WORDS =
  /程式|原始碼|代碼|檔案|repo|儲存庫|單元測試|跑測試|測試失敗|建置|編譯|函式|重構|\bcode\b|\bsource\b|\bfiles?\b|\brepo(sitory)?\b|\btests?\b|\bbuild\b|\bcompile\b|\bbug\b|\brefactor|\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|c|cpp|h)\b/i;

/**
 * A goal that names a connected app or an MCP server. Only a general worker
 * has the connector tools, so such a goal is general even when it is about
 * files (mac device test 2026-11-05 BUG-3: "use my connected MCP file server
 * to read note.txt" matched 檔案 and went to a coding worker, which has no
 * connector tools).
 */
const CONNECTED_WORDS =
  /\bmcp\b|連接的|已連接|連結的\s*app|\bconnected\s+(apps?|accounts?|servers?|mcp)\b|\bconnectors?\b/i;

/** Plan §6: no harness named and none set for the bot — coding for a workdir or a code-ish goal, else general. */
export function guessHarness(goal: string | undefined, workdir: string | undefined): HarnessKind {
  if (workdir) return "coding";
  if (goal && CONNECTED_WORDS.test(goal)) return "general";
  return goal && CODE_WORDS.test(goal) ? "coding" : "general";
}

export interface HarnessDispatch {
  harness: HarnessKind;
  /** The router did not name a harness: the host picked it (`source` says how). */
  defaulted: boolean;
  source: HarnessSource;
  doneWhen?: string;
  workdir?: string;
  ownsPaths?: string[];
  budget?: BudgetOverride;
  handoffFrom?: string;
  /** Plan §2.5: the dispatch's own check commands (first source of the verification). */
  checks?: string[];
  /** Design §0.2.4: the JSON schema `report_result.data` must match. */
  resultSchema?: Record<string, unknown>;
}

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/**
 * Read the harness fields of a `worker_start` call. Throws on a harness that
 * is not one of the two, or a `resultSchema` outside the supported subset.
 * Unnamed: the bot's default, the heuristic, general.
 */
export function readHarnessDispatch(
  a: Record<string, unknown>,
  o: { botDefault?: HarnessKind | undefined; goal?: string | undefined } = {},
): HarnessDispatch {
  const raw = a.harness;
  if (raw !== undefined && raw !== null && raw !== "" && !isHarnessKind(raw))
    throw new Error(`harness 只能是 "coding" 或 "general"（收到 ${String(raw).slice(0, 40)}）`);
  const named = isHarnessKind(raw);
  const guessed = guessHarness(
    o.goal ?? (typeof a.goal === "string" ? a.goal : undefined),
    text(a.workdir, 1000),
  );
  const source: HarnessSource = named
    ? "router"
    : o.botDefault
      ? "bot"
      : guessed === "coding"
        ? "heuristic"
        : "default";
  const harness: HarnessKind = named ? raw : (o.botDefault ?? guessed);
  const ownsPaths = Array.isArray(a.ownsPaths)
    ? a.ownsPaths
        .filter((p): p is string => typeof p === "string" && !!p.trim())
        .map((p) => p.trim().slice(0, 500))
        .slice(0, 32)
    : [];
  const budget = parseBudgetOverride(a.budget);
  const doneWhen = text(a.doneWhen, 400);
  const workdir = text(a.workdir, 1000);
  const handoffFrom = text(a.handoffFrom, 40);
  const checks = Array.isArray(a.checks)
    ? a.checks
        .filter((c): c is string => typeof c === "string" && !!c.trim())
        .map((c) => c.trim().slice(0, 300))
        .slice(0, 8)
    : [];
  const resultSchema = readResultSchema(a.resultSchema, RESULT_SCHEMA_MAX_BYTES);
  return {
    harness,
    defaulted: !named,
    source,
    ...(doneWhen ? { doneWhen } : {}),
    ...(workdir && harness === "coding" ? { workdir } : {}),
    ...(ownsPaths.length && harness === "coding" ? { ownsPaths } : {}),
    ...(budget ? { budget } : {}),
    ...(handoffFrom ? { handoffFrom } : {}),
    ...(checks.length && harness === "coding" ? { checks } : {}),
    ...(resultSchema ? { resultSchema } : {}),
  };
}

/** The grants part of a dispatch (stored with the worker). */
export function dispatchGrants(d: HarnessDispatch): WorkerGrants {
  return {
    harness: d.harness,
    ...(d.doneWhen ? { doneWhen: d.doneWhen } : {}),
    ...(d.workdir ? { workdir: d.workdir } : {}),
    ...(d.ownsPaths ? { ownsPaths: d.ownsPaths } : {}),
    ...(d.handoffFrom ? { handoffFrom: d.handoffFrom } : {}),
    ...(d.checks ? { checks: d.checks } : {}),
    ...(d.resultSchema ? { resultSchema: d.resultSchema } : {}),
  };
}

/** The harness of a stored worker (workers from before P15 have none: general). */
export function harnessOf(w: { grants?: WorkerGrants | null }): HarnessKind {
  return w.grants?.harness === "coding" ? "coding" : "general";
}

/** JSON-schema properties `worker_start` gains (A1). */
export const HARNESS_START_PROPERTIES: Record<string, unknown> = {
  harness: {
    type: "string",
    enum: ["coding", "general"],
    description: "怎麼選見派工規則；不確定選 general，省略時由 Alca 判斷",
  },
  doneWhen: { type: "string", description: "一句話的完成條件（如「npm test 全過」）" },
  workdir: {
    type: "string",
    description: "coding：在 bot 工作資料夾的哪個子資料夾（預設整個）",
  },
  ownsPaths: {
    type: "array",
    items: { type: "string" },
    description: "coding 並行時：只能改這些路徑，其他寫入要先問",
  },
  budget: {
    type: "object",
    properties: {
      maxSteps: { type: "integer", minimum: 1 },
      maxWallSec: { type: "integer", minimum: 1 },
      maxTokens: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
    description: "預算覆寫，只能比 bot 的上限低",
  },
  handoffFrom: { type: "string", description: "接手某個工人（wkr_）換手出來的工作時填它的編號" },
  continueDispatch: {
    type: "string",
    description: "續做回報說可續做的派工（dsp_）；其餘欄位沿用原工作",
  },
  checks: {
    type: "array",
    items: { type: "string" },
    description: "coding：改檔後要通過的檢查指令（如 pnpm test）；省略時從 AGENTS.md 或 package.json 找",
  },
  resultSchema: { type: "object", description: "要結構化結果時：data 的 JSON Schema" },
};

export interface HandoffRecord {
  to: HarnessKind;
  reason: string;
  context?: string;
}

/**
 * Whether a new dispatch may take over from `from` (A3): it must be the same
 * bot's worker that asked for a handover, and that worker must not itself have
 * been a handover (one handover per task).
 */
export function checkHandoffDispatch(
  from: { botId: string; grants?: WorkerGrants | null } | undefined,
  botId: string,
  handedOver: HandoffRecord | undefined,
): string | undefined {
  if (!from || from.botId !== botId) return "找不到要接手的工人";
  if (from.grants?.handoffFrom) return "這件工作已經換手過一次，不能再換手；請改成向使用者說明卡在哪裡";
  if (!handedOver) return "那個工人沒有要求換手";
  return undefined;
}
