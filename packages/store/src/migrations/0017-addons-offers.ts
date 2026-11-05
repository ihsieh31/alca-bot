import type { Migration } from "../migrate.ts";

/**
 * P14 (migration 17; plan v10 calls it "migration 11", a number that had
 * already shipped for the provider tables, so it is the next free one):
 *
 * - `bot_addons`: which built-in add-on a bot turned on, its settings and its
 *   own small state (the scan cursor of 主動留意). A row that is turned off
 *   keeps its settings and state, so turning it back on starts from now.
 * - `addon_usage`: per bot, add-on and local day — runs and tokens — so a
 *   daily cap can stop an add-on that spends on its own.
 * - `offers`: every offer a bot made (at the end of a reply, or from an
 *   add-on), what the person did with it, and when. A decided offer is final.
 * - `memories.applies_to`: the kinds of action a memory must be followed for
 *   (寫信 → send_message …); `memories.due_at`: a deadline the person
 *   mentioned. Both are set on insert only, like the rest of a memory.
 */
export const addonsOffersSchema: Migration = {
  version: 17,
  name: "bot_addons + addon_usage + offers; memories.applies_to + due_at",
  sql: `
CREATE TABLE bot_addons (
  bot_id        TEXT NOT NULL,
  addon_id      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  settings_json TEXT NOT NULL DEFAULT '{}',
  state_json    TEXT NOT NULL DEFAULT '{}',
  enabled_at    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (bot_id, addon_id)
) STRICT;

CREATE TABLE addon_usage (
  bot_id        TEXT NOT NULL,
  addon_id      TEXT NOT NULL,
  day           TEXT NOT NULL,
  runs          INTEGER NOT NULL DEFAULT 0 CHECK (runs >= 0),
  input_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  capped_at     TEXT,
  PRIMARY KEY (bot_id, addon_id, day)
) STRICT;

CREATE TABLE offers (
  id            TEXT PRIMARY KEY,
  bot_id        TEXT NOT NULL,
  thread_id     TEXT,
  source        TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('project','errand','money_account','social','study','other')),
  topic         TEXT NOT NULL DEFAULT '',
  text          TEXT NOT NULL,
  action        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','declined','ignored','expired')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  score         REAL,
  due_at        TEXT,
  queued        INTEGER NOT NULL DEFAULT 0 CHECK (queued IN (0, 1)),
  shown_at      TEXT,
  worker_id     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  decided_at    TEXT
) STRICT;
CREATE INDEX offers_bot ON offers(bot_id, status, created_at);
CREATE INDEX offers_thread ON offers(thread_id, status);
CREATE TRIGGER offers_decided_final BEFORE UPDATE OF status ON offers
  WHEN OLD.status <> 'pending' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'a decided offer is final'); END;
CREATE TRIGGER offers_owner_fixed BEFORE UPDATE OF bot_id, source, text, created_at ON offers
BEGIN SELECT RAISE(ABORT, 'an offer is not rewritten'); END;

ALTER TABLE memories ADD COLUMN applies_to TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN due_at TEXT;
CREATE TRIGGER memories_applies_final BEFORE UPDATE OF applies_to, due_at ON memories
BEGIN SELECT RAISE(ABORT, 'memories are superseded, not overwritten'); END;
`,
};
