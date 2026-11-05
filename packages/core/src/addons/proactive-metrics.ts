import type { CandidateLogInput, CandidateOutcome, Store } from "@alca/store";
import type { Candidate, ScoreParts } from "./proactive-pick.ts";

/**
 * Gap analysis 2026-11 P14: 主動留意's precision, measured. Each candidate a
 * scan (or a queue re-score) looked at is one `proactive_candidates` row —
 * no content, see migration 29 — and the card it made answers the rest
 * (accepted / declined / ignored / expired on its `offers` row).
 *
 * Rates are over cards the person decided on in the window (accepted +
 * declined + ignored); null until there is one. `ignored` = shown and not
 * answered for 48 h.
 */

export const METRICS_DAYS = 30;
/** Telemetry rows are kept this long. */
export const LOG_KEEP_DAYS = 90;

export interface ProactiveMetrics {
  windowDays: number;
  scans: number;
  candidates: number;
  /** Cards made in the window, and how many of them were shown. */
  cards: number;
  shown: number;
  accepted: number;
  declined: number;
  ignored: number;
  expired: number;
  pending: number;
  acceptRate: number | null;
  dismissRate: number | null;
  ignoredRate: number | null;
  /** Candidates per outcome (`offered`, `queued`, `homework`, `runner_up`, `watch`, `dropped`, `revalidated_out`). */
  outcomes: Record<string, number>;
  /** Candidates per drop reason (`below_threshold`, `duplicate`, `bulk`, `gone` …). */
  dropped: Record<string, number>;
}

const SOURCE_OF_PREFIX: Record<string, string> = {
  cal: "calendar",
  mail: "mail",
  due: "deadlines",
  alca: "alca",
};

/** The kinds of source a candidate cites (never the ids). */
export function sourceKinds(c: Pick<Candidate, "evidenceIds">): string[] {
  return [...new Set(c.evidenceIds.map((id) => SOURCE_OF_PREFIX[id.slice(0, id.indexOf(":"))] ?? "other"))];
}

/** The row for one candidate (score parts as scored now). */
export function logRow(
  i: {
    botId: string;
    scanId: string;
    via: "scan" | "queue";
    candidate: Candidate;
    score: ScoreParts;
    now: Date;
  },
  outcome: CandidateOutcome,
  extra: { dropReason?: string | null; offerId?: string | null } = {},
): CandidateLogInput {
  const due = i.candidate.dueAt ? (Date.parse(i.candidate.dueAt) - i.now.getTime()) / 3600_000 : null;
  return {
    botId: i.botId,
    scanId: i.scanId,
    via: i.via,
    category: i.candidate.category,
    sources: sourceKinds(i.candidate),
    evidenceN: i.candidate.evidenceIds.length,
    timeliness: i.score.timeliness,
    relevance: i.score.relevance,
    doable: i.score.doable,
    acceptance: i.score.acceptance,
    total: i.score.total,
    outcome,
    dropReason: extra.dropReason ?? null,
    offerId: extra.offerId ?? null,
    dueInHours: due !== null && Number.isFinite(due) ? due : null,
  };
}

const rate = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 1000 : null);

export function proactiveMetrics(store: Store, botId: string, source: string, now: Date): ProactiveMetrics {
  const since = new Date(now.getTime() - METRICS_DAYS * 86400_000);
  const o = store.offers.outcomes(botId, source, since);
  const log = store.proactiveLog.summary(botId, since);
  const decided = o.accepted + o.declined + o.ignored;
  return {
    windowDays: METRICS_DAYS,
    scans: log.scans,
    candidates: log.candidates,
    cards: decided + o.expired + o.pending,
    shown: o.shown,
    accepted: o.accepted,
    declined: o.declined,
    ignored: o.ignored,
    expired: o.expired,
    pending: o.pending,
    acceptRate: rate(o.accepted, decided),
    dismissRate: rate(o.declined, decided),
    ignoredRate: rate(o.ignored, decided),
    outcomes: log.outcomes,
    dropped: log.dropped,
  };
}
