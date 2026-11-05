import { MEMORY_APPLIES, type MemoryApplies, type MemoryKind } from "@alca/store";
import type { Candidate, ExtractInput, Extractor } from "./extract.ts";
import { containsSecret } from "./redact.ts";

/**
 * Model-based memory extraction (P9, opt-in per bot). After a turn the bot's
 * own engine is asked, with no tools, for at most a few things worth keeping
 * about the person, each with the person's exact words. What comes back is
 * checked hard before it can become a memory:
 *
 * - it must parse as the JSON shape below (anything else → nothing);
 * - every quote must appear in what the person wrote in this turn (after
 *   whitespace is normalized), so the model cannot invent a memory or
 *   attribute the assistant's words to the person;
 * - the body must be short, and neither body nor quote may look like a
 *   secret (the service checks secrets and tombstones again on write);
 * - always `inferred`, confidence capped at 0.9.
 *
 * `CombinedExtractor` keeps the rules as the floor: the rule candidates
 * always count, the model only adds, and a model failure or timeout leaves
 * the rule result as it is.
 */

/** Runs one tool-free prompt on the bot's engine and returns its text. */
export type ExtractCompletion = (o: {
  botId: string;
  prompt: string;
  signal: AbortSignal;
}) => Promise<string>;

const KINDS: readonly MemoryKind[] = ["preference", "person", "fact", "project"];
const MAX_ITEMS = 3;

export function extractionPrompt(userText: string): string {
  return [
    "你是記憶整理器。只讀下面 <said> 裡使用者自己說的話，找出值得長期記住、關於使用者本人的事（偏好、身邊的人、事實、進行中的計畫）。",
    "規則：",
    '- 只輸出一個 JSON 物件，不要其他文字：{"items":[{"kind":"preference|person|fact|project","subject":"短主題","body":"要記住的事（20 字內）","quote":"使用者原話，一字不改","confidence":0.0-1.0,"applies_to":[]}]}',
    "- applies_to：如果這句話是對某類動作的固定指示（例如「寫信不要提到 X」「買東西一律選可退款」），填這類動作：send_message、publish、purchase、booking、code、schedule、any；不是就給 []。",
    `- 最多 ${MAX_ITEMS} 項；沒有就輸出 {"items":[]}。`,
    "- quote 必須是 <said> 裡連續、一字不差的一段。",
    "- 不要記問題、假設、一次性的請求，也不要記密碼、金鑰、卡號、身分證號。",
    "<said>",
    userText.slice(0, 4000),
    "</said>",
  ].join("\n");
}

const norm = (s: string) => s.replace(/\s+/gu, " ").trim();

/** The first balanced {...} in the text (models like to wrap JSON in prose or fences). */
function firstObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Turn a model's answer into candidates that pass every check above. */
export function parseModelCandidates(answer: string, userText: string): Candidate[] {
  const obj = firstObject(answer) as { items?: unknown } | undefined;
  if (!obj || !Array.isArray(obj.items)) return [];
  const said = norm(userText);
  const out: Candidate[] = [];
  for (const raw of obj.items.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const kind = KINDS.find((k) => k === it.kind);
    const body = typeof it.body === "string" ? norm(it.body).slice(0, 200) : "";
    const quote = typeof it.quote === "string" ? norm(it.quote) : "";
    if (!kind || !body || quote.length < 2) continue;
    // The quote has to be the person's own words from this turn: no quote, no memory.
    if (!said.includes(quote)) continue;
    if (containsSecret(body) || containsSecret(quote)) continue;
    const subjectRaw = typeof it.subject === "string" ? norm(it.subject).slice(0, 40) : "";
    const confidence =
      typeof it.confidence === "number" && Number.isFinite(it.confidence) ? it.confidence : 0.6;
    const applies = Array.isArray(it.applies_to)
      ? [
          ...new Set(
            it.applies_to.filter(
              (x): x is MemoryApplies =>
                x !== "proactive" && (MEMORY_APPLIES as readonly unknown[]).includes(x),
            ),
          ),
        ]
      : [];
    out.push({
      kind,
      subject: subjectRaw ? `m:${kind}:${subjectRaw.toLowerCase()}` : "",
      body,
      quote,
      confidence: Math.min(0.9, Math.max(0.05, confidence)),
      ...(applies.length ? { appliesTo: applies } : {}),
    });
  }
  return out;
}

export class ModelExtractor implements Extractor {
  readonly id = "model";
  private readonly complete: ExtractCompletion;
  private readonly timeoutMs: number;

  constructor(o: { complete: ExtractCompletion; timeoutMs?: number }) {
    this.complete = o.complete;
    this.timeoutMs = o.timeoutMs ?? 60_000;
  }

  async extract(input: ExtractInput): Promise<Candidate[]> {
    if (!input.userText.trim()) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const answer = await this.complete({
        botId: input.botId,
        prompt: extractionPrompt(input.userText),
        signal: ctrl.signal,
      });
      return parseModelCandidates(answer, input.userText);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Rules first, then (when `useModel(botId)` says so) the model's additions.
 * A candidate the rules already found (same subject or the same body) is not
 * added twice. Any model error is swallowed: the rules' answer stands.
 */
export class CombinedExtractor implements Extractor {
  readonly id = "rules+model";
  private readonly o: { rules: Extractor; model: Extractor; useModel: (botId: string) => boolean };
  /** Model extractions that failed (observability, tests). */
  failures = 0;

  constructor(o: { rules: Extractor; model: Extractor; useModel: (botId: string) => boolean }) {
    this.o = o;
  }

  async extract(input: ExtractInput): Promise<Candidate[]> {
    const ruled = await this.o.rules.extract(input);
    if (!this.o.useModel(input.botId)) return ruled;
    let modeled: Candidate[] = [];
    try {
      modeled = await this.o.model.extract(input);
    } catch {
      this.failures++;
      return ruled;
    }
    const out = [...ruled];
    for (const c of modeled) {
      const dup = out.some(
        (r) => (c.subject && r.subject === c.subject) || norm(r.body) === c.body || r.quote === c.quote,
      );
      if (!dup) out.push(c);
    }
    return out;
  }
}
