/**
 * Gap analysis 2026-11 #9: the HTTP model engines (a bot's router on an API
 * model) kept the last 80 messages and dropped the rest without a word, so
 * a long conversation silently forgot its start. Now the dropped part is
 * folded into a rolling summary that stays at the head of the history, as a
 * user message (plus a one-word assistant reply, so every API's turn order
 * holds) — the stable system layer is untouched, so a prompt cache still
 * hits. Each later cut folds the previous summary in.
 *
 * Deterministic and model-free: what the person stated that looks like a
 * standing fact (names, dates, amounts, preferences, 記得 / 不要 …) is
 * pinned and carried across every cut; the rest is one short line per
 * dropped message, newest kept when over the cap. Tool results (web pages,
 * files) never go in: only what the person and the assistant said.
 * A cut starts on a real user turn, never on a tool result.
 */

export interface HistoryView<T> {
  /** Who said what, for the summary; undefined = plumbing (tool calls / results). */
  read(m: T): { role: "user" | "assistant"; text: string } | undefined;
  /** A real user turn (a cut may start here). */
  isUserTurn(m: T): boolean;
  user(text: string): T;
  assistant(text: string): T;
}

export const SUMMARY_MARK = "[Alca: summary of earlier messages in this conversation]";
export const SUMMARY_ACK = "OK.";
/** Room the summary may take (characters). */
export const SUMMARY_MAX_CHARS = 3000;
/** History kept after a cut, in serialized characters (about 60k tokens of CJK at most). */
export const HISTORY_MAX_CHARS = 240_000;
const MAX_PINNED = 16;
const MAX_LINES = 24;

/** A standing fact the person stated: worth carrying over every cut. */
const PIN =
  /記得|記住|我叫|我的|我是|我住|我在|生日|過敏|不吃|不要|別再|偏好|喜歡|討厭|以後|每次|地址|電話|預算|截止|my name|i am|i'm|i live|remember|always|never|prefer|allerg|budget|deadline|\d{1,4}\s*[/月年.-]\s*\d{1,2}|\d+\s*(?:點|時|元|塊|號|%|usd|ntd|nt\$)/iu;

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/gu, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

interface Parsed {
  dropped: number;
  pinned: string[];
  lines: string[];
}

function parseSummary(text: string): Parsed {
  const out: Parsed = { dropped: 0, pinned: [], lines: [] };
  const n = /\((\d+) earlier messages\)/u.exec(text);
  out.dropped = n ? Number(n[1]) : 0;
  let into: string[] | undefined;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("Pinned")) into = out.pinned;
    else if (raw.startsWith("Earlier")) into = out.lines;
    else if (raw.startsWith("- ") && into) into.push(raw.slice(2));
  }
  return out;
}

/** The summary text for `dropped` messages on top of an earlier summary. */
export function summarize(
  previous: string | undefined,
  dropped: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
  count: number,
): string {
  const prev = previous ? parseSummary(previous) : { dropped: 0, pinned: [], lines: [] };
  const pinned = [...prev.pinned];
  const lines = [...prev.lines];
  for (const m of dropped) {
    if (m.role === "user")
      for (const part of m.text.split(/\n+|(?<=[。！？!?])/u)) {
        const p = oneLine(part, 160);
        if (p.length >= 4 && PIN.test(p) && !pinned.includes(p)) pinned.push(p);
      }
    const l = `${m.role}: ${oneLine(m.text, m.role === "user" ? 120 : 80)}`;
    if (m.text.trim()) lines.push(l);
  }
  const keepPinned = pinned.slice(-MAX_PINNED);
  let keepLines = lines.slice(-MAX_LINES);
  const render = () =>
    [
      SUMMARY_MARK,
      `Older messages were removed to keep the conversation short (${prev.dropped + count} earlier messages). In brief:`,
      ...(keepPinned.length ? ["Pinned facts the person stated:", ...keepPinned.map((p) => `- ${p}`)] : []),
      ...(keepLines.length ? ["Earlier exchanges, oldest first:", ...keepLines.map((p) => `- ${p}`)] : []),
    ].join("\n");
  let text = render();
  while (text.length > SUMMARY_MAX_CHARS && keepLines.length) {
    keepLines = keepLines.slice(1);
    text = render();
  }
  return text.slice(0, SUMMARY_MAX_CHARS);
}

