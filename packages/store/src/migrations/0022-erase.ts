import type { Migration } from "../migrate.ts";

/**
 * Next round R5.2 / R5.4 (Phase F1): deleting a conversation also removes its
 * approval cards and question cards (their summary / prompt / answer are the
 * conversation's words).
 *
 * Same rule as migration 21, no second mechanism: these two tables stay
 * undeletable except through the thread-delete branch of the retention gate —
 * a row may go only once the thread it belongs to (through its run, or its
 * worker) has `deleted_at` set, which migration 21 already makes final. A row
 * with no run and no worker belongs to no conversation and stays. UPDATE
 * triggers (`approvals_final`, `questions_final`) are unchanged: rows are
 * deleted, never rewritten.
 */

const threadGone = (threadExpr: string) =>
  `EXISTS (SELECT 1 FROM threads t WHERE t.id = ${threadExpr} AND t.deleted_at IS NOT NULL)`;

const OF_RUN = threadGone("(SELECT r.thread_id FROM runs r WHERE r.id = OLD.run_id)");
const OF_WORKER = threadGone("(SELECT w.thread_id FROM workers w WHERE w.id = OLD.worker_id)");

export const eraseSchema: Migration = {
  version: 22,
  name: "approvals and questions follow a deleted conversation",
  sql: `
DROP TRIGGER approvals_no_delete;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
WHEN NOT (${OF_RUN} OR ${OF_WORKER})
BEGIN SELECT RAISE(ABORT, 'approvals are kept for audit'); END;
DROP TRIGGER questions_no_delete;
CREATE TRIGGER questions_no_delete BEFORE DELETE ON questions
WHEN NOT (${OF_RUN})
BEGIN SELECT RAISE(ABORT, 'questions are kept for audit'); END;
CREATE INDEX IF NOT EXISTS approvals_by_run ON approvals(run_id);
CREATE INDEX IF NOT EXISTS questions_by_run ON questions(run_id);
`,
};
