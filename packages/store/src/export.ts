import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { appendAudit } from "./audit.ts";
import { atomic } from "./db.ts";
import { newStoreId } from "./ids.ts";
import { currentVersion } from "./migrate.ts";
import { openRow, sealRow } from "./seal.ts";

/**
 * Next round R5.6 (Phase F1, thread scope only): one conversation out to a
 * `.alca-export` file and back in.
 *
 * File: gzip of JSON lines. Line 1 is the manifest
 * `{ format: 1, schema, scope: "thread", id, createdAt, counts, sealed }`;
 * then one `{ t: <table>, r: <row> }` per row, parents before children. With
 * a passphrase the rows travel as one sealed line instead (scrypt → AES-256-
 * GCM, the manifest as associated data). Without one the file is 0600 and
 * the caller warns that it holds the whole conversation.
 *
 * Import only adds: every row gets a new id (a deleted conversation's shell
 * keeps its id and stays deleted — restoring makes a new conversation), and
 * every reference column is rewritten through one map. The reference columns
 * are listed in `REFS`; a test checks the list against
 * `PRAGMA foreign_key_list`. The whole import is one transaction.
 *
 * Not carried: engine sessions (a CLI session does not travel), the audit log
 * (hash-chained; the import writes its own `data.restored` row), undo
 * snapshots, early work, routines and triggers (bot scope, not done), secrets.
 */

export const EXPORT_FORMAT = 1;
/** Rows one import takes at most (beyond that, restore a whole backup instead). */
export const IMPORT_MAX_ROWS = 2_000_000;

export interface ExportOptions {
  /** Seal the rows with this passphrase (to move to another computer). */
  passphrase?: string;
  /** Also the memories learned in the conversation (active ones). */
  memories?: boolean;
}

export interface ExportManifest {
  format: number;
  schema: number;
  scope: "thread";
  id: string;
  createdAt: string;
  counts: Record<string, number>;
  sealed: false | "passphrase";
  kdf?: { salt: string; N: number; r: number; p: number };
  iv?: string;
}

export interface ExportSummary {
  file: string;
  counts: Record<string, number>;
  sealed: boolean;
  bytes: number;
}

export interface ImportOptions {
  passphrase?: string;
  /** Bot the conversation is filed under when its own bot is not here (default: the lead / first bot). */
  botId?: string;
  now?: string;
}

export interface ImportSummary {
  threadId: string;
  counts: Record<string, number>;
  /** Schema the file was made at (≤ this build's). */
  schema: number;
  /** Columns the file had that this build does not (dropped). */
  droppedColumns: string[];
}

export class ExportError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ExportError";
  }
}

type Row = Record<string, unknown>;

interface Part {
  t: string;
  /** Rows of this table that belong to thread ?1. */
  where: string;
  order: string;
  optional?: "memories";
}

const RUNS = "SELECT id FROM runs WHERE thread_id = ?1";
const WORKERS = "SELECT id FROM workers WHERE thread_id = ?1";
const JOBS = `SELECT id FROM jobs WHERE thread_id = ?1 OR run_id IN (${RUNS})`;
const DISPATCHES = "SELECT id FROM dispatches WHERE thread_id = ?1";

/** Parents before children. */
const PARTS: readonly Part[] = [
  { t: "threads", where: "id = ?1", order: "created_at" },
  { t: "runs", where: "thread_id = ?1", order: "started_at, id" },
  { t: "messages", where: "thread_id = ?1", order: "created_at, id" },
  { t: "jobs", where: `id IN (${JOBS})`, order: "created_at, id" },
  { t: "workers", where: "thread_id = ?1", order: "created_at, id" },
  { t: "run_events", where: `run_id IN (${RUNS})`, order: "run_id, seq" },
  { t: "job_events", where: `job_id IN (${JOBS})`, order: "id" },
  { t: "spills", where: `owner_kind = 'worker' AND owner_id IN (${WORKERS})`, order: "created_at, id" },
  { t: "worker_inbox", where: `worker_id IN (${WORKERS})`, order: "created_at, id" },
  { t: "approvals", where: `run_id IN (${RUNS}) OR worker_id IN (${WORKERS})`, order: "requested_at, id" },
  { t: "questions", where: `run_id IN (${RUNS})`, order: "asked_at, id" },
  { t: "drafts", where: "thread_id = ?1", order: "created_at, id" },
  { t: "dispatches", where: "thread_id = ?1", order: "created_at, id" },
  { t: "dispatch_events", where: `dispatch_id IN (${DISPATCHES})`, order: "seq" },
  { t: "harness_waits", where: `dispatch_id IN (${DISPATCHES})`, order: "created_at, id" },
  { t: "memories", where: "source_thread_id = ?1 AND status = 'active'", order: "n", optional: "memories" },
];

