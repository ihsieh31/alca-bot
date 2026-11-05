import type { Migration } from "../migrate.ts";

/**
 * Next round R7.5 (Phase F2, migration 25): column encryption.
 *
 * 1. `meta` — small key/value rows the store keeps about itself:
 *    `seal_check` (a value sealed with the data key; every start opens it, so
 *    a wrong key stops the start instead of writing rows under a second key)
 *    and `seal_progress` (where the background pass got to).
 * 2. `seal_gate` — the same pattern as migration 21's `retention_gate`: one
 *    fixed row per guarded table, `open = 0` at all times except inside the
 *    background pass's own transaction. While open, the table's "never
 *    rewritten" trigger lets one kind of UPDATE through: a content column
 *    going from plaintext to the sealed form, every other column unchanged.
 *    The trigger cannot check that the sealed value opens to the old text;
 *    that is why only the pass (one transaction, gate closed again before
 *    commit) opens it.
 * 3. `memories` and `drafts` are rebuilt only to widen the length CHECK of
 *    `body` to the sealed form's size (STRICT CHECKs cannot be altered). The
 *    plaintext limits (2000 / 20000 characters) stay in the repos. Every
 *    index and trigger is recreated as it was, plus the gate exception on
 *    `memories_content_final`.
 *
 * `audit_log` is not sealed and has no gate row.
 */

const GUARDED = ["run_events", "job_events", "spills", "trigger_events", "approvals", "memories"] as const;

const sealed = (x: string) => `((CASE WHEN json_valid(${x}) THEN json_extract(${x}, '$."$enc"') END) IS 1)`;
const open = (tbl: string) => `EXISTS (SELECT 1 FROM seal_gate WHERE tbl = '${tbl}' AND open = 1)`;
/** `col` goes from plaintext to sealed. */
const toSealed = (col: string) => `(NOT ${sealed(`OLD.${col}`)} AND ${sealed(`NEW.${col}`)})`;
const same = (cols: readonly string[]) => cols.map((c) => `NEW.${c} IS OLD.${c}`).join(" AND ");

const appendOnly = (tbl: string, col: string, others: readonly string[]) => `
DROP TRIGGER ${tbl}_no_update;
CREATE TRIGGER ${tbl}_no_update BEFORE UPDATE ON ${tbl}
WHEN NOT (${open(tbl)} AND ${toSealed(col)} AND ${same(others)})
BEGIN SELECT RAISE(ABORT, '${tbl} is append-only'); END;
`;

const APPROVAL_OTHERS = [
  "id",
  "run_id",
  "call_id",
  "action_class",
  "status",
  "requested_at",
  "expires_at",
  "resolved_at",
  "resolved_by_kind",
  "resolved_by_id",
  "detail",
  "bot_id",
  "worker_id",
] as const;

const MEMORY_COLS = `n, id, bot_id, scope, kind, subject, body, quote, origin, confidence, status, supersedes,
  superseded_by, source_kind, source_thread_id, source_message_id, source_run_id, source_worker_id,
  search_terms, embedding, embedding_model, uses, last_used_at, confirmed_at, created_at, updated_at,
  applies_to, due_at`;

const MEMORY_FIXED = [
  "bot_id",
  "kind",
  "subject",
  "supersedes",
  "source_kind",
  "source_thread_id",
  "source_message_id",
  "source_run_id",
  "source_worker_id",
  "created_at",
] as const;

const DRAFT_COLS =
  "id, bot_id, thread_id, worker_id, routine_id, account_id, kind, title, body, target, status, created_at, updated_at";

