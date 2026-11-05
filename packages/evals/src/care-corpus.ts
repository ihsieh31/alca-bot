import { parseSettings } from "@alca/config";
import { AgentSystem, AlcaCore, mentions, REST_LINE, splitSentences } from "@alca/core";
import { type ScriptContext, ScriptedEngine } from "@alca/engines";
import { evalStore, say } from "./fixtures.ts";

/**
 * Care moments corpus (docs/design/CARE-MOMENTS.md §6). Each case is a small
 * fictional life (dated events the person told Alca, earlier turns, a clock)
 * and one final turn, run through the real pipeline: capture by the memory
 * extractor, the situation, the decision, the `<alca:moment>` block, the
 * reply post-check. No live model: the router is scripted, in two modes:
 *
 *   - `obedient`: writes a care line only when the block offers one;
 *   - `tempted`: an over-eager model that ends EVERY final reply with a wish
 *     for the soonest event plus an offer — the gate and post-check must
 *     still leave no false care line.
 *
 * Positives must end with exactly the expected line (an item, or rest);
 * negatives must end with no line about any timeline item. The patterns come
 * from the (aggregated, fictionalized) conversation analysis in the doc.
 */

export interface CareTurn {
  /** Local Taipei time, YYYY-MM-DDTHH:MM. */
  at: string;
  user: string;
  /** The scripted reply for this earlier turn (default: an obedient one). */
  reply?: string;
  /** Another thread than the final turn's (default: the same). */
  other?: boolean;
}

export type CareExpect =
  | { line: "item"; title: string }
  | { line: "rest" }
  /** A goodbye with no personal line and no question or offer at the end. */
  | { line: "closing" }
  /** No line about any timeline item (anything else is up to the model). */
  | { line: "none" };

export interface CareCase {
  id: string;
  tags: string[];
  lang?: "zh" | "en";
  /** What the person told Alca, each in its own earlier turn (captured by the real extractor). */
  events?: CareTurn[];
  prior?: CareTurn[];
  final: CareTurn;
  expect: CareExpect;
}

export type CareMode = "obedient" | "tempted";

export interface CareResult {
  id: string;
  mode: CareMode;
  ok: boolean;
  positive: boolean;
  /** The final reply as stored after the post-check. */
  reply: string;
  /** A line about a timeline item where none was expected (or the wrong one). */
  falseCare: boolean;
  why?: string;
}

export interface CareMetrics {
  cases: number;
  positives: number;
  negatives: number;
  /** Positives that ended with the expected line. */
  recall: number;
  /** Negatives that ended with a line about a timeline item. */
  falseCare: number;
  failed: string[];
}

/** CI gates: every positive lands, and not one false care line, in either mode. */
export const CARE_GATES = { recall: 1, falseCare: 0 } as const;
export const CARE_MIN_CASES = 20;

const TZ = "Asia/Taipei";
const local = (s: string) => new Date(`${s}:00+08:00`);
const ASKS = /[?？]\s*$|嗎[\s。]*$/u;
const OFFER = /要我|需要我|\bwant me to\b|\bshould I\b|\bshall I\b/iu;

/** What an obedient model writes, from the turn's context (the moment block, if any). */
function obedient(volatile: string, user: string): string {
  const en = !/[\p{Script=Han}]/u.test(user);
  const item =
    /可以提的一件事：(.+?)，/u.exec(volatile)?.[1] ?? /One thing that may fit: (.+?), /u.exec(volatile)?.[1];
  if (item && !/^(?:休息|rest)$/u.test(item))
    return en
      ? `Got it, I'll take it from here. Good night, and good luck with the ${item}!`
      : `好，剩下的交給我。晚安，${item}加油。`;
  if (/可以提的一件事：休息|One thing that may fit: rest/u.test(volatile))
    return en ? "Got it. Good night, sleep well." : "好，晚安，早點休息。";
  if (volatile.includes("<alca:moment>")) return en ? "Okay, good night." : "好，晚安。";
  return en ? "Sure, on it." : "好，我來處理。";
}

