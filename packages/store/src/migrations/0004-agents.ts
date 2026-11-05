import type { Migration } from "../migrate.ts";

const appendOnly = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
`;

const WORKER_STATUS = "'queued','running','waiting','succeeded','failed','stopped','needs_review'";
const INITIATORS = "'user','schedule','agent','webhook'";

/**
 * P3 super-agent core (plan v4). Every bot is a resident router session plus
 * one isolated worker per task. All of it lives here, so the engine processes
 * can restart at any time and pick up where the store says they were:
 *
 * - `router_sessions`: the bot's one long-lived router conversation.
 * - `workers`: one row per task, with its own job, engine conversation
 *   (`engine_conversations` keyed by the worker id), runs (`runs.worker_id`)
 *   and browser Space (`browser_spaces.worker_id`, reserved in migration 3).
 * - `spills`: large results kept out of the router's context (append-only),
 *   recalled on demand by id.
 * - `router_inbox` / `worker_inbox`: results and events waiting to be
 *   delivered; a pending row survives a restart and is delivered after it.
 * - `streams` + `stream_subscriptions`: follow-up events of one stream go
 *   straight to the workers subscribed to it.
 * - `triggers` + `trigger_events` (append-only): pluggable sources and the
 *   two-stage filter's verdicts.
 * - `watchdog_events` (append-only): what the watchdog stopped and why.
 */
export const agentsSchema: Migration = {
  version: 4,
  name: "agents: router sessions, workers, spills, inboxes, streams, triggers, watchdog",
  sql: `
ALTER TABLE runs ADD COLUMN worker_id TEXT;
CREATE INDEX runs_by_worker ON runs(worker_id) WHERE worker_id IS NOT NULL;
ALTER TABLE approvals ADD COLUMN worker_id TEXT;

-- Engine conversations that are not a thread (a bot's router, a worker).
CREATE TABLE engine_conversations (
  key        TEXT NOT NULL,
  engine_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, engine_id)
) STRICT;

CREATE TABLE router_sessions (
  bot_id       TEXT PRIMARY KEY REFERENCES bots(id),
  session_key  TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_turn_at TEXT
) STRICT;

CREATE TABLE workers (
  id               TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL REFERENCES bots(id),
  thread_id        TEXT NOT NULL REFERENCES threads(id),
  job_id           TEXT NOT NULL REFERENCES jobs(id),
  parent_run_id    TEXT REFERENCES runs(id),
  run_id           TEXT REFERENCES runs(id),
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  goal             TEXT NOT NULL,
  initiator_kind   TEXT NOT NULL CHECK (initiator_kind IN (${INITIATORS})),
  initiator_id     TEXT NOT NULL,
  speculative      INTEGER NOT NULL DEFAULT 0 CHECK (speculative IN (0,1)),
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (${WORKER_STATUS})),
  steps            INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0),
  tokens           INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  budget           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(budget)),
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  last_activity_at TEXT,
  waiting_since    TEXT,
  waited_ms        INTEGER NOT NULL DEFAULT 0 CHECK (waited_ms >= 0),
  stop_reason      TEXT,
  result_mode      TEXT CHECK (result_mode IS NULL OR result_mode IN ('inline','spill')),
  result_summary   TEXT,
  result_chars     INTEGER,
  spill_id         TEXT,
  CHECK ((result_mode = 'spill') = (spill_id IS NOT NULL))
) STRICT;
CREATE INDEX workers_by_thread ON workers(thread_id, created_at);
CREATE INDEX workers_active ON workers(bot_id) WHERE status IN ('queued','running','waiting');
CREATE TRIGGER workers_owner_fixed BEFORE UPDATE OF bot_id, thread_id ON workers
WHEN NEW.bot_id <> OLD.bot_id OR NEW.thread_id <> OLD.thread_id
BEGIN SELECT RAISE(ABORT, 'worker owner cannot change'); END;
CREATE TRIGGER workers_terminal_final BEFORE UPDATE OF status ON workers
WHEN OLD.status IN ('succeeded','failed','stopped') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'worker already finished'); END;

CREATE TABLE spills (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('worker','trigger_event')),
  owner_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  chars      INTEGER NOT NULL CHECK (chars >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX spills_by_owner ON spills(owner_id);
${appendOnly("spills")}

CREATE TABLE router_inbox (
  id             TEXT PRIMARY KEY,
  bot_id         TEXT NOT NULL REFERENCES bots(id),
  thread_id      TEXT NOT NULL REFERENCES threads(id),
  kind           TEXT NOT NULL CHECK (kind IN ('worker_report','trigger')),
  ref_id         TEXT NOT NULL,
  body           TEXT NOT NULL,
  initiator_kind TEXT NOT NULL CHECK (initiator_kind IN (${INITIATORS})),
  initiator_id   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered')),
  run_id         TEXT REFERENCES runs(id),
  created_at     TEXT NOT NULL,
  delivered_at   TEXT,
  CHECK ((status = 'delivered') = (run_id IS NOT NULL))
) STRICT;
CREATE INDEX router_inbox_pending ON router_inbox(bot_id, created_at) WHERE status = 'pending';

CREATE TABLE streams (
  id            TEXT PRIMARY KEY,
  bot_id        TEXT NOT NULL REFERENCES bots(id),
  key           TEXT NOT NULL,
  title         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_event_at TEXT,
  UNIQUE (bot_id, key)
) STRICT;

CREATE TABLE stream_subscriptions (
  stream_id  TEXT NOT NULL REFERENCES streams(id),
  worker_id  TEXT NOT NULL REFERENCES workers(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (stream_id, worker_id)
) STRICT;

CREATE TABLE worker_inbox (
  id           TEXT PRIMARY KEY,
  worker_id    TEXT NOT NULL REFERENCES workers(id),
  stream_id    TEXT REFERENCES streams(id),
  event_id     TEXT,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered')),
  created_at   TEXT NOT NULL,
  delivered_at TEXT
) STRICT;
CREATE INDEX worker_inbox_pending ON worker_inbox(worker_id, created_at) WHERE status = 'pending';

CREATE TABLE triggers (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id),
  thread_id   TEXT NOT NULL REFERENCES threads(id),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  source      TEXT NOT NULL CHECK (source IN ('timer','manual','im','email','github','webhook')),
  config      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  rule        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rule)),
  semantic    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  schedule_id TEXT REFERENCES schedules(id),
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX triggers_by_bot ON triggers(bot_id);

CREATE TABLE trigger_events (
  id           TEXT PRIMARY KEY,
  trigger_id   TEXT NOT NULL REFERENCES triggers(id),
  stream_id    TEXT REFERENCES streams(id),
  payload      TEXT NOT NULL CHECK (json_valid(payload)),
  rule_verdict TEXT NOT NULL CHECK (rule_verdict IN ('drop','candidate','explicit')),
  judged       TEXT CHECK (judged IS NULL OR judged IN ('wake','skip')),
  judge_reason TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('dropped','router','workers')),
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX trigger_events_by_trigger ON trigger_events(trigger_id, created_at);
${appendOnly("trigger_events")}

CREATE TABLE watchdog_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id  TEXT NOT NULL REFERENCES workers(id),
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  kind       TEXT NOT NULL CHECK (kind IN ('stuck','looping','over_budget')),
  detail     TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
${appendOnly("watchdog_events")}
`,
};