export const sealSchema: Migration = {
  version: 25,
  name: "column encryption: meta, seal gate, sealed-size body checks",
  sql: `
CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) STRICT;

CREATE TABLE seal_gate (
  tbl  TEXT PRIMARY KEY CHECK (tbl IN (${GUARDED.map((t) => `'${t}'`).join(",")})),
  open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0, 1))
) STRICT;
INSERT INTO seal_gate (tbl, open) VALUES ${GUARDED.map((t) => `('${t}', 0)`).join(", ")};
CREATE TRIGGER seal_gate_no_insert BEFORE INSERT ON seal_gate
BEGIN SELECT RAISE(ABORT, 'seal gates are fixed'); END;
CREATE TRIGGER seal_gate_no_delete BEFORE DELETE ON seal_gate
BEGIN SELECT RAISE(ABORT, 'seal gates are fixed'); END;
CREATE TRIGGER seal_gate_fixed BEFORE UPDATE OF tbl ON seal_gate
BEGIN SELECT RAISE(ABORT, 'seal gates are fixed'); END;
${appendOnly("run_events", "payload", ["run_id", "seq", "type", "created_at"])}
${appendOnly("job_events", "payload", ["id", "job_id", "seq", "type", "created_at"])}
${appendOnly("spills", "body", ["id", "bot_id", "owner_kind", "owner_id", "title", "chars", "created_at"])}
${appendOnly("trigger_events", "payload", [
  "id",
  "trigger_id",
  "stream_id",
  "rule_verdict",
  "judged",
  "judge_reason",
  "outcome",
  "created_at",
])}
DROP TRIGGER approvals_final;
CREATE TRIGGER approvals_final BEFORE UPDATE ON approvals
WHEN OLD.status <> 'pending'
  AND NOT (${open("approvals")} AND ${toSealed("summary")} AND ${same(APPROVAL_OTHERS)})
BEGIN SELECT RAISE(ABORT, 'approval already resolved'); END;

CREATE TABLE memories_v25 (
  n                 INTEGER PRIMARY KEY,
  id                TEXT NOT NULL UNIQUE,
  bot_id            TEXT NOT NULL REFERENCES bots(id),
  scope             TEXT NOT NULL CHECK (scope IN ('shared','bot')),
  kind              TEXT NOT NULL CHECK (kind IN ('fact','preference','person','project')),
  subject           TEXT NOT NULL DEFAULT '',
  body              TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 12000),
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
  applies_to        TEXT NOT NULL DEFAULT '[]',
  due_at            TEXT,
  CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  CHECK (origin = 'inferred' OR confirmed_at IS NOT NULL)
) STRICT;
INSERT INTO memories_v25 (${MEMORY_COLS}) SELECT ${MEMORY_COLS} FROM memories;
DROP TABLE memories;
ALTER TABLE memories_v25 RENAME TO memories;
CREATE INDEX memories_active ON memories(bot_id, scope, kind) WHERE status = 'active';
CREATE INDEX memories_subject ON memories(subject) WHERE status = 'active' AND subject <> '';
CREATE INDEX memories_chain ON memories(supersedes);
CREATE TRIGGER memories_content_final
BEFORE UPDATE OF bot_id, kind, subject, body, quote, supersedes, source_kind, source_thread_id,
  source_message_id, source_run_id, source_worker_id, created_at ON memories
WHEN NOT (${open("memories")} AND ${same(MEMORY_FIXED)}
  AND (NEW.body IS OLD.body OR ${toSealed("body")})
  AND (NEW.quote IS OLD.quote OR ${toSealed("quote")}))
BEGIN SELECT RAISE(ABORT, 'memories are superseded, not overwritten'); END;
CREATE TRIGGER memories_superseded_final BEFORE UPDATE OF status, superseded_by ON memories
WHEN OLD.status = 'superseded'
BEGIN SELECT RAISE(ABORT, 'a superseded memory stays superseded'); END;
CREATE TRIGGER memories_confirmed_final BEFORE UPDATE OF origin ON memories
WHEN OLD.origin = 'user' AND NEW.origin <> 'user'
BEGIN SELECT RAISE(ABORT, 'a confirmed memory cannot become inferred'); END;
CREATE TRIGGER memories_applies_final BEFORE UPDATE OF applies_to, due_at ON memories
BEGIN SELECT RAISE(ABORT, 'memories are superseded, not overwritten'); END;
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, search_terms) VALUES (NEW.n, NEW.search_terms);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, search_terms) VALUES ('delete', OLD.n, OLD.search_terms);
END;

CREATE TABLE drafts_v25 (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  worker_id  TEXT,
  routine_id TEXT,
  account_id TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('reply','message','note')),
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body       TEXT NOT NULL CHECK (length(body) <= 120000),
  target     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(target)),
  status     TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','used','discarded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO drafts_v25 (${DRAFT_COLS}) SELECT ${DRAFT_COLS} FROM drafts;
DROP TABLE drafts;
ALTER TABLE drafts_v25 RENAME TO drafts;
CREATE INDEX drafts_by_thread ON drafts(thread_id, status);
CREATE TRIGGER drafts_final BEFORE UPDATE OF status ON drafts
WHEN OLD.status <> 'ready' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'a used or discarded draft stays that way'); END;
`,
};

export const SEAL_GATED = GUARDED;
