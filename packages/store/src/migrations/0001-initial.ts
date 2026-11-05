import type { Migration } from "../migrate.ts";

const appendOnly = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
`;

const FINISH_REASONS =
  "'completed','cancelled','failed','interrupted','max_turns','awaiting_input','handed_off'";
const INITIATORS = "'user','schedule','agent','webhook'";

export const initialSchema: Migration = {
  version: 1,
  name: "initial schema",
  sql: `
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE TABLE runs (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES threads(id),
  parent_run_id  TEXT REFERENCES runs(id),
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','waiting','finished')),
  finish_reason  TEXT CHECK (finish_reason IS NULL OR finish_reason IN (${FINISH_REASONS})),
  initiator_kind TEXT NOT NULL CHECK (initiator_kind IN (${INITIATORS})),
  initiator_id   TEXT NOT NULL,
  engine         TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  CHECK ((status = 'finished') = (finish_reason IS NOT NULL))
) STRICT;
CREATE INDEX runs_by_thread ON runs(thread_id, started_at);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  run_id     TEXT REFERENCES runs(id),
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX messages_by_thread ON messages(thread_id, created_at);

-- Raw protocol events per run, for replay and phone resync. Append-only.
CREATE TABLE run_events (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  seq        INTEGER NOT NULL CHECK (seq >= 0),
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;
${appendOnly("run_events")}

-- One job tree for turns, tool calls, sub-agents, schedules, watches, browser tasks.
CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,
  parent_id         TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
  thread_id         TEXT REFERENCES threads(id),
  kind              TEXT NOT NULL
                    CHECK (kind IN ('turn','tool','subagent','schedule','watch','browser_task')),
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
  title             TEXT,
  attempt           INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  outbound_observed INTEGER NOT NULL DEFAULT 0 CHECK (outbound_observed IN (0,1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  finished_at       TEXT,
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;
CREATE INDEX jobs_by_parent ON jobs(parent_id);
CREATE INDEX jobs_by_status ON jobs(status, kind);
-- Once a job has been seen sending something outward it can never be reset to "safe to re-run".
CREATE TRIGGER jobs_outbound_sticky BEFORE UPDATE OF outbound_observed ON jobs
WHEN OLD.outbound_observed = 1 AND NEW.outbound_observed = 0
BEGIN SELECT RAISE(ABORT, 'outbound_observed cannot be cleared'); END;

CREATE TABLE job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES jobs(id),
  seq        INTEGER NOT NULL CHECK (seq >= 0),
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  UNIQUE (job_id, seq)
) STRICT;
${appendOnly("job_events")}

-- Hash-chained audit trail: written BEFORE an action executes. Append-only.
CREATE TABLE audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  initiator_kind TEXT NOT NULL CHECK (initiator_kind IN (${INITIATORS})),
  initiator_id   TEXT NOT NULL,
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  action         TEXT NOT NULL,
  action_class   TEXT NOT NULL,
  target         TEXT,
  decision       TEXT NOT NULL CHECK (decision IN ('allow','deny','ask')),
  detail         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  prev_hash      TEXT,
  hash           TEXT NOT NULL UNIQUE
) STRICT;
${appendOnly("audit_log")}

CREATE TABLE approvals (
  id               TEXT PRIMARY KEY,
  run_id           TEXT REFERENCES runs(id),
  call_id          TEXT,
  action_class     TEXT NOT NULL,
  summary          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','denied','expired')),
  requested_at     TEXT NOT NULL,
  expires_at       TEXT,
  resolved_at      TEXT,
  resolved_by_kind TEXT,
  resolved_by_id   TEXT,
  CHECK ((status = 'pending') = (resolved_at IS NULL))
) STRICT;
CREATE INDEX approvals_pending ON approvals(status) WHERE status = 'pending';
CREATE TRIGGER approvals_final BEFORE UPDATE ON approvals
WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'approval already resolved'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are kept for audit'); END;

-- Paired phones / browsers reached over Alca Link.
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  pubkey       TEXT NOT NULL UNIQUE,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '["chat"]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
) STRICT;
CREATE TRIGGER devices_revoke_final BEFORE UPDATE OF revoked_at ON devices
WHEN OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NULL OR NEW.revoked_at <> OLD.revoked_at)
BEGIN SELECT RAISE(ABORT, 'device revocation is permanent'); END;

-- Memory: shared user model + per-agent working notes.
-- search_terms is CJK bigram-segmented by app code (see cjk.ts); FTS mirrors it via triggers.
CREATE TABLE memory_items (
  n            INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL CHECK (scope IN ('user_model','agent_notes')),
  agent_id     TEXT,
  kind         TEXT NOT NULL DEFAULT 'fact',
  body         TEXT NOT NULL,
  source_quote TEXT,
  search_terms TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT,
  CHECK ((scope = 'agent_notes') = (agent_id IS NOT NULL))
) STRICT;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  search_terms,
  content = 'memory_items',
  content_rowid = 'n',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER memory_items_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts(rowid, search_terms) VALUES (NEW.n, NEW.search_terms);
END;
CREATE TRIGGER memory_items_ad AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, search_terms) VALUES ('delete', OLD.n, OLD.search_terms);
END;
CREATE TRIGGER memory_items_au AFTER UPDATE OF search_terms ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, search_terms) VALUES ('delete', OLD.n, OLD.search_terms);
  INSERT INTO memory_fts(rowid, search_terms) VALUES (NEW.n, NEW.search_terms);
END;
`,
};
