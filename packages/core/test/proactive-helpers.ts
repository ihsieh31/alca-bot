import type { AddonCompletion, AppItem, AppRead } from "../src/index.ts";
import { AppSource } from "../src/index.ts";
import { type Harness, makeAgents, say } from "./agents-helpers.ts";

/**
 * Gap analysis 2026-11 tests: one bot with 主動留意 on, a clock the test moves,
 * fake calendar / mail readers the test fills, and a candidate step the test
 * scripts (a function of the evidence ids it was shown, or a throw).
 * `dailyTokenCap` stays under the homework minimum, so a winner becomes a
 * card from its own words at once (no homework worker, deterministic).
 */

export const T0 = Date.parse("2026-11-04T02:00:00.000Z"); // Wed 10:00 in Taipei
export const HOUR = 3600_000;
export const DAY = 86400_000;
export const iso = (ms: number) => new Date(ms).toISOString();

export interface Cand {
  fact: string;
  action: string;
  category: string;
  due_at?: string | null;
  evidence_ids: string[];
}

export type Answer = (ids: string[], prompt: string) => Cand[] | string | Error;

export interface ProSetup {
  h: Harness;
  bot: string;
  calls: string[];
  cal: { items: AppItem[]; complete: boolean; fail?: boolean };
  mail: { items: AppItem[]; complete: boolean; fail?: boolean };
  setAnswer(a: Answer): void;
  set(ms: number): void;
  advance(ms: number): void;
  now(): number;
  remember(body: string, dueAt: string): void;
}

export function proSetup(
  o: { at?: number; settings?: Record<string, unknown>; answer?: Answer } = {},
): ProSetup {
  let now = o.at ?? T0;
  let answer: Answer = o.answer ?? (() => []);
  const calls: string[] = [];
  const complete: AddonCompletion = async ({ prompt }) => {
    calls.push(prompt);
    const ids = [...prompt.matchAll(/id=(\S+)/gu)].map((m) => m[1] as string);
    const out = answer(ids, prompt);
    if (out instanceof Error) throw out;
    return {
      text: typeof out === "string" ? out : JSON.stringify({ candidates: out }),
      inputTokens: 100,
      outputTokens: 10,
    };
  };
  const cal = { items: [] as AppItem[], complete: true, fail: false };
  const mail = { items: [] as AppItem[], complete: true, fail: false };
  const reader = (box: typeof cal) => async (): Promise<AppRead> => {
    if (box.fail) throw new Error("連線失敗");
    return { items: box.items, complete: box.complete };
  };
  const h = makeAgents({
    router: () => say("好"),
    worker: () => say("x"),
    system: {
      now: () => new Date(now),
      addonComplete: complete,
      proactiveSources: [new AppSource("calendar", reader(cal)), new AppSource("mail", reader(mail))],
    },
  });
  const bot = h.store.bots.ensureDefault().id;
  h.agents.addons.set(bot, "proactive", {
    enabled: true,
    settings: {
      dailyTokenCap: 5000,
      dailyRunCap: 100,
      maxPerDay: 5,
      minIntervalHours: 0.5,
      sources: { calendar: true, mail: true, deadlines: true, alca: true },
      ...o.settings,
    },
  });
  return {
    h,
    bot,
    calls,
    cal,
    mail,
    setAnswer: (a) => {
      answer = a;
    },
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
    remember: (body, dueAt) =>
      void h.agents.learning?.memory.remember(
        bot,
        { kind: "project", subject: `due:${body}`, body, quote: body, confidence: 1, dueAt },
        {},
        { scope: "shared" },
      ),
  };
}
