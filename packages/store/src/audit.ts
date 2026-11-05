import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "@alca/os";

export interface AuditEntry {
  ts?: string;
  initiator: { kind: "user" | "schedule" | "agent" | "webhook"; id: string };
  actor: { kind: string; id: string };
  action: string;
  actionClass: string;
  target?: string;
  decision: "allow" | "deny" | "ask";
  detail?: Record<string, unknown>;
}

function digest(
  prev: string | null,
  e: Required<Omit<AuditEntry, "target">> & { target: string | null },
): string {
  const canonical = JSON.stringify([
    prev,
    e.ts,
    e.initiator.kind,
    e.initiator.id,
    e.actor.kind,
    e.actor.id,
    e.action,
    e.actionClass,
    e.target,
    e.decision,
    JSON.stringify(e.detail),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Append one audit record, chained to the previous one by hash.
 * The table itself rejects UPDATE/DELETE via triggers; the chain makes
 * out-of-band edits to the file detectable.
 */
export function appendAudit(db: DatabaseSync, entry: AuditEntry): { id: number; hash: string } {
  const last = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as
    | { hash: string }
    | undefined;
  const prev = last?.hash ?? null;
  const full = {
    ts: entry.ts ?? new Date().toISOString(),
    initiator: entry.initiator,
    actor: entry.actor,
    action: entry.action,
    actionClass: entry.actionClass,
    target: entry.target ?? null,
    decision: entry.decision,
    detail: entry.detail ?? {},
  };
  const hash = digest(prev, full);
  const r = db
    .prepare(
      `INSERT INTO audit_log (ts, initiator_kind, initiator_id, actor_kind, actor_id, action, action_class, target, decision, detail, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      full.ts,
      full.initiator.kind,
      full.initiator.id,
      full.actor.kind,
      full.actor.id,
      full.action,
      full.actionClass,
      full.target,
      full.decision,
      JSON.stringify(full.detail),
      prev,
      hash,
    );
  return { id: Number(r.lastInsertRowid), hash };
}

interface AuditRow {
  id: number;
  ts: string;
  initiator_kind: AuditEntry["initiator"]["kind"];
  initiator_id: string;
  actor_kind: string;
  actor_id: string;
  action: string;
  action_class: string;
  target: string | null;
  decision: AuditEntry["decision"];
  detail: string;
  prev_hash: string | null;
  hash: string;
}

/**
 * Next round §3: where the hourly check last saw the end of the audit log,
 * kept outside the database (`<data>/audit.anchor`, 0600). It catches what
 * the chain alone cannot: the newest rows cut off, or an older backup put
 * back. Someone who can rewrite both the database and this file (the same
 * account) is not stopped by it.
 */
export interface AuditAnchor {
  lastId: number;
  lastHash: string;
  count: number;
  at: string;
  note?: "restored";
}

export type BrokenReason = "prev_hash" | "hash" | "detail_json" | "id_gap";

export interface VerifyResult {
  ok: boolean;
  /** Rows read in this pass. */
  count: number;
  /** First id this pass read (1 for a full pass; after `from.id` for an incremental one). */
  checkedFrom: number;
  /** The last row read, or `from` when there was nothing new. */
  last?: { id: number; hash: string; ts: string };
  brokenAt?: { id: number; ts: string; action: string; reason: BrokenReason };
  anchor?: { state: "match" | "behind" | "ahead" | "absent"; anchor?: AuditAnchor };
  /** PRAGMA quick_check, when asked for. */
  integrity?: string;
}

export interface VerifyOptions {
  /** Incremental: continue after a row already verified (its hash must still be the same). */
  from?: { id: number; hash: string };
  /** Compare against the outside anchor to catch a cut-off tail or a rollback. */
  anchor?: AuditAnchor;
  integrity?: boolean;
}

/** Rows between progress points of the stepwise verifier. */
export const VERIFY_STEP = 5_000;

function rowDigest(prev: string | null, r: AuditRow, detail: Record<string, unknown>): string {
  return digest(prev, {
    ts: r.ts,
    initiator: { kind: r.initiator_kind, id: r.initiator_id },
    actor: { kind: r.actor_kind, id: r.actor_id },
    action: r.action,
    actionClass: r.action_class,
    target: r.target,
    decision: r.decision,
    detail,
  });
}

/**
 * The one audit verifier (§3): the CLI, 設定's button and the hourly sweep
 * all drain this. It streams the rows (`iterate`, constant memory), never
 * throws on a bad row, and yields its progress every VERIFY_STEP rows so an
 * async caller can give the event loop a turn.
 */
export function* verifyAuditSteps(
  db: DatabaseSync,
  o: VerifyOptions = {},
): Generator<number, VerifyResult, void> {
  const fail = (r: AuditRow, reason: BrokenReason) => ({ id: r.id, ts: r.ts, action: r.action, reason });
  let prev: string | null = null;
  let lastId = 0;
  let last: VerifyResult["last"];
  let brokenAt: VerifyResult["brokenAt"];
  if (o.from) {
    const at = db.prepare("SELECT * FROM audit_log WHERE id = ?").get(o.from.id) as AuditRow | undefined;
    if (at && at.hash !== o.from.hash) brokenAt = fail(at, "hash");
    prev = o.from.hash;
    lastId = o.from.id;
    if (at) last = { id: at.id, hash: at.hash, ts: at.ts };
  }
  const checkedFrom = lastId + 1;
  let count = 0;
  if (!brokenAt) {
    const rows = db.prepare("SELECT * FROM audit_log WHERE id > ? ORDER BY id").iterate(lastId);
    for (const raw of rows) {
      const r = raw as unknown as AuditRow;
      count++;
      let detail: Record<string, unknown> | undefined;
      try {
        detail = JSON.parse(r.detail) as Record<string, unknown>;
      } catch {
        detail = undefined;
      }
      if (detail === undefined) brokenAt = fail(r, "detail_json");
      else if (r.prev_hash !== prev) brokenAt = fail(r, "prev_hash");
      else if (r.hash !== rowDigest(prev, r, detail)) brokenAt = fail(r, "hash");
      else if (r.id !== lastId + 1) brokenAt = fail(r, "id_gap");
      if (brokenAt) {
        rows.return?.();
        break;
      }
      prev = r.hash;
      lastId = r.id;
      last = { id: r.id, hash: r.hash, ts: r.ts };
      if (count % VERIFY_STEP === 0) yield count;
    }
  }
  const out: VerifyResult = { ok: !brokenAt, count, checkedFrom, ...(last ? { last } : {}) };
  if (brokenAt) out.brokenAt = brokenAt;
  if (o.anchor) {
    const a = o.anchor;
    const max = Number(
      (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM audit_log").get() as { m: number }).m,
    );
    const at = db.prepare("SELECT * FROM audit_log WHERE id = ?").get(a.lastId) as AuditRow | undefined;
    if (max < a.lastId) {
      out.anchor = { state: "behind", anchor: a };
      out.ok = false;
    } else {
      out.anchor = { state: max === a.lastId ? "match" : "ahead", anchor: a };
      if (at && a.lastHash && at.hash !== a.lastHash && !out.brokenAt) {
        out.brokenAt = fail(at, "hash");
        out.ok = false;
      }
    }
  } else out.anchor = { state: "absent" };
  if (o.integrity) {
    const q = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    out.integrity = q.map((r) => r.quick_check).join("; ") || "ok";
  }
  return out;
}

/** Drain the verifier in one go. */
export function verifyAudit(db: DatabaseSync, o: VerifyOptions = {}): VerifyResult {
  const it = verifyAuditSteps(db, o);
  for (;;) {
    const s = it.next();
    if (s.done) return s.value;
  }
}

/** Drain the verifier, giving the event loop a turn every VERIFY_STEP rows. */
export async function verifyAuditAsync(
  db: DatabaseSync,
  o: VerifyOptions = {},
  onProgress?: (rows: number) => void,
): Promise<VerifyResult> {
  const it = verifyAuditSteps(db, o);
  for (;;) {
    const s = it.next();
    if (s.done) return s.value;
    onProgress?.(s.value);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Kept for the existing tests and callers: a full pass without the anchor. */
export function verifyAuditChain(db: DatabaseSync): { ok: boolean; brokenAt?: number; count: number } {
  const r = verifyAudit(db);
  return r.brokenAt ? { ok: false, brokenAt: r.brokenAt.id, count: r.count } : { ok: true, count: r.count };
}

/** The last audit row and the row count (for the anchor). */
export function auditTail(
  db: DatabaseSync,
): { id: number; hash: string; ts: string; count: number } | undefined {
  const r = db.prepare("SELECT id, hash, ts FROM audit_log ORDER BY id DESC LIMIT 1").get() as
    | { id: number; hash: string; ts: string }
    | undefined;
  if (!r) return undefined;
  const n = Number((db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n);
  return { ...r, count: n };
}

export function anchorPath(dbPath: string): string {
  return join(dirname(resolve(dbPath)), "audit.anchor");
}

export function readAnchor(file: string): AuditAnchor | undefined {
  try {
    const a = JSON.parse(readFileSync(file, "utf8")) as Partial<AuditAnchor>;
    if (typeof a.lastId !== "number" || typeof a.lastHash !== "string" || typeof a.at !== "string")
      return undefined;
    return {
      lastId: a.lastId,
      lastHash: a.lastHash,
      count: typeof a.count === "number" ? a.count : 0,
      at: a.at,
      ...(a.note === "restored" ? { note: "restored" as const } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Write the anchor (0600) with the shared atomic writer (§1, `@alca/os`). */
export function writeAnchor(file: string, a: AuditAnchor): void {
  writeFileAtomic(file, `${JSON.stringify(a)}\n`, { mode: 0o600 });
}
