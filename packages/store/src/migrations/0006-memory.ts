import type { Migration } from "../migrate.ts";

/**
 * P5 memory + learning, per bot.
 *
 * - `memories`: durable facts / preferences / people / projects. Every row
 *   names the bot that learned it, whether it is the shared user model
 *   (`shared`, read by every bot of the team) or the bot's own notes (`bot`),
 *   where it came from (thread / message / run / worker), how sure Alca is,
 *   and whether the person said it (`user`) or Alca inferred it. Content is
 *   never overwritten: an edit or a correction inserts a new row that
 *   `supersedes` the old one, which becomes `superseded` for good. Forgetting
 *   is a hard DELETE of the whole chain plus a tombstone.
 * - `memory_tombstones`: what was forgotten, as keyed hashes only (no text),
 *   so extraction does not learn it again.
 * - `memory_meta`: the per-store key for those hashes.
 * - `skills` + `skill_versions`: reusable playbooks proposed after a task and
 *   saved only when the person approves; versions are append-only.
 *
 * - `workers.grants`: memory / skill ids the router passed to a worker.
 *
 * The P0 `memory_items` table is folded into `memories` and dropped.
 */
export const memorySchema: Migration = {
  version: 6,
  name: "memory: durable per-bot memory with provenance, tombstones, skills",
  sql: `
CREATE TABLE memories (
  n                 INTEGER PRIMARY KEY,
  id                TEXT NOT NULL UNIQUE,
  bot_id            TEXT NOT NULL REFERENCES bots(id),
  scope             TEXT NOT NULL CHECK (scope IN ('shared','bot')),
  kind              TEXT NOT NULL CHECK (kind IN ('fact','preference','person','project')),
  -- Normalized topic key ('' = none); a new item with the same key supersedes the old one.
  subject           TEXT NOT NULL DEFAULT '',
  body              TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  -- The person's own words it came from (redacted), when there are any.
  quote             TEXT,
  origin            TEXT NOT NULL CHECK (origin IN ('user','inferred')),
  confidence        REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  supersedes        TEXT,
  superseded_by     TEXT,
  source_kind       TEXT NOT NULL CHECK (source_kind IN ('chat','ui','migrated')),
  source_thread_id  TEXT,
  source_message_id TEXT,
  source_run_id     TEXT,
  source_worker_id  TEXT,
  search_terms      TEXT NOT NULL,
  embedding         BLOB,
  embedding_model   TEXT,
  uses              INTEGER NOT NULL DEFAULT 0,
  last_used_at      TEXT,
  confirmed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  CHECK (origin = 'inferred' OR confirmed_at IS NOT NULL)
) STRICT;
CREATE INDEX memories_active ON memories(bot_id, scope, kind) WHERE status = 'active';
CREATE INDEX memories_subject ON memories(subject) WHERE status = 'active' AND subject <> '';
CREATE INDEX memories_chain ON memories(supersedes);

-- Content is final: change it by inserting a new row that supersedes this one.
CREATE TRIGGER memories_content_final
BEFORE UPDATE OF bot_id, kind, subject, body, quote, supersedes, source_kind, source_thread_id,
  source_message_id, source_run_id, source_worker_id, created_at ON memories
BEGIN SELECT RAISE(ABORT, 'memories are superseded, not overwritten'); END;
CREATE TRIGGER memories_superseded_final BEFORE UPDATE OF status, superseded_by ON memories
WHEN OLD.status = 'superseded'
BEGIN SELECT RAISE(ABORT, 'a superseded memory stays superseded'); END;
CREATE TRIGGER memories_confirmed_final BEFORE UPDATE OF origin ON memories
WHEN OLD.origin = 'user' AND NEW.origin <> 'user'
BEGIN SELECT RAISE(ABORT, 'a confirmed memory cannot become inferred'); END;

-- search_terms is CJK bigram-segmented by app code (cjk.ts); FTS mirrors it.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  search_terms,
  content = 'memories',
  content_rowid = 'n',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, search_terms) VALUES (NEW.n, NEW.search_terms);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, search_terms) VALUES ('delete', OLD.n, OLD.search_terms);
END;

CREATE TABLE memory_tombstones (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id),
  -- Keyed hash of the normalized text, and keyed short hashes of its tokens. No plaintext.
  digest      TEXT NOT NULL,
  shingles    TEXT NOT NULL CHECK (json_valid(shingles) AND json_type(shingles) = 'array'),
  reason      TEXT NOT NULL CHECK (reason IN ('forget','never_learn')),
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX memory_tombstones_by_bot ON memory_tombstones(bot_id);
CREATE TRIGGER memory_tombstones_final BEFORE UPDATE ON memory_tombstones
BEGIN SELECT RAISE(ABORT, 'tombstones are final'); END;

CREATE TABLE memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
INSERT INTO memory_meta (key, value) VALUES ('tombstone_key', lower(hex(randomblob(32))));

CREATE TABLE skills (
  n                INTEGER PRIMARY KEY,
  id               TEXT NOT NULL UNIQUE,
  bot_id           TEXT NOT NULL REFERENCES bots(id),
  status           TEXT NOT NULL CHECK (status IN ('proposed','active','disabled','rejected')),
  -- The approved version in use (0 = never approved).
  version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  source_thread_id TEXT,
  source_worker_id TEXT,
  source_run_id    TEXT,
  uses             INTEGER NOT NULL DEFAULT 0,
  last_used_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (status NOT IN ('active','disabled') OR version > 0)
) STRICT;
CREATE INDEX skills_by_bot ON skills(bot_id, status);
CREATE TRIGGER skills_owner_fixed BEFORE UPDATE OF bot_id ON skills
WHEN NEW.bot_id <> OLD.bot_id
BEGIN SELECT RAISE(ABORT, 'skill owner cannot change'); END;

CREATE TABLE skill_versions (
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL CHECK (version >= 1),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description     TEXT NOT NULL DEFAULT '',
  triggers        TEXT NOT NULL CHECK (json_valid(triggers) AND json_type(triggers) = 'array'),
  steps           TEXT NOT NULL CHECK (json_valid(steps) AND json_type(steps) = 'array'),
  action_classes  TEXT NOT NULL CHECK (json_valid(action_classes) AND json_type(action_classes) = 'array'),
  state           TEXT NOT NULL CHECK (state IN ('proposed','approved','rejected')),
  author          TEXT NOT NULL CHECK (author IN ('agent','user')),
  note            TEXT,
  created_at      TEXT NOT NULL,
  decided_at      TEXT,
  PRIMARY KEY (skill_id, version),
  CHECK ((state = 'proposed') = (decided_at IS NULL))
) STRICT;
CREATE TRIGGER skill_versions_final
BEFORE UPDATE OF skill_id, version, name, description, triggers, steps, action_classes, author, note, created_at
ON skill_versions
BEGIN SELECT RAISE(ABORT, 'skill versions are append-only'); END;
CREATE TRIGGER skill_versions_decided_final BEFORE UPDATE OF state, decided_at ON skill_versions
WHEN OLD.state <> 'proposed'
BEGIN SELECT RAISE(ABORT, 'a decided skill version is final'); END;

-- What the router handed a worker (memory ids, a skill id), by id only: a forgotten
-- item is simply gone when the worker's task is written, never copied into it.
ALTER TABLE workers ADD COLUMN grants TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(grants));

-- Fold the P0 memory_items into memories (only rows that can name an owning bot).
INSERT INTO memories (id, bot_id, scope, kind, subject, body, quote, origin, confidence, status,
  source_kind, search_terms, confirmed_at, created_at, updated_at)
SELECT 'mem_' || upper(hex(randomblob(13))),
  COALESCE(CASE WHEN m.scope = 'agent_notes' THEN (SELECT b.id FROM bots b WHERE b.id = m.agent_id) END,
           (SELECT b.id FROM bots b WHERE b.is_default = 1)),
  CASE m.scope WHEN 'agent_notes' THEN 'bot' ELSE 'shared' END,
  CASE WHEN m.kind IN ('fact','preference','person','project') THEN m.kind ELSE 'fact' END,
  '', substr(m.body, 1, 2000), m.source_quote, 'user', 0.9, 'active', 'migrated', m.search_terms,
  m.updated_at, m.created_at, m.updated_at
FROM memory_items m
WHERE m.archived_at IS NULL AND length(m.body) > 0
  AND COALESCE(CASE WHEN m.scope = 'agent_notes' THEN (SELECT b.id FROM bots b WHERE b.id = m.agent_id) END,
               (SELECT b.id FROM bots b WHERE b.is_default = 1)) IS NOT NULL;
DROP TABLE memory_fts;
DROP TABLE memory_items;
`,
};
