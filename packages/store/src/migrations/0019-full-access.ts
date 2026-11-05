import type { Migration } from "../migrate.ts";

/**
 * Phase 5 (worker harness): the full-access level and the git snapshots it relies on.
 *
 * - `bots.full_access`: the person turned the bot's 完全授權 level on in the
 *   bot's settings. A separate switch (not a new `approval_level` value) so
 *   the existing column keeps its CHECK; the bots repo reads `on` as the
 *   level `full_access`. Off by default; nothing but the bot editor writes it.
 * - `git_snapshots`: one row per hidden snapshot ref
 *   (`refs/alca/snapshots/<dispatchId>/<n>`) taken before a coding turn, so
 *   the sweep can find the repositories it must prune (at most 20 per
 *   folder; seven days after the dispatch settled).
 */
export const fullAccessSchema: Migration = {
  version: 19,
  name: "bots.full_access + git_snapshots",
  sql: `
ALTER TABLE bots ADD COLUMN full_access TEXT NOT NULL DEFAULT 'off' CHECK (full_access IN ('off','on'));

CREATE TABLE git_snapshots (
  ref         TEXT NOT NULL,
  repo        TEXT NOT NULL CHECK (length(repo) BETWEEN 1 AND 2000),
  dispatch_id TEXT NOT NULL,
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  commit_sha  TEXT NOT NULL CHECK (length(commit_sha) BETWEEN 7 AND 64),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (repo, ref)
);
CREATE INDEX git_snapshots_of_dispatch ON git_snapshots(dispatch_id, seq);
CREATE INDEX git_snapshots_by_repo ON git_snapshots(repo, created_at);
`,
};