/**
 * Bound a history: at most `maxMessages` (summary pair included) and
 * `maxChars` serialized; what is cut goes into the rolling summary. A
 * history that cannot be cut on a user turn falls back to a plain trim that
 * still starts user-first (a summary message in front when needed).
 */
export function compactHistory<T>(
  msgs: T[],
  maxMessages: number,
  view: HistoryView<T>,
  maxChars = HISTORY_MAX_CHARS,
): T[] {
  const size = (m: T) => JSON.stringify(m).length;
  const total = msgs.reduce((n, m) => n + size(m), 0);
  if (msgs.length <= maxMessages && total <= maxChars) return msgs;
  const head = msgs[0] !== undefined ? view.read(msgs[0]) : undefined;
  const hasSummary = head?.role === "user" && head.text.startsWith(SUMMARY_MARK);
  // The pair's reply is exactly SUMMARY_ACK; anything else after a summary is real history.
  const ack = hasSummary && msgs[1] !== undefined && isAck(view.read(msgs[1])) ? 1 : 0;
  const previous = hasSummary ? head.text : undefined;
  const bodyStart = hasSummary ? 1 + ack : 0;
  const body = msgs.slice(bodyStart);
  const keep = Math.max(2, maxMessages - 2);
  let cut = Math.max(0, body.length - keep);
  // Characters too: cut further while what is kept is over the budget (the summary is small).
  let kept = body.slice(cut).reduce((n, m) => n + size(m), 0);
  while (kept > maxChars - SUMMARY_MAX_CHARS && cut < body.length - 1) {
    kept -= size(body[cut] as T);
    cut++;
  }
  while (cut < body.length && !view.isUserTurn(body[cut] as T)) cut++;
  if (cut >= body.length) return trimLoop(msgs, maxMessages, view, previous, bodyStart);
  if (cut === 0) return msgs;
  const text = summarize(previous, said(body.slice(0, cut), view), cut);
  return [view.user(text), view.assistant(SUMMARY_ACK), ...body.slice(cut)];
}

type Said = { role: "user" | "assistant"; text: string };
const isAck = (x: Said | undefined) => x?.role === "assistant" && x.text.trim() === SUMMARY_ACK;
const said = <T>(msgs: T[], view: HistoryView<T>): Said[] =>
  msgs.map((m) => view.read(m)).filter((x): x is Said => !!x && !!x.text.trim());

/**
 * No user turn to start on (one long tool loop): the plain trim, never a
 * dangling tool result. Review #14: after dropping leading plumbing the
 * history may start on an assistant message (a tool call), which an API
 * that wants user-first (Anthropic) rejects on every later turn — so a
 * user message carrying the summary of what was dropped goes in front.
 */
function trimLoop<T>(
  msgs: T[],
  maxMessages: number,
  view: HistoryView<T>,
  previous: string | undefined,
  bodyStart: number,
): T[] {
  const plumbing = (m: T) => !view.isUserTurn(m) && view.read(m) === undefined;
  let from = Math.max(0, msgs.length - maxMessages);
  while (from < msgs.length && plumbing(msgs[from] as T)) from++;
  if (from < msgs.length && view.isUserTurn(msgs[from] as T)) return from === 0 ? msgs : msgs.slice(from);
  // Room for the summary message within maxMessages.
  from = Math.max(from, msgs.length - Math.max(1, maxMessages - 1));
  while (from < msgs.length && plumbing(msgs[from] as T)) from++;
  const start = Math.max(bodyStart, Math.min(from, msgs.length));
  const dropped = msgs.slice(bodyStart, start);
  const text = summarize(previous, said(dropped, view), dropped.length);
  return [view.user(text), ...msgs.slice(from)];
}