/** Where a column points. "null" = cleared on import (its target is not carried). */
type Target =
  | "threads"
  | "runs"
  | "messages"
  | "jobs"
  | "workers"
  | "spills"
  | "dispatches"
  | "memories"
  | "bots"
  | "null";

/**
 * Every column that holds another row's id, per carried table. Primary keys
 * (`id`) are renamed separately; AUTOINCREMENT keys are dropped. The test
 * `export.test.ts` checks every `PRAGMA foreign_key_list` entry is here.
 */
export const REFS: Readonly<Record<string, Readonly<Record<string, Target>>>> = {
  threads: { bot_id: "bots", peer_request_id: "null" },
  runs: { bot_id: "bots", thread_id: "threads", parent_run_id: "runs", worker_id: "workers" },
  messages: { thread_id: "threads", run_id: "runs" },
  jobs: { bot_id: "bots", parent_id: "jobs", thread_id: "threads", run_id: "runs" },
  workers: {
    bot_id: "bots",
    thread_id: "threads",
    job_id: "jobs",
    parent_run_id: "runs",
    run_id: "runs",
    spill_id: "spills",
  },
  run_events: { run_id: "runs" },
  job_events: { job_id: "jobs" },
  spills: { bot_id: "bots", owner_id: "workers" },
  worker_inbox: { worker_id: "workers", stream_id: "null" },
  approvals: { bot_id: "bots", run_id: "runs", worker_id: "workers" },
  questions: { run_id: "runs" },
  drafts: { bot_id: "bots", thread_id: "threads", worker_id: "workers", routine_id: "null" },
  dispatches: { bot_id: "bots", thread_id: "threads", active_worker_id: "workers", active_run_id: "runs" },
  dispatch_events: { dispatch_id: "dispatches", run_id: "runs" },
  harness_waits: { dispatch_id: "dispatches", bot_id: "bots", thread_id: "threads", worker_id: "workers" },
  memories: {
    bot_id: "bots",
    // Only active memories travel, as standalone items (their history stays behind).
    supersedes: "null",
    superseded_by: "null",
    source_thread_id: "threads",
    source_message_id: "messages",
    source_run_id: "runs",
    source_worker_id: "workers",
  },
};

/** Keys the database assigns (dropped on export, assigned again on import). */
const AUTO_KEY: Readonly<Record<string, string>> = {
  job_events: "id",
  dispatch_events: "seq",
  memories: "n",
};

const has = (db: DatabaseSync, t: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

const tableInfo = (db: DatabaseSync, t: string) =>
  db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number }>;

function encodeRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r))
    out[k] = v instanceof Uint8Array ? { $b: Buffer.from(v).toString("base64") } : v;
  return out;
}

function decodeValue(v: unknown): SQLInputValue {
  if (v && typeof v === "object" && "$b" in (v as Row)) return Buffer.from(String((v as Row).$b), "base64");
  if (v === undefined) return null;
  return v as SQLInputValue;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };

function deriveKey(passphrase: string, salt: Buffer, k: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize("NFC"), salt, 32, {
    N: k.N,
    r: k.r,
    p: k.p,
    maxmem: 256 * k.N * k.r,
  });
}

