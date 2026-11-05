/**
 * P15 B4 (plan v11.1 §3, which replaces v11's 85 % rule): context size,
 * when to compact, what to prune first and where to cut.
 *
 * - Tokens are estimated CJK-aware: one token per Han / kana / Hangul /
 *   full-width character, four other characters per token, ×1.1 on the
 *   estimated part only.
 * - Compaction starts at `window − max(15 % window, 16k)` (16k only when the
 *   window is ≥ 32k) and, after one, only once the context grew another 5 % of
 *   the window (unless it is over the whole window).
 * - The tail kept verbatim is clamp(20 % window, 8k, 20k).
 * - Two compactions in a row that did not bring the context back under the
 *   ceiling stop the worker (`compactionStalled`).
 */

export const TOKENS = {
  CHARS_PER_TOKEN_LATIN: 4,
  PER_MESSAGE_OVERHEAD: 4,
  IMAGE_TOKENS: 1500,
  ESTIMATE_SAFETY: 1.1,
  RESERVE_SHARE: 0.15,
  RESERVE_MIN: 16_000,
  HYSTERESIS_SHARE: 0.05,
  MAX_INEFFECTIVE_COMPACTIONS: 2,
  KEEP_MIN: 8000,
  KEEP_MAX: 20_000,
  KEEP_SHARE: 0.2,
  /** Share of the ceiling where a summary may be prepared ahead (plan §2.6: 70 %). */
  PREPARE_SHARE: 0.7,
} as const;

const CJK =
  /[\u1100-\u11FF\u2E80-\u2FDF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u31A0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]|[\u{20000}-\u{3FFFF}]/u;

export function estimateText(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / TOKENS.CHARS_PER_TOKEN_LATIN);
}

export interface CtxMessage {
  role: "user" | "assistant" | "toolResult" | "system";
  text: string;
  /** Tool calls an assistant message asked for (ids), and the tool of a result. */
  calls?: string[];
  callId?: string;
  tool?: string;
  images?: number;
  /** A real person's message (not a tool result or an injected note). */
  realUser?: boolean;
  /** The provider's usage reported on this assistant message (input + output + cache). */
  usage?: number;
  summary?: boolean;
  pruned?: boolean;
  id?: string;
}

export function estimateMessage(m: CtxMessage): number {
  return TOKENS.PER_MESSAGE_OVERHEAD + estimateText(m.text) + (m.images ?? 0) * TOKENS.IMAGE_TOKENS;
}

/** Context size: the last trusted usage plus an estimate of what came after it. */
export function contextTokens(
  msgs: readonly CtxMessage[],
  systemTokens = 0,
): { tokens: number; measured: boolean } {
  let anchor = -1;
  for (let i = msgs.length - 1; i >= 0; i--)
    if (msgs[i]?.role === "assistant" && (msgs[i]?.usage ?? 0) > 0) {
      anchor = i;
      break;
    }
  if (anchor < 0) {
    const est = systemTokens + msgs.reduce((n, m) => n + estimateMessage(m), 0);
    return { tokens: Math.ceil(est * TOKENS.ESTIMATE_SAFETY), measured: false };
  }
  const after = msgs.slice(anchor + 1).reduce((n, m) => n + estimateMessage(m), 0);
  return { tokens: (msgs[anchor]?.usage ?? 0) + Math.ceil(after * TOKENS.ESTIMATE_SAFETY), measured: true };
}

/** Where compaction starts for an input window (Infinity when unknown). */
export function ceiling(window: number): number {
  if (window <= 0) return Number.POSITIVE_INFINITY;
  const reserve = Math.max(
    Math.floor(window * TOKENS.RESERVE_SHARE),
    window >= 2 * TOKENS.RESERVE_MIN ? TOKENS.RESERVE_MIN : 0,
  );
  return window - reserve;
}

export function keepTokens(window: number): number {
  if (window <= 0) return TOKENS.KEEP_MAX;
  return Math.min(TOKENS.KEEP_MAX, Math.max(TOKENS.KEEP_MIN, Math.floor(window * TOKENS.KEEP_SHARE)));
}

export interface CompactState {
  tokens: number;
  measured: boolean;
  window: number;
  lastEntryIsCompaction?: boolean;
  /** Tokens right after the last compaction, and whether a measurement came after it. */
  last?: { tokensAfter: number; measuredSince: boolean };
}

export function shouldAutoCompact(s: CompactState): boolean {
  if (s.lastEntryIsCompaction) return false;
  if (s.tokens < ceiling(s.window)) return false;
  if (s.last) {
    if (!s.last.measuredSince) return false;
    if (s.tokens - s.last.tokensAfter < TOKENS.HYSTERESIS_SHARE * s.window && s.tokens < s.window)
      return false;
  }
  return true;
}

/** The fixed headings of a handover summary (v11 B4 / v11.1 5.6). Section 9 is written by the host. */
export const SUMMARY_SECTIONS = [
  "目標",
  "使用者要求與限制",
  "決策",
  "工作狀態",
  "下一步",
  "相關檔案與物件",
  "關鍵脈絡",
  "未回答的使用者問題",
  "已執行的外部動作",
] as const;

export function summaryPrompt(previous?: string): string {
  return [
    "請把上面的工作整理成交接摘要，給接手的人直接繼續做。每一節都要有（沒有就寫「（無）」），簡短條列，保留確切的路徑、識別字、指令、錯誤原文與網址；不要提到摘要或壓縮，也不要繼續做任務。",
    ...(previous ? ["把下面這份舊摘要與新內容合併成一份；衝突時以新的為準。", previous] : []),
    ...SUMMARY_SECTIONS.map((s, i) => `## ${i + 1}. ${s}`),
  ].join("\n");
}

/** A summary is usable only with every heading present. */
export function summaryComplete(text: string): boolean {
  return SUMMARY_SECTIONS.every((s) => text.includes(s));
}

/** Section 9 is never the model's: the host writes it from its own ledger of outward actions. */
export function withOutwardLedger(summary: string, outward: readonly string[]): string {
  const head = "已執行的外部動作";
  const at = summary.indexOf(head);
  const body = outward.length ? outward.map((o) => `- ${o}`).join("\n") : "（無）";
  if (at < 0) return `${summary}\n## 9. ${head}\n${body}`;
  const lineStart = summary.lastIndexOf("\n", at) + 1;
  return `${summary.slice(0, lineStart)}## 9. ${head}\n${body}`;
}

/** Whether a summary should be prepared ahead (70 % of the ceiling), without compacting yet. */
export function shouldPrepareSummary(tokens: number, window: number): boolean {
  const c = ceiling(window);
  return Number.isFinite(c) && tokens >= c * TOKENS.PREPARE_SHARE && tokens < c;
}

/** A compaction was ineffective when the context right after it is still over the ceiling. */
export function compactionIneffective(tokensAfter: number, window: number): boolean {
  return tokensAfter >= ceiling(window);
}

/** Consecutive ineffective compactions that stop the run (plan §2.6). */
export function compactionStalled(ineffectiveInARow: number): boolean {
  return ineffectiveInARow >= TOKENS.MAX_INEFFECTIVE_COMPACTIONS;
}
