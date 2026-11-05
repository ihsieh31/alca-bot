import type { Migration } from "../migrate.ts";

/**
 * Next round §4 (migration 21): controlled append-only.
 *
 * The append-only event tables stay append-only for everything except two
 * paths, and the rule lives in the triggers so a code bug cannot delete
 * recent rows either:
 *
 * 1. The retention sweep. `retention_gate` has one fixed row per table whose
 *    `before` is NULL at all times except inside the sweep's own transaction.
 *    A row may be deleted only while its table's gate is open, the row is
 *    older than the gate, the gate itself is at least seven days in the past
 *    (the shortest retention the settings allow), and the row's owner is
 *    finished (a run, a job, a peer request). `routine_runs` also keeps the
 *    newest 20 runs of each routine.
 * 2. Deleting a conversation. Once `threads.deleted_at` is set (and it can no
 *    longer be cleared, see below), the thread's run events, job events and
 *    worker / trigger spills may go.
 *
 * `audit_log` is not touched: its triggers still refuse every UPDATE and
 * DELETE, and it has no gate row (the CHECK on `retention_gate.tbl` refuses
 * one). UPDATE triggers of the other tables are unchanged.
 */

const GATED = [
  "run_events",
  "job_events",
  "spills",
  "trigger_events",
  "watchdog_events",
  "peer_events",
  "routine_runs",
] as const;

/** The gate of `tbl` is open, at least seven days old, and newer than the row (left open for more terms). */
const gate = (tbl: string) => `
  EXISTS (SELECT 1 FROM retention_gate g
          WHERE g.tbl = '${tbl}' AND g.before IS NOT NULL
            AND g.before <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
            AND OLD.created_at < g.before`;

const threadGone = (threadExpr: string) =>
  `EXISTS (SELECT 1 FROM threads t WHERE t.id = ${threadExpr} AND t.deleted_at IS NOT NULL)`;

const guard = (tbl: string, allowed: string) => `
DROP TRIGGER ${tbl}_no_delete;
CREATE TRIGGER ${tbl}_no_delete BEFORE DELETE ON ${tbl}
WHEN NOT (${allowed})
BEGIN SELECT RAISE(ABORT, '${tbl} is append-only'); END;
`;

const RUN_EVENTS = `${gate("run_events")}
            AND EXISTS (SELECT 1 FROM runs r WHERE r.id = OLD.run_id
                        AND r.status = 'finished' AND r.finished_at < g.before))
  OR ${threadGone("(SELECT r.thread_id FROM runs r WHERE r.id = OLD.run_id)")}`;

const JOB_EVENTS = `${gate("job_events")}
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = OLD.job_id
                        AND j.status IN ('succeeded','failed','cancelled')
                        AND j.updated_at < g.before))
  OR ${threadGone("(SELECT j.thread_id FROM jobs j WHERE j.id = OLD.job_id)")}`;

const SPILLS = `${gate("spills")})
  OR (OLD.owner_kind = 'worker'
      AND ${threadGone("(SELECT w.thread_id FROM workers w WHERE w.id = OLD.owner_id)")})
  OR (OLD.owner_kind = 'trigger_event'
      AND ${threadGone(
        "(SELECT tr.thread_id FROM trigger_events e JOIN triggers tr ON tr.id = e.trigger_id WHERE e.id = OLD.owner_id)",
      )})`;

const PLAIN = (tbl: string) => `${gate(tbl)})`;

const PEER_EVENTS = `${gate("peer_events")}
            AND EXISTS (SELECT 1 FROM peer_requests p WHERE p.id = OLD.request_id AND p.status <> 'running'))`;

const ROUTINE_RUNS = `${gate("routine_runs")}
            AND (SELECT COUNT(*) FROM routine_runs x
                 WHERE x.routine_id = OLD.routine_id
                   AND (x.created_at > OLD.created_at OR (x.created_at = OLD.created_at AND x.id > OLD.id))) >= 20)`;

export const retentionSchema: Migration = {
  version: 21,
  name: "retention gate + controlled append-only deletes",
  sql: `
CREATE TABLE retention_gate (
  tbl    TEXT PRIMARY KEY CHECK (tbl IN (${GATED.map((t) => `'${t}'`).join(",")})),
  before TEXT
) STRICT;
INSERT INTO retention_gate (tbl, before) VALUES ${GATED.map((t) => `('${t}', NULL)`).join(", ")};
CREATE TRIGGER retention_gate_no_insert BEFORE INSERT ON retention_gate
BEGIN SELECT RAISE(ABORT, 'retention gates are fixed'); END;
CREATE TRIGGER retention_gate_no_delete BEFORE DELETE ON retention_gate
BEGIN SELECT RAISE(ABORT, 'retention gates are fixed'); END;
CREATE TRIGGER retention_gate_fixed BEFORE UPDATE OF tbl ON retention_gate
BEGIN SELECT RAISE(ABORT, 'retention gates are fixed'); END;

-- A deleted conversation stays deleted: the thread-delete path keys off this mark.
CREATE TRIGGER threads_deleted_final BEFORE UPDATE OF deleted_at ON threads
WHEN OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS NULL OR NEW.deleted_at <> OLD.deleted_at)
BEGIN SELECT RAISE(ABORT, 'a deleted conversation stays deleted'); END;
${guard("run_events", RUN_EVENTS)}
${guard("job_events", JOB_EVENTS)}
${guard("spills", SPILLS)}
${guard("trigger_events", PLAIN("trigger_events"))}
${guard("watchdog_events", PLAIN("watchdog_events"))}
${guard("peer_events", PEER_EVENTS)}
${guard("routine_runs", ROUTINE_RUNS)}
CREATE INDEX spills_by_created ON spills(created_at);
CREATE INDEX trigger_events_by_created ON trigger_events(created_at);
CREATE INDEX watchdog_events_by_created ON watchdog_events(created_at);
CREATE INDEX peer_events_by_created ON peer_events(created_at);
CREATE INDEX runs_finished ON runs(finished_at) WHERE status = 'finished';
CREATE INDEX jobs_by_thread ON jobs(thread_id);
`,
};

export const RETENTION_TABLES = GATED;