/** Write one conversation to `outPath` (a temporary file renamed into place; 0600). */
export function exportThread(
  db: DatabaseSync,
  threadId: string,
  outPath: string,
  o: ExportOptions = {},
): ExportSummary {
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  // One read transaction: every table from the same snapshot.
  db.exec("BEGIN");
  try {
    if (!db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId))
      throw new ExportError(`no conversation ${threadId}`);
    for (const p of PARTS) {
      if (p.optional === "memories" && !o.memories) continue;
      if (!has(db, p.t)) continue;
      const auto = AUTO_KEY[p.t];
      const rows = db.prepare(`SELECT * FROM ${p.t} WHERE ${p.where} ORDER BY ${p.order}`).iterate(threadId);
      for (const raw of rows) {
        // R7.6: the file holds plaintext (its own passphrase option seals it), so it does not need this key.
        const r = encodeRow(openRow(db, p.t, raw as Row));
        if (auto) delete r[auto];
        lines.push(JSON.stringify({ t: p.t, r }));
        counts[p.t] = (counts[p.t] ?? 0) + 1;
      }
    }
  } finally {
    db.exec("COMMIT");
  }
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    schema: currentVersion(db),
    scope: "thread",
    id: threadId,
    createdAt: new Date().toISOString(),
    counts,
    sealed: o.passphrase ? "passphrase" : false,
  };
  let body: string;
  if (o.passphrase) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    manifest.kdf = { salt: salt.toString("base64"), ...SCRYPT };
    manifest.iv = iv.toString("base64");
    const head = JSON.stringify(manifest);
    const c = createCipheriv("aes-256-gcm", deriveKey(o.passphrase, salt, SCRYPT), iv);
    c.setAAD(Buffer.from(head));
    const sealed = Buffer.concat([c.update(lines.join("\n"), "utf8"), c.final()]);
    const box = { sealed: sealed.toString("base64"), tag: c.getAuthTag().toString("base64") };
    body = `${head}\n${JSON.stringify(box)}\n`;
  } else {
    body = `${JSON.stringify(manifest)}\n${lines.map((l) => `${l}\n`).join("")}`;
  }
  const gz = gzipSync(Buffer.from(body, "utf8"));
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, gz, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, outPath);
  return { file: outPath, counts, sealed: !!o.passphrase, bytes: gz.length };
}

/** The manifest only (what a file holds, before importing it). */
export function readExportManifest(file: string): ExportManifest {
  return parse(file).manifest;
}

function parse(file: string): { manifest: ExportManifest; rest: string[] } {
  let text: string;
  try {
    text = gunzipSync(readFileSync(file)).toString("utf8");
  } catch {
    throw new ExportError("not an Alca export file");
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(lines[0] ?? "") as ExportManifest;
  } catch {
    throw new ExportError("not an Alca export file");
  }
  if (manifest.format !== EXPORT_FORMAT || manifest.scope !== "thread")
    throw new ExportError(`unsupported export (format ${manifest.format}, scope ${manifest.scope})`);
  return { manifest, rest: lines.slice(1) };
}

function rowsOf(
  file: string,
  passphrase?: string,
): { manifest: ExportManifest; rows: Array<{ t: string; r: Row }> } {
  const { manifest, rest } = parse(file);
  let lines = rest;
  if (manifest.sealed === "passphrase") {
    if (!passphrase) throw new ExportError("this export is sealed: a passphrase is needed");
    const box = JSON.parse(rest[0] ?? "{}") as { sealed?: string; tag?: string };
    const k = manifest.kdf;
    if (!k || !manifest.iv || !box.sealed || !box.tag) throw new ExportError("the sealed export is damaged");
    const d = createDecipheriv(
      "aes-256-gcm",
      deriveKey(passphrase, Buffer.from(k.salt, "base64"), k),
      Buffer.from(manifest.iv, "base64"),
    );
    d.setAAD(Buffer.from(JSON.stringify(manifest)));
    d.setAuthTag(Buffer.from(box.tag, "base64"));
    let plain: string;
    try {
      plain = Buffer.concat([d.update(Buffer.from(box.sealed, "base64")), d.final()]).toString("utf8");
    } catch {
      throw new ExportError("wrong passphrase, or the file was changed");
    }
    lines = plain.split("\n").filter((l) => l.length > 0);
  }
  if (lines.length > IMPORT_MAX_ROWS)
    throw new ExportError(`more than ${IMPORT_MAX_ROWS} rows: restore a whole backup instead`);
  return { manifest, rows: lines.map((l) => JSON.parse(l) as { t: string; r: Row }) };
}

