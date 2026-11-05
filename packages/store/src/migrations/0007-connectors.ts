import type { Migration } from "../migrate.ts";

/**
 * P6: connected apps, routines, 提前做 drafts.
 *
 * - `connector_accounts`: accounts connected through a provider (Composio is
 *   the primary one). We keep the provider's account id, the app (toolkit), a
 *   label the person chose and a status. OAuth tokens never come here: they
 *   live at the provider (the person accepted that trade-off).
 * - `connector_grants`: which bot may use which account, `read` (read tools
 *   only) or `act` (every tool; send / pay / delete / publish still ask).
 * - `connector_usage`: per day, per bot, per action class (daily quota).
 * - `connector_meta`: provider ids (our user id, session id, relay hook id).
 * - `connector_triggers`: provider trigger instances, each feeding one P3 trigger.
 * - `connector_events_seen`: delivered event ids (replay / duplicate guard).
 * - `routines` + `routine_runs` (append-only) + `routine_items` (the queue of
 *   a trigger-based routine). The data cursor (`cursor`) moves only in the
 *   transaction that saves an AI result; a read failure never touches it.
 * - `drafts`: what a worker prepared ahead (a reply draft); sending one is a
 *   new request that goes through the gateway like any other.
 */
export const connectorsSchema: Migration = {
  version: 7,
  name: "connectors, routines, drafts",
  sql: `
CREATE TABLE connector_accounts (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL CHECK (provider IN ('composio')),
  remote_id  TEXT NOT NULL,
  toolkit    TEXT NOT NULL CHECK (length(toolkit) BETWEEN 1 AND 64),
  label      TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  status     TEXT NOT NULL CHECK (status IN ('pending','active','failed','expired','removed')),
  identity   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, remote_id)
) STRICT;
CREATE INDEX connector_accounts_by_toolkit ON connector_accounts(toolkit, status);
CREATE TRIGGER connector_accounts_fixed BEFORE UPDATE OF provider, remote_id, toolkit ON connector_accounts
WHEN NEW.provider <> OLD.provider OR NEW.remote_id <> OLD.remote_id OR NEW.toolkit <> OLD.toolkit
BEGIN SELECT RAISE(ABORT, 'an account never changes provider, remote id or app'); END;
CREATE TRIGGER connector_accounts_removed_final BEFORE UPDATE OF status ON connector_accounts
WHEN OLD.status = 'removed' AND NEW.status <> 'removed'
BEGIN SELECT RAISE(ABORT, 'a removed account stays removed; connect it again'); END;

CREATE TABLE connector_grants (
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  account_id TEXT NOT NULL REFERENCES connector_accounts(id),
  access     TEXT NOT NULL CHECK (access IN ('read','act')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, account_id)
) STRICT;

CREATE TABLE connector_usage (
  day          TEXT NOT NULL,
  bot_id       TEXT NOT NULL,
  action_class TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, bot_id, action_class)
) STRICT;

CREATE TABLE connector_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE connector_triggers (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES connector_accounts(id),
  slug       TEXT NOT NULL,
  remote_id  TEXT,
  trigger_id TEXT NOT NULL REFERENCES triggers(id),
  config     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  status     TEXT NOT NULL CHECK (status IN ('active','failed','removed')),
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX connector_triggers_by_remote ON connector_triggers(remote_id);

CREATE TABLE connector_events_seen (
  event_id    TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
) STRICT;

CREATE TABLE routines (
  id               TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL REFERENCES bots(id),
  thread_id        TEXT NOT NULL REFERENCES threads(id),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind             TEXT NOT NULL CHECK (kind IN ('interval','cron','once','trigger')),
  interval_sec     INTEGER CHECK (interval_sec IS NULL OR interval_sec >= 60),
  cron             TEXT,
  tz               TEXT,
  run_at           TEXT,
  trigger_id       TEXT REFERENCES triggers(id),
  check_spec       TEXT NOT NULL CHECK (json_valid(check_spec)),
  instructions     TEXT NOT NULL DEFAULT '',
  speculative      INTEGER NOT NULL DEFAULT 0 CHECK (speculative IN (0,1)),
  cursor           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor)),
  next_due_at      TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  fail_count       INTEGER NOT NULL DEFAULT 0,
  backoff_until    TEXT,
  last_error       TEXT,
  last_checked_at  TEXT,
  last_ai_at       TEXT,
  pending_worker   TEXT,
  pending_cursor   TEXT CHECK (pending_cursor IS NULL OR json_valid(pending_cursor)),
  removed_at       TEXT,
  created_at       TEXT NOT NULL,
  CHECK (kind <> 'interval' OR interval_sec IS NOT NULL),
  CHECK (kind <> 'cron' OR (cron IS NOT NULL AND tz IS NOT NULL)),
  CHECK (kind <> 'once' OR run_at IS NOT NULL),
  CHECK (kind <> 'trigger' OR trigger_id IS NOT NULL)
) STRICT;
CREATE INDEX routines_due ON routines(next_due_at) WHERE enabled = 1;
CREATE TRIGGER routines_owner_fixed BEFORE UPDATE OF bot_id, thread_id ON routines
WHEN NEW.bot_id <> OLD.bot_id OR NEW.thread_id <> OLD.thread_id
BEGIN SELECT RAISE(ABORT, 'a routine never changes owner'); END;

CREATE TABLE routine_runs (
  id         TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id),
  bot_id     TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('quiet','new','read_failed','capped','ai_done','ai_invalid','ai_failed')),
  items      INTEGER NOT NULL DEFAULT 0,
  worker_id  TEXT,
  detail     TEXT NOT NULL DEFAULT '',
  output     TEXT CHECK (output IS NULL OR json_valid(output)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX routine_runs_by_routine ON routine_runs(routine_id, created_at);
CREATE INDEX routine_runs_ai ON routine_runs(bot_id, created_at) WHERE outcome = 'new';
CREATE TRIGGER routine_runs_no_update BEFORE UPDATE ON routine_runs
BEGIN SELECT RAISE(ABORT, 'routine_runs is append-only'); END;
CREATE TRIGGER routine_runs_no_delete BEFORE DELETE ON routine_runs
BEGIN SELECT RAISE(ABORT, 'routine_runs is append-only'); END;

CREATE TABLE routine_items (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id TEXT NOT NULL REFERENCES routines(id),
  item_key   TEXT NOT NULL,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  UNIQUE (routine_id, item_key)
);

CREATE TABLE drafts (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  worker_id  TEXT,
  routine_id TEXT,
  account_id TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('reply','message','note')),
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body       TEXT NOT NULL CHECK (length(body) <= 20000),
  target     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(target)),
  status     TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','used','discarded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX drafts_by_thread ON drafts(thread_id, status);
CREATE TRIGGER drafts_final BEFORE UPDATE OF status ON drafts
WHEN OLD.status <> 'ready' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'a used or discarded draft stays that way'); END;
`,
};
