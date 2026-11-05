import type { Migration } from "../migrate.ts";

/**
 * Care moments (docs/design/CARE-MOMENTS.md): what the care pipeline decided
 * at a moment the person was leaving, which care line was shown, when a
 * timeline item was mentioned, and how the person reacted. The decision
 * policy reads it for cooldowns (one line per thread per day, no repeat
 * across threads within 24 h) and per-category weights; the metrics read it
 * for precision.
 *
 * No user content: ids, a category word, a fixed reason word, numbers — never
 * the event, the line or the message — so the table is not a sealed one.
 * Rows older than 90 days are deleted by the care service; erasing a thread
 * deletes its rows.
 */
export const careLogSchema: Migration = {
  version: 32,
  name: "care_log (care moments: decisions, shown lines, mentions, reactions; no content)",
  sql: `
CREATE TABLE care_log (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL,
  thread_id   TEXT,
  run_id      TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('decision','shown','mention')),
  memory_id   TEXT,
  category    TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  score       REAL,
  reaction    TEXT CHECK (reaction IS NULL OR reaction IN ('positive','ignored','negative')),
  created_at  TEXT NOT NULL,
  reacted_at  TEXT
) STRICT;
CREATE INDEX care_log_bot ON care_log(bot_id, created_at);
CREATE INDEX care_log_thread ON care_log(thread_id, created_at);
CREATE INDEX care_log_memory ON care_log(memory_id, created_at);
`,
};
