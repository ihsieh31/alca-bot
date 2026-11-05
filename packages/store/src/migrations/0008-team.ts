import type { Migration } from "../migrate.ts";

const appendOnly = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
`;

const PEER_STATUS = "'running','done','failed','denied','refused','stopped'";
const PEER_FINAL = "'done','failed','denied','refused','stopped'";
const INITIATORS = "'user','schedule','agent','webhook'";

/**
 * P7: the team. A bot gets a profile (avatar, color, role, own instructions,
 * engine + model, approval level, browser profile, memory mode, lead flag);
 * archiving keeps every row it owns. Bots ask each other through
 * `peer_requests` (one per ask / delegation; the work happens in a peer
 * thread owned by the asked bot) with an append-only `peer_events` trail.
 * `team_meta` holds the team rules (peer approval, depth limit).
 * `engine_providers` are the model services a bot can run on (OpenAI-compatible
 * HTTP, Gemini); their keys live in the local vault, never here.
 * `runs.bot_id` says which bot spoke in a run (a thread can hear from several
 * bots when the person @mentions one).
 */
export const teamSchema: Migration = {
  version: 8,
  name: "team: bot profiles, peer requests, team rules, engine providers",
  sql: `
ALTER TABLE bots ADD COLUMN avatar TEXT CHECK (avatar IS NULL OR length(avatar) BETWEEN 1 AND 4);
ALTER TABLE bots ADD COLUMN color TEXT CHECK (color IS NULL OR color IN ('ink','vermilion','jade','indigo','ochre','plum'));
ALTER TABLE bots ADD COLUMN role TEXT CHECK (role IS NULL OR length(role) <= 120);
ALTER TABLE bots ADD COLUMN instructions TEXT CHECK (instructions IS NULL OR length(instructions) <= 4000);
ALTER TABLE bots ADD COLUMN model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200);
ALTER TABLE bots ADD COLUMN approval_level TEXT CHECK (approval_level IS NULL OR approval_level IN ('autonomous','confirm_each_step'));
ALTER TABLE bots ADD COLUMN browser_profile TEXT NOT NULL DEFAULT 'shared' CHECK (browser_profile IN ('shared','isolated','isolated_keep'));
ALTER TABLE bots ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'team' CHECK (memory_mode IN ('team','own','off'));
ALTER TABLE bots ADD COLUMN is_lead INTEGER NOT NULL DEFAULT 0 CHECK (is_lead IN (0,1));
ALTER TABLE bots ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX bots_one_lead ON bots(is_lead) WHERE is_lead = 1;
-- The default bot is the team's anchor: it is never archived.
CREATE TRIGGER bots_default_kept BEFORE UPDATE OF archived_at ON bots
WHEN NEW.archived_at IS NOT NULL AND OLD.is_default = 1
BEGIN SELECT RAISE(ABORT, 'the default bot cannot be archived'); END;
-- An archived bot is not the lead.
CREATE TRIGGER bots_archived_not_lead BEFORE UPDATE OF is_lead ON bots
WHEN NEW.is_lead = 1 AND OLD.archived_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'an archived bot cannot lead'); END;

ALTER TABLE runs ADD COLUMN bot_id TEXT REFERENCES bots(id);

ALTER TABLE threads ADD COLUMN peer_request_id TEXT;

CREATE TABLE team_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE peer_requests (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('ask','delegate')),
  from_bot_id     TEXT NOT NULL REFERENCES bots(id),
  to_bot_id       TEXT NOT NULL REFERENCES bots(id),
  from_thread_id  TEXT NOT NULL REFERENCES threads(id),
  from_run_id     TEXT REFERENCES runs(id),
  root_thread_id  TEXT NOT NULL REFERENCES threads(id),
  peer_thread_id  TEXT REFERENCES threads(id),
  parent_id       TEXT REFERENCES peer_requests(id),
  depth           INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 16),
  chain           TEXT NOT NULL,
  text            TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
  status          TEXT NOT NULL CHECK (status IN (${PEER_STATUS})),
  reason          TEXT,
  result          TEXT,
  approval_id     TEXT,
  initiator_kind  TEXT NOT NULL CHECK (initiator_kind IN (${INITIATORS})),
  initiator_id    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  finished_at     TEXT,
  CHECK (from_bot_id <> to_bot_id),
  CHECK ((status IN (${PEER_FINAL})) = (finished_at IS NOT NULL))
) STRICT;
CREATE INDEX peer_requests_by_root ON peer_requests(root_thread_id, created_at);
CREATE INDEX peer_requests_by_peer_thread ON peer_requests(peer_thread_id);
CREATE INDEX peer_requests_open ON peer_requests(to_bot_id) WHERE status = 'running';
CREATE TRIGGER peer_requests_fixed BEFORE UPDATE OF id, kind, from_bot_id, to_bot_id, from_thread_id, root_thread_id, depth, chain, text ON peer_requests
BEGIN SELECT RAISE(ABORT, 'a peer request does not change who asked whom for what'); END;
CREATE TRIGGER peer_requests_final BEFORE UPDATE OF status ON peer_requests
WHEN OLD.status IN (${PEER_FINAL})
BEGIN SELECT RAISE(ABORT, 'a finished peer request is final'); END;
CREATE TRIGGER peer_requests_no_delete BEFORE DELETE ON peer_requests
BEGIN SELECT RAISE(ABORT, 'peer requests are kept'); END;

CREATE TABLE peer_events (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES peer_requests(id),
  kind        TEXT NOT NULL CHECK (kind IN ('requested','approval','approved','denied','refused','started','card','answered','failed','stopped')),
  bot_id      TEXT REFERENCES bots(id),
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX peer_events_by_request ON peer_events(request_id, created_at);
${appendOnly("peer_events")}

CREATE TABLE engine_providers (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('openai','gemini')),
  label       TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  base_url    TEXT NOT NULL CHECK (length(base_url) BETWEEN 8 AND 500),
  model       TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  has_key     INTEGER NOT NULL DEFAULT 0 CHECK (has_key IN (0,1)),
  created_at  TEXT NOT NULL,
  removed_at  TEXT
) STRICT;

-- Peer reports wake the asking bot's router; peer requests wake the asked bot's.
CREATE TABLE router_inbox_v8 (
  id             TEXT PRIMARY KEY,
  bot_id         TEXT NOT NULL REFERENCES bots(id),
  thread_id      TEXT NOT NULL REFERENCES threads(id),
  kind           TEXT NOT NULL CHECK (kind IN ('worker_report','trigger','peer_request','peer_report')),
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
INSERT INTO router_inbox_v8 SELECT * FROM router_inbox;
DROP TABLE router_inbox;
ALTER TABLE router_inbox_v8 RENAME TO router_inbox;
CREATE INDEX router_inbox_pending ON router_inbox(bot_id, created_at) WHERE status = 'pending';
`,
};
