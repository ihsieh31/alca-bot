import type { Migration } from "../migrate.ts";

/**
 * P13 agent features.
 *
 * - `bots`: the bot's working folder (`work_dir`, NULL = `<data>/bots/<id>/work`),
 *   the optional small-model shell review (`shell_review` off | on, with an
 *   optional engine + model to ask instead of the bot's own), 提前做
 *   (`early_work` off | on) and its quiet hours (`HH:MM-HH:MM`, the core's zone).
 * - `file_snapshots`: the content of a file just before a bot's edit, so a
 *   turn's edits can be undone. `turn_run_id` is the person's turn (the
 *   router run that dispatched the worker, or the run itself). `undone_at`
 *   and `pruned_at` are final; rows are never updated otherwise.
 * - `early_work`: what a bot prepares ahead (from a trigger event or a
 *   request) — queued until quiet hours end, the daily cap and capacity allow,
 *   then a speculative worker; its result becomes a draft the person approves.
 */
export const agentFeaturesSchema: Migration = {
  version: 12,
  name: "bots: work folder, shell review, early work; file snapshots; early work queue",
  sql: `
ALTER TABLE bots ADD COLUMN work_dir TEXT CHECK (work_dir IS NULL OR length(work_dir) BETWEEN 1 AND 1000);
ALTER TABLE bots ADD COLUMN shell_review TEXT NOT NULL DEFAULT 'off' CHECK (shell_review IN ('off','on'));
ALTER TABLE bots ADD COLUMN shell_review_engine TEXT CHECK (shell_review_engine IS NULL OR length(shell_review_engine) <= 200);
ALTER TABLE bots ADD COLUMN shell_review_model TEXT CHECK (shell_review_model IS NULL OR length(shell_review_model) <= 200);
ALTER TABLE bots ADD COLUMN early_work TEXT NOT NULL DEFAULT 'off' CHECK (early_work IN ('off','on'));
ALTER TABLE bots ADD COLUMN quiet_hours TEXT CHECK (quiet_hours IS NULL OR quiet_hours GLOB '[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]');

CREATE TABLE file_snapshots (
  id           TEXT PRIMARY KEY,
  bot_id       TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  turn_run_id  TEXT NOT NULL,
  worker_id    TEXT,
  tool         TEXT NOT NULL,
  path         TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  existed      INTEGER NOT NULL CHECK (existed IN (0,1)),
  content      BLOB,
  mode         INTEGER,
  size         INTEGER NOT NULL DEFAULT 0,
  skipped      TEXT,
  created_at   TEXT NOT NULL,
  undone_at    TEXT,
  pruned_at    TEXT
) STRICT;
CREATE INDEX file_snapshots_turn ON file_snapshots(thread_id, turn_run_id);
CREATE INDEX file_snapshots_path ON file_snapshots(path, created_at);
CREATE TRIGGER file_snapshots_fixed BEFORE UPDATE OF id, bot_id, thread_id, run_id, turn_run_id, path, existed, created_at ON file_snapshots
BEGIN SELECT RAISE(ABORT, 'a snapshot never changes'); END;
CREATE TRIGGER file_snapshots_undone_final BEFORE UPDATE OF undone_at ON file_snapshots
WHEN OLD.undone_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'an undone snapshot stays undone'); END;
CREATE TRIGGER file_snapshots_pruned_final BEFORE UPDATE OF pruned_at ON file_snapshots
WHEN OLD.pruned_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a pruned snapshot stays pruned'); END;

CREATE TABLE early_work (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id),
  thread_id   TEXT NOT NULL REFERENCES threads(id),
  source      TEXT NOT NULL CHECK (source IN ('trigger','request')),
  ref_id      TEXT,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  goal        TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 8000),
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','skipped','failed')),
  not_before  TEXT,
  worker_id   TEXT,
  draft_ids   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(draft_ids)),
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX early_work_ref ON early_work(bot_id, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX early_work_queue ON early_work(status, created_at);
CREATE TRIGGER early_work_owner_fixed BEFORE UPDATE OF bot_id, thread_id ON early_work
BEGIN SELECT RAISE(ABORT, 'early work never changes owner'); END;
CREATE TRIGGER early_work_final BEFORE UPDATE OF status ON early_work
WHEN OLD.status IN ('ready','skipped','failed')
BEGIN SELECT RAISE(ABORT, 'a finished early work item is final'); END;
`,
};
