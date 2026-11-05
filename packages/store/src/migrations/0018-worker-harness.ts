import type { Migration } from "../migrate.ts";

/**
 * Plan §2.9 (migration 18, cut again on `feat/worker-harness`): the worker
 * harness ledger.
 *
 * - `bots.harness`: a bot's choice per harness (`coding` / `general`) —
 *   engine + model and budget caps — as one JSON object; NULL = defaults.
 * - `dispatches`: one row per task the router dispatched to a harness. A
 *   continuation worker (after an answer, a wake or a restart) serves the
 *   same row. `active_worker_id` / `active_run_id` are the writer fence: only
 *   the current execution may write a result or a report.
 * - `dispatch_events`: append-only (triggers refuse UPDATE, and DELETE while
 *   the dispatch still exists). Unique indexes make "one report per
 *   execution", "one end event per turn" and "one answer per wait" hold even
 *   if code above calls twice.
 * - `harness_waits`: an open NEEDS_INPUT (or, from Phase 4, an awaited
 *   event). A wake claims the wait by compare-and-set before any worker exists.
 */
export const workerHarnessSchema: Migration = {
  version: 18,
  name: "bots.harness + dispatches + dispatch_events + harness_waits",
  sql: `
ALTER TABLE bots ADD COLUMN harness TEXT CHECK (harness IS NULL OR (json_valid(harness) AND length(harness) <= 4000));

CREATE TABLE dispatches (
  id               TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  harness          TEXT CHECK (harness IS NULL OR harness IN ('coding','general')),
  level            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued','running','needs_input','waiting_event','needs_review','settled')),
  outcome          TEXT CHECK (outcome IS NULL OR outcome IN ('done','partial','needs_input','blocked','unverified','stopped','failed','budget','expired','interrupted','interrupted_after_outward')),
  active_worker_id TEXT,
  active_run_id    TEXT,
  requeues         INTEGER NOT NULL DEFAULT 0 CHECK (requeues >= 0),
  report           TEXT CHECK (report IS NULL OR json_valid(report)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  CHECK ((status = 'settled') = (finished_at IS NOT NULL)),
  CHECK (status <> 'settled' OR outcome IS NOT NULL)
);
CREATE INDEX dispatches_open ON dispatches(status) WHERE finished_at IS NULL;
CREATE INDEX dispatches_finished ON dispatches(finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE dispatch_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  run_id      TEXT,
  turn_id     TEXT,
  wait_id     TEXT,
  detail      TEXT CHECK (detail IS NULL OR json_valid(detail)),
  at          INTEGER NOT NULL
);
CREATE INDEX dispatch_events_of ON dispatch_events(dispatch_id, seq);
CREATE UNIQUE INDEX dispatch_one_report_per_run ON dispatch_events(dispatch_id, run_id) WHERE kind = 'reported';
CREATE UNIQUE INDEX dispatch_one_end_per_turn ON dispatch_events(dispatch_id, turn_id)
  WHERE kind IN ('turn.completed','turn.failed','turn.interrupted');
CREATE UNIQUE INDEX dispatch_one_answer_per_wait ON dispatch_events(wait_id) WHERE kind = 'answered';
CREATE TRIGGER dispatch_events_append_only_u BEFORE UPDATE ON dispatch_events
BEGIN SELECT RAISE(ABORT, 'dispatch_events is append-only'); END;
CREATE TRIGGER dispatch_events_append_only_d BEFORE DELETE ON dispatch_events
WHEN EXISTS (SELECT 1 FROM dispatches WHERE id = OLD.dispatch_id)
BEGIN SELECT RAISE(ABORT, 'dispatch_events is append-only'); END;

CREATE TABLE harness_waits (
  id          TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  bot_id      TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  worker_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('needs_input','event')),
  questions   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(questions)),
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','claimed','closed','expired')),
  claimed_by  TEXT,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  CHECK (state <> 'open' OR (claimed_by IS NULL AND closed_at IS NULL))
);
CREATE INDEX harness_waits_open ON harness_waits(state, expires_at);
CREATE INDEX harness_waits_dispatch ON harness_waits(dispatch_id);
CREATE UNIQUE INDEX harness_waits_one_open ON harness_waits(dispatch_id) WHERE state IN ('open','claimed');
`,
};
