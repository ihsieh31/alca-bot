import type { Migration } from "../migrate.ts";

/**
 * Gap analysis 2026-11 P14: what each 主動留意 scan did with each candidate,
 * so precision can be measured and "why no card?" answered. One row per
 * candidate a scan (or a re-score from the add-on's queue) looked at: its
 * score parts, why it was dropped, what became of it, and the card it made.
 * The card's answer (accepted / declined / ignored / expired) stays on the
 * `offers` row it points at.
 *
 * No user content: the category, which kinds of source it cited, numbers and
 * fixed reason words — never the fact, the action or evidence ids — so the
 * table is not a sealed one (`SEALED`). Rows older than 90 days are deleted
 * by the add-on.
 */
export const proactiveLogSchema: Migration = {
  version: 29,
  name: "proactive_candidates (主動留意 per-candidate telemetry, no content)",
  sql: `
CREATE TABLE proactive_candidates (
  id           TEXT PRIMARY KEY,
  bot_id       TEXT NOT NULL,
  scan_id      TEXT NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('scan','queue')),
  category     TEXT NOT NULL,
  sources      TEXT NOT NULL DEFAULT '',
  evidence_n   INTEGER NOT NULL DEFAULT 0,
  timeliness   REAL NOT NULL,
  relevance    REAL NOT NULL,
  doable       REAL NOT NULL,
  acceptance   REAL NOT NULL,
  total        REAL NOT NULL,
  drop_reason  TEXT,
  outcome      TEXT NOT NULL
               CHECK (outcome IN ('offered','queued','homework','runner_up','watch','dropped','revalidated_out')),
  offer_id     TEXT,
  due_in_hours REAL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX proactive_candidates_bot ON proactive_candidates(bot_id, created_at);
CREATE INDEX proactive_candidates_offer ON proactive_candidates(offer_id);
`,
};