async function runOne(c: CareCase, mode: CareMode): Promise<CareResult> {
  let now = local(c.final.at);
  const clock = () => now;
  const store = evalStore();
  const settings = parseSettings({ engineering: { routines: { startDelaySec: 0 } } });
  const replies = new Map<string, string>();
  for (const t of [...(c.events ?? []), ...(c.prior ?? [])]) if (t.reply) replies.set(t.user, t.reply);
  let finalTurn = false;
  let tempt = "";
  const router = new ScriptedEngine(
    ({ req, pass }: ScriptContext) => {
      if (pass > 0) return say("好");
      const user = req.userMessage.trim().split("\n").at(-1) ?? "";
      const base = replies.get(user) ?? obedient(req.system.volatile, user);
      return say(finalTurn && mode === "tempted" && tempt ? `${base} ${tempt}` : base);
    },
    { id: "router" },
  );
  const core = new AlcaCore({ store, engine: router, settings: () => settings, now: clock, timeZone: TZ });
  const agents = new AgentSystem({
    core,
    routerEngine: router,
    workerEngine: new ScriptedEngine(() => say("x"), { id: "worker" }),
    settings: () => settings,
    tickMs: 0,
    now: clock,
    timeZone: TZ,
  });
  try {
    const bot = store.bots.ensureDefault().id;
    const life = core.createThread("life");
    const main = core.createThread("main");
    const other = core.createThread("other");
    const send = async (t: CareTurn, thread: string) => {
      now = local(t.at);
      await core.send(thread, t.user).done;
      await agents.learning?.settle();
    };
    for (const e of c.events ?? []) await send(e, life.id);
    for (const p of c.prior ?? []) await send(p, p.other ? other.id : main.id);
    now = local(c.final.at);
    const titles = (agents.care?.timeline(bot, now) ?? []).map((i) => i.title);
    const soonest = titles[0];
    tempt = soonest
      ? c.lang === "en"
        ? `Good luck with the ${soonest}! Want me to remind you tomorrow?`
        : `${soonest}加油！要我明天提醒你嗎？`
      : "";
    finalTurn = true;
    await send(c.final, main.id);
    const reply =
      store.threads
        .messages(main.id)
        .filter((m) => m.role === "assistant")
        .at(-1)?.content ?? "";
    return judge(
      c,
      mode,
      reply,
      titles.filter((t) => !mentions(c.final.user, t)),
    );
  } finally {
    await agents.close();
    await core.close();
  }
}

/** Score one final reply against the case's expectation. */
export function judge(c: CareCase, mode: CareMode, reply: string, titles: readonly string[]): CareResult {
  const sentences = splitSentences(reply)
    .map((s) => s.trim())
    .filter(Boolean);
  const about = titles.filter((t) => sentences.some((s) => mentions(s, t)));
  const last = sentences.at(-1) ?? "";
  const e = c.expect;
  const positive = e.line === "item" || e.line === "rest";
  const res = (ok: boolean, falseCare: boolean, why?: string): CareResult => ({
    id: c.id,
    mode,
    ok,
    positive,
    reply,
    falseCare,
    ...(why ? { why } : {}),
  });
  const leftover = (ASKS.test(last) || OFFER.test(last)) && e.line !== "none";
  if (e.line === "item") {
    if (!about.includes(e.title)) return res(false, about.length > 0, `missing line about ${e.title}`);
    if (about.length > 1) return res(false, true, `extra items: ${about.join(", ")}`);
    if (c.lang === "en" && /[\p{Script=Han}]/u.test(reply)) return res(false, false, "not in English");
    if (leftover) return res(false, false, "question or offer after the goodbye");
    return res(true, false);
  }
  if (about.length) return res(false, true, `false care line: ${about.join(", ")}`);
  if (e.line === "rest" && !REST_LINE.test(reply)) return res(false, false, "missing rest line");
  if (leftover) return res(false, false, "question or offer after the goodbye");
  return res(true, false);
}

/** Run the corpus in one mode; metrics over its results. */
export async function runCareCorpus(
  cases: readonly CareCase[],
  mode: CareMode = "obedient",
): Promise<{ results: CareResult[]; metrics: CareMetrics }> {
  const results: CareResult[] = [];
  for (const c of cases) results.push(await runOne(c, mode));
  const pos = results.filter((r) => r.positive);
  const neg = results.filter((r) => !r.positive);
  return {
    results,
    metrics: {
      cases: results.length,
      positives: pos.length,
      negatives: neg.length,
      recall: pos.length ? Math.round((pos.filter((r) => r.ok).length / pos.length) * 1000) / 1000 : 1,
      falseCare: results.filter((r) => r.falseCare).length,
      failed: results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.why ?? ""}`),
    },
  };
}
