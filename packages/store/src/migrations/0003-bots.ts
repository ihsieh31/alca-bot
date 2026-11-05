import type { Migration } from "../migrate.ts";

/**
 * P2: Alca is always a team of bots (a single-agent user is a team of one).
 * Threads, jobs, approvals and browser Spaces carry the owning `bot_id`.
 * The default bot is created on first launch by `BotRepo.ensureDefault`,
 * which also back-fills rows written before this migration.
 */
export const botsSchema: Migration = {
  version: 3,
  name: "bots: owner of threads, jobs, approvals and browser spaces",
  sql: `
CREATE TABLE bots (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  engine_id   TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at  TEXT NOT NULL,
  archived_at TEXT
) STRICT;
CREATE UNIQUE INDEX bots_one_default ON bots(is_default) WHERE is_default = 1;

ALTER TABLE threads ADD COLUMN bot_id TEXT REFERENCES bots(id);
ALTER TABLE jobs ADD COLUMN bot_id TEXT REFERENCES bots(id);
ALTER TABLE approvals ADD COLUMN bot_id TEXT REFERENCES bots(id);
CREATE INDEX threads_by_bot ON threads(bot_id);

-- A browser Space is a window (or isolated profile) owned by exactly one bot.
CREATE TABLE browser_spaces (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id),
  thread_id   TEXT REFERENCES threads(id),
  -- Reserved for the router/worker split (plan v4): the worker session using the Space.
  worker_id   TEXT,
  title       TEXT NOT NULL,
  profile     TEXT NOT NULL CHECK (profile IN ('shared','isolated')),
  persistent  INTEGER NOT NULL DEFAULT 0 CHECK (persistent IN (0,1)),
  created_at  TEXT NOT NULL,
  closed_at   TEXT,
  CHECK (profile = 'isolated' OR persistent = 0)
) STRICT;
CREATE INDEX browser_spaces_by_bot ON browser_spaces(bot_id) WHERE closed_at IS NULL;
-- Ownership is fixed for the life of a Space.
CREATE TRIGGER browser_spaces_owner_fixed BEFORE UPDATE OF bot_id ON browser_spaces
WHEN NEW.bot_id <> OLD.bot_id
BEGIN SELECT RAISE(ABORT, 'space owner cannot change'); END;
`,
};
