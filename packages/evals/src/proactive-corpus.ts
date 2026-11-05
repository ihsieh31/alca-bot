import {
  type AddonCompletion,
  type AppItem,
  type AppRead,
  AppSource,
  evidenceRef,
  OFFER_SOURCE,
} from "@alca/core";
import { agentSystem, say } from "./fixtures.ts";

/**
 * Gap analysis 2026-11 §4.6: a labeled corpus for 主動留意. Each case is a
 * small fictional world (calendar, mail, deadlines, profile, suppress rules,
 * a clock) with a scripted candidate step — no live model — run through the
 * real pipeline (sources → candidate parse → score → vet → queue → cards →
 * release). Every piece of evidence belongs to a labeled matter; `gold`
 * names the matters that should end up as a shown card by the end of the
 * case. Anything else shown is a false positive.
 *
 * Metrics over the corpus:
 * - precision = cards shown about a gold matter (the first per matter) / cards shown;
 * - recall = gold matters with a shown card / gold matters;
 * - false interrupts = cards shown inside quiet hours or past the day's maximum;
 * - duplicates = extra cards about a matter that already had one.
 */

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
/** Tue 2026-11-03 10:00 in Taipei. */
export const T_DAY = Date.UTC(2026, 10, 3, 2, 0);
/** Tue 2026-11-03 23:00 in Taipei. */
export const T_NIGHT = Date.UTC(2026, 10, 3, 15, 0);
const TZ = "Asia/Taipei";

/** One piece of fixture evidence: a calendar event or a mail (times in hours from the case's start). */
export interface FixtureItem {
  id: string;
  title: string;
  matter: string;
  from?: string;
  startsInH?: number;
  version?: string;
  status?: string;
  labels?: string[];
}

/** One scripted candidate: `ev` is the fixture id it cites (`e1`, `m1`, `d:<body>`), or a made-up one. */
export interface FixtureCand {
  ev: string | string[];
  fact: string;
  action: string;
  category: "project" | "errand" | "money_account" | "social" | "study" | "other";
  dueInH?: number | null;
}

export interface Step {
  /** Hours after the case's start. */
  atH: number;
  cal?: FixtureItem[];
  /** The calendar read may be cut off (a full page). */
  calPartial?: boolean;
  mail?: FixtureItem[];
  deadlines?: Array<{ body: string; matter: string; dueInH: number }>;
  /** The candidate step for this scan: candidates, a raw answer, or a throw. */
  model?: FixtureCand[] | string | Error;
  /** Suppress rules the person writes before this step (「別再提」 topics). */
  suppress?: string[];
  /** Run a scan at this step (default true); false = only the clock (re-score, release). */
  scan?: boolean;
}

export interface ProactiveCase {
  id: string;
  tags: readonly string[];
  start?: number;
  settings?: Record<string, unknown>;
  /** Shared memories (what Alca knows about the person). */
  profile?: string[];
  steps: Step[];
  /** Matters that should be a shown card by the end. */
  gold: string[];
}

export interface CaseResult {
  id: string;
  tags: readonly string[];
  gold: string[];
  /** Matters of each shown card, in order. */
  shown: string[][];
  truePositives: number;
  falsePositives: number;
  duplicates: number;
  falseInterrupts: number;
  missed: string[];
  ok: boolean;
}

export interface CorpusMetrics {
  cases: number;
  shown: number;
  gold: number;
  precision: number;
  recall: number;
  f1: number;
  falseInterrupts: number;
  duplicates: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

function localHour(ms: number): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    day: `${v("year")}-${v("month")}-${v("day")}`,
    minutes: Number(v("hour")) * 60 + Number(v("minute")),
  };
}

