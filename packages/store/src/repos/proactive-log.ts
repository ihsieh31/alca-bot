import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newStoreId } from "../ids.ts";

/** What became of one candidate (migration 29). */
export type CandidateOutcome =
  | "offered"
  | "queued"
  | "homework"
  | "runner_up"
  | "watch"
  | "dropped"
  | "revalidated_out";

export interface CandidateLogInput {
  botId: string;
  scanId: string;
  via: "scan" | "queue";
  category: string;
  /** Kinds of source the candidate cited (`calendar`, `mail` …), never ids. */
  sources: readonly string[];
  evidenceN: number;
  timeliness: number;
  relevance: number;
  doable: number;
  acceptance: number;
  total: number;
  dropReason?: string | null;
  outcome: CandidateOutcome;
  offerId?: string | null;
  dueInHours?: number | null;
}

export interface CandidateLogRecord extends Required<Omit<CandidateLogInput, "sources">> {
  id: string;
  sources: string[];
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  bot_id: string;
  scan_id: string;
  via: "scan" | "queue";
  category: string;
  sources: string;
  evidence_n: number;
  timeliness: number;
  relevance: number;
  doable: number;
  acceptance: number;
  total: number;
  drop_reason: string | null;
  outcome: CandidateOutcome;
  offer_id: string | null;
  due_in_hours: number | null;
  created_at: string;
  updated_at: string;
}

const fromRow = (r: Row): CandidateLogRecord => ({
  id: r.id,
  botId: r.bot_id,
  scanId: r.scan_id,
  via: r.via,
  category: r.category,
  sources: r.sources ? r.sources.split(",") : [],
  evidenceN: r.evidence_n,
  timeliness: r.timeliness,
  relevance: r.relevance,
  doable: r.doable,
  acceptance: r.acceptance,
  total: r.total,
  dropReason: r.drop_reason,
  outcome: r.outcome,
  offerId: r.offer_id,
  dueInHours: r.due_in_hours,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SOURCE_WORD = /^[a-z_]{1,20}$/;
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * 主動留意's per-candidate log (gap analysis 2026-11 P14). Plain numbers and
 * fixed words only (see migration 29); the add-on writes, the metrics read.
 */
export class ProactiveLogRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(i: CandidateLogInput, now = new Date()): string {
    const id = newStoreId("pcd", now.getTime());
    const ts = now.toISOString();
    const sources = [...new Set(i.sources.filter((s) => SOURCE_WORD.test(s)))].join(",");
    this.db
      .prepare(
        `INSERT INTO proactive_candidates (id, bot_id, scan_id, via, category, sources, evidence_n,
           timeliness, relevance, doable, acceptance, total, drop_reason, outcome, offer_id, due_in_hours,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        i.botId,
        i.scanId,
        i.via,
        i.category.slice(0, 30),
        sources,
        i.evidenceN,
        round(i.timeliness),
        round(i.relevance),
        round(i.doable),
        round(i.acceptance),
        round(i.total),
        i.dropReason?.slice(0, 30) ?? null,
        i.outcome,
        i.offerId ?? null,
        i.dueInHours == null ? null : Math.round(i.dueInHours * 10) / 10,
        ts,
        ts,
      );
    return id;
  }

  get(id: string): CandidateLogRecord | undefined {
    const r = this.db.prepare("SELECT * FROM proactive_candidates WHERE id = ?").get(id) as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  /** A later step of the same candidate (homework made its card; a queued card failed revalidation). */
  update(
    id: string,
    p: { outcome?: CandidateOutcome; offerId?: string | null; dropReason?: string | null },
    now = new Date(),
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const params: SQLInputValue[] = [now.toISOString()];
    if (p.outcome) {
      sets.push("outcome = ?");
      params.push(p.outcome);
    }
    if (p.offerId !== undefined) {
      sets.push("offer_id = ?");
      params.push(p.offerId);
    }
    if (p.dropReason !== undefined) {
      sets.push("drop_reason = ?");
      params.push(p.dropReason?.slice(0, 30) ?? null);
    }
    this.db.prepare(`UPDATE proactive_candidates SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  }

  /** The row that made this card (newest first). */
  byOffer(offerId: string): CandidateLogRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM proactive_candidates WHERE offer_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(offerId) as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  list(botId: string, since: Date, limit = 200): CandidateLogRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM proactive_candidates WHERE bot_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(botId, since.toISOString(), limit) as unknown as Row[];
    return rows.map(fromRow);
  }

  /** Counts since a time: candidates, scans, and per outcome / drop reason. */
  summary(
    botId: string,
    since: Date,
  ): {
    candidates: number;
    scans: number;
    outcomes: Record<string, number>;
    dropped: Record<string, number>;
  } {
    const t = since.toISOString();
    const head = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COUNT(DISTINCT scan_id) AS s FROM proactive_candidates WHERE bot_id = ? AND created_at >= ?",
      )
      .get(botId, t) as { n: number; s: number };
    const by = (col: "outcome" | "drop_reason") =>
      Object.fromEntries(
        (
          this.db
            .prepare(
              `SELECT ${col} AS k, COUNT(*) AS n FROM proactive_candidates WHERE bot_id = ? AND created_at >= ? AND ${col} IS NOT NULL GROUP BY ${col}`,
            )
            .all(botId, t) as Array<{ k: string; n: number }>
        ).map((r) => [r.k, r.n]),
      );
    return { candidates: head.n, scans: head.s, outcomes: by("outcome"), dropped: by("drop_reason") };
  }

  /** Delete rows older than `before` (the add-on keeps 90 days). */
  prune(before: Date): number {
    const r = this.db
      .prepare("DELETE FROM proactive_candidates WHERE created_at < ?")
      .run(before.toISOString());
    return Number(r.changes);
  }
}