const prefixOf = (id: string, t: string) => {
  const i = id.indexOf("_");
  return i > 0 && i <= 8 ? id.slice(0, i) : t.slice(0, 3);
};

/**
 * Add the conversation in `file` as a new one. All or nothing (one
 * transaction). Refuses a file made by a newer schema.
 */
export function importThread(db: DatabaseSync, file: string, o: ImportOptions = {}): ImportSummary {
  const { manifest, rows } = rowsOf(file, o.passphrase);
  const schema = currentVersion(db);
  if (manifest.schema > schema)
    throw new ExportError(
      `the export is from a newer Alca (schema ${manifest.schema}; this one is ${schema})`,
    );
  const now = o.now ?? new Date().toISOString();
  const lead = db
    .prepare("SELECT id FROM bots WHERE archived_at IS NULL ORDER BY is_lead DESC, created_at LIMIT 1")
    .get() as { id: string } | undefined;
  const fallbackBot = o.botId ?? lead?.id ?? "";
  const botIds = new Set((db.prepare("SELECT id FROM bots").all() as Array<{ id: string }>).map((b) => b.id));
  const ids: Record<string, Map<string, string>> = {};
  const idsOf = (t: string): Map<string, string> => {
    let m = ids[t];
    if (!m) {
      m = new Map();
      ids[t] = m;
    }
    return m;
  };
  // New ids first, so a reference to a row later in the file resolves too.
  for (const { t, r } of rows) {
    if (typeof r.id === "string" && t in REFS) idsOf(t).set(r.id, newStoreId(prefixOf(r.id, t)));
  }
  const info: Record<string, Map<string, boolean>> = {};
  const dropped = new Set<string>();
  const counts: Record<string, number> = {};
  let threadId = "";
  atomic(db, () => {
    // Parents and children may tie in time: foreign keys are checked at commit.
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const { t, r } of rows) {
      const refs = REFS[t];
      if (!refs) throw new ExportError(`unexpected table ${t} in the export`);
      if (!info[t]) info[t] = new Map(tableInfo(db, t).map((c) => [c.name, c.notnull === 0]));
      const known = info[t] as Map<string, boolean>;
      const out: Record<string, SQLInputValue> = {};
      for (const [k, v] of Object.entries(r)) {
        if (!known.has(k)) {
          dropped.add(`${t}.${k}`);
          continue;
        }
        if (k === AUTO_KEY[t]) continue;
        let val = decodeValue(v);
        if (k === "id" && typeof val === "string") val = idsOf(t).get(val) ?? val;
        const target = refs[k];
        if (target && val !== null) {
          if (target === "null") val = null;
          else if (target === "bots") val = botIds.has(String(val)) ? val : fallbackBot;
          else if (!(t === "spills" && k === "owner_id" && r.owner_kind !== "worker")) {
            const mapped = ids[target]?.get(String(val));
            // A row outside the conversation (another thread's run, say): cleared when it may be.
            val = mapped ?? (known.get(k) ? null : val);
          }
        }
        out[k] = val;
      }
      if (t === "threads") {
        // A restore is a new, live conversation (a deleted shell stays deleted).
        if (known.has("deleted_at")) out.deleted_at = null;
        if (known.has("archived_at")) out.archived_at = null;
        out.updated_at = now;
        threadId = String(out.id);
      }
      if (t === "memories" && known.has("embedding")) {
        out.embedding = null;
        out.embedding_model = null;
      }
      // R7.4: sealed under the row's new identity (the associated data names it).
      const row = sealRow(db, t, out);
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${t} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
        ...keys.map((k) => row[k] as SQLInputValue),
      );
      counts[t] = (counts[t] ?? 0) + 1;
    }
    if (!threadId) throw new ExportError("the export has no conversation row");
    appendAudit(db, {
      ts: now,
      initiator: { kind: "user", id: "local" },
      actor: { kind: "system", id: "store" },
      action: "data.restored",
      actionClass: "write",
      target: threadId,
      decision: "allow",
      detail: { scope: "thread", from: manifest.id, schema: manifest.schema, counts },
    });
  });
  return { threadId, counts, schema: manifest.schema, droppedColumns: [...dropped].sort() };
}
