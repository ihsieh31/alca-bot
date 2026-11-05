import type { Migration } from "../migrate.ts";

/**
 * P1 runtime tables: engine sessions per thread, question cards, schedules,
 * and job columns for leases, review and payloads.
 *
 * `needs_review` is a column rather than a new `jobs.status` value because a
 * CHECK constraint cannot be altered in place, and rebuilding `jobs` would
 * have to rewrite the foreign keys that point at it.
 */
export const runtimeSchema: Migration = {
  version: 2,
  name: "runtime: sessions, questions, schedules, job leases",
  sql: `
ALTER TABLE jobs ADD COLUMN run_id TEXT REFERENCES runs(id);
ALTER TABLE jobs ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1));
ALTER TABLE jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE jobs ADD COLUMN lease_until TEXT;
ALTER TABLE jobs ADD COLUMN input TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input));
ALTER TABLE jobs ADD COLUMN result TEXT CHECK (result IS NULL OR json_valid(result));
CREATE INDEX jobs_by_run ON jobs(run_id);

-- A finished job stays finished.
CREATE TRIGGER jobs_terminal_final BEFORE UPDATE OF status ON jobs
WHEN OLD.status IN ('succeeded','failed','cancelled') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'job already finished'); END;

-- Which engine conversation a thread continues (e.g. a CLI session id for --resume).
CREATE TABLE engine_sessions (
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  engine_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, engine_id)
) STRICT;

ALTER TABLE approvals ADD COLUMN detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail));

CREATE TABLE questions (
  id          TEXT PRIMARY KEY,
  run_id      TEXT REFERENCES runs(id),
  prompt      TEXT NOT NULL,
  choices     TEXT CHECK (choices IS NULL OR (json_valid(choices) AND json_type(choices) = 'array')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','expired')),
  answer      TEXT,
  asked_at    TEXT NOT NULL,
  answered_at TEXT,
  CHECK ((status = 'pending') = (answered_at IS NULL)),
  CHECK ((status = 'answered') = (answer IS NOT NULL))
) STRICT;
CREATE TRIGGER questions_final BEFORE UPDATE ON questions
WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'question already answered'); END;
CREATE TRIGGER questions_no_delete BEFORE DELETE ON questions
BEGIN SELECT RAISE(ABORT, 'questions are kept for audit'); END;

-- Schedules dispatch at most once per due time: the cursor (next_due_at) is
-- advanced and committed BEFORE the job is dispatched.
CREATE TABLE schedules (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('once','interval')),
  interval_sec       INTEGER CHECK (interval_sec IS NULL OR interval_sec > 0),
  next_due_at        TEXT,
  last_dispatched_at TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  payload            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  created_at         TEXT NOT NULL,
  CHECK ((kind = 'interval') = (interval_sec IS NOT NULL))
) STRICT;
CREATE INDEX schedules_due ON schedules(next_due_at) WHERE enabled = 1 AND next_due_at IS NOT NULL;
`,
};