function inQuiet(ms: number, quiet: string | null): boolean {
  if (!quiet) return false;
  const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(quiet);
  if (!m) return false;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  const t = localHour(ms).minutes;
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

/** Run one case through the real pipeline. */
export async function runCase(c: ProactiveCase): Promise<CaseResult> {
  const start = c.start ?? T_DAY;
  let now = start;
  let model: Step["model"] = [];
  const matterOf = new Map<string, string>();
  const deadlineIds = new Map<string, string>();
  const cal: AppRead = { items: [], complete: true };
  const mail: AppRead = { items: [], complete: true };

  const toItem = (f: FixtureItem, prefix: "cal" | "mail"): AppItem => {
    matterOf.set(`${prefix}:${f.id}`, f.matter);
    return {
      id: f.id,
      title: f.title,
      ...(f.from ? { from: f.from } : {}),
      ...(f.startsInH !== undefined ? { startsAt: iso(start + f.startsInH * HOUR) } : {}),
      ...(f.version ? { version: f.version } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.labels ? { labels: f.labels } : {}),
    };
  };

  const complete: AddonCompletion = async ({ prompt }) => {
    const ids = [...prompt.matchAll(/id=(\S+)/gu)].map((m) => m[1] as string);
    const m = model;
    if (m instanceof Error) throw m;
    if (typeof m === "string") return { text: m, inputTokens: 100, outputTokens: 10 };
    const find = (ev: string) => {
      if (ev.startsWith("d:")) return deadlineIds.get(ev.slice(2)) ?? `due:missing`;
      return ids.find((i) => evidenceRef(i) === `cal:${ev}` || i === `mail:${ev}`) ?? `cal:${ev}`;
    };
    const candidates = (m ?? []).map((x) => ({
      fact: x.fact,
      action: x.action,
      category: x.category,
      due_at: x.dueInH === undefined || x.dueInH === null ? null : iso(start + x.dueInH * HOUR),
      evidence_ids: (Array.isArray(x.ev) ? x.ev : [x.ev]).map(find),
    }));
    return { text: JSON.stringify({ candidates }), inputTokens: 100, outputTokens: 10 };
  };

  const a = agentSystem({
    router: () => say("好"),
    worker: () => say("x"),
    system: {
      now: () => new Date(now),
      addonComplete: complete,
      proactiveSources: [new AppSource("calendar", async () => cal), new AppSource("mail", async () => mail)],
    },
  });
  try {
    const bot = a.store.bots.ensureDefault().id;
    const settings = {
      dailyTokenCap: 5000,
      dailyRunCap: 100,
      maxPerDay: 5,
      minIntervalHours: 0.5,
      quietHours: "22:00-08:00",
      ...c.settings,
    };
    a.agents.addons.set(bot, "proactive", { enabled: true, settings });
    for (const body of c.profile ?? [])
      a.agents.learning?.memory.remember(
        bot,
        { kind: "preference", subject: `profile:${body}`, body, quote: body, confidence: 1 },
        {},
        { scope: "shared" },
      );
    const desk = a.agents.proactive;
    const settle = () => {
      for (let i = 0; i < 6; i++) {
        desk.release(bot);
        const r = desk.pump(bot);
        if (!r || r.outcome === "no_candidate") break;
      }
      desk.release(bot);
    };
    for (const s of c.steps) {
      now = start + s.atH * HOUR;
      for (const t of s.suppress ?? []) a.agents.learning?.suppress(bot, t, `別再提${t}`);
      if (s.cal) cal.items = s.cal.map((f) => toItem(f, "cal"));
      cal.complete = !s.calPartial;
      if (s.mail) mail.items = s.mail.map((f) => toItem(f, "mail"));
      for (const d of s.deadlines ?? []) {
        const r = a.agents.learning?.memory.remember(
          bot,
          {
            kind: "project",
            subject: `due:${d.body}`,
            body: d.body,
            quote: d.body,
            confidence: 1,
            dueAt: iso(start + d.dueInH * HOUR),
          },
          {},
          { scope: "shared" },
        );
        const id = r?.memory?.id;
        if (id) {
          deadlineIds.set(d.body, `due:${id}`);
          matterOf.set(`due:${id}`, d.matter);
        }
      }
      if (s.model !== undefined) model = s.model;
      settle();
      if (s.scan !== false) await desk.scan(bot, { force: true });
      settle();
    }
    const offers = a.store.offers
      .list({ botId: bot, source: OFFER_SOURCE, limit: 200 })
      .filter((o) => o.shownAt)
      .sort((x, y) => (x.shownAt as string).localeCompare(y.shownAt as string));
    const gold = new Set(c.gold);
    const covered = new Set<string>();
    const perDay = new Map<string, number>();
    let tp = 0;
    let fp = 0;
    let dup = 0;
    let fi = 0;
    const shown: string[][] = [];
    for (const o of offers) {
      const ms = Date.parse(o.shownAt as string);
      const day = localHour(ms).day;
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      if (
        inQuiet(ms, settings.quietHours as string | null) ||
        (perDay.get(day) ?? 0) > Number(settings.maxPerDay)
      )
        fi++;
      const matters = [...new Set(o.evidence.map((e) => matterOf.get(evidenceRef(e)) ?? "?"))];
      shown.push(matters);
      const hit = matters.find((m) => gold.has(m));
      if (hit && !covered.has(hit)) {
        tp++;
        for (const m of matters) covered.add(m);
      } else {
        fp++;
        if (matters.some((m) => covered.has(m))) dup++;
      }
    }
    const missed = c.gold.filter((g) => !covered.has(g));
    return {
      id: c.id,
      tags: c.tags,
      gold: c.gold,
      shown,
      truePositives: tp,
      falsePositives: fp,
      duplicates: dup,
      falseInterrupts: fi,
      missed,
      ok: fp === 0 && fi === 0 && missed.length === 0,
    };
  } finally {
    await a.close();
  }
}

export function corpusMetrics(results: readonly CaseResult[]): CorpusMetrics {
  const tp = results.reduce((n, r) => n + r.truePositives, 0);
  const fp = results.reduce((n, r) => n + r.falsePositives, 0);
  const gold = results.reduce((n, r) => n + r.gold.length, 0);
  const found = results.reduce((n, r) => n + (r.gold.length - r.missed.length), 0);
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = gold ? found / gold : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    cases: results.length,
    shown: tp + fp,
    gold,
    precision: r3(precision),
    recall: r3(recall),
    f1: r3(f1),
    falseInterrupts: results.reduce((n, r) => n + r.falseInterrupts, 0),
    duplicates: results.reduce((n, r) => n + r.duplicates, 0),
  };
}

export async function runCorpus(
  cases: readonly ProactiveCase[],
): Promise<{ results: CaseResult[]; metrics: CorpusMetrics }> {
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c));
  return { results, metrics: corpusMetrics(results) };
}

/** CI gates for the deterministic corpus (gap analysis §4.6). */
export const CORPUS_GATES = { precision: 0.9, recall: 0.8, falseInterrupts: 0, duplicates: 0 } as const;
