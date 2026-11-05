import type { DatabaseSync } from "node:sqlite";
import { openValue } from "../seal.ts";

export type ClientOp = "threads.create" | "threads.send";

export type ClientOpRow =
  | { state: "done"; op: ClientOp; result: unknown; createdAt: string }
  | { state: "pending"; op: ClientOp; createdAt: string };

/**
 * P13: what a phone's queued operation returned the first time, by the
 * phone's own key, so a retried flush never sends a message twice. A key is
 * reserved (pending) before the operation runs and finished (done) after.
 */
export class ClientOpRepo {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(deviceId: string, key: string): ClientOpRow | undefined {
    const r = this.db
      .prepare(
        "SELECT op, result, state, created_at FROM link_client_ops WHERE device_id = ? AND client_key = ?",
      )
      .get(deviceId, key) as
      | { op: ClientOp; result: string; state: "pending" | "done"; created_at: string }
      | undefined;
    if (!r) return undefined;
    return r.state === "pending"
      ? { state: "pending", op: r.op, createdAt: r.created_at }
      : { state: "done", op: r.op, result: JSON.parse(r.result) as unknown, createdAt: r.created_at };
  }

  /** Reserve a key before the operation runs. Throws if the key is already there. */
  reserve(deviceId: string, key: string, op: ClientOp, now = new Date()): void {
    this.db
      .prepare(
        "INSERT INTO link_client_ops (device_id, client_key, op, result, state, created_at) VALUES (?, ?, ?, '{}', 'pending', ?)",
      )
      .run(deviceId, key, op, now.toISOString());
  }

  /** The operation ran: store what it returned. */
  finish(deviceId: string, key: string, result: unknown): void {
    this.db
      .prepare("UPDATE link_client_ops SET result = ?, state = 'done' WHERE device_id = ? AND client_key = ?")
      .run(JSON.stringify(result ?? null), deviceId, key);
  }

  /** The operation did not happen (it threw before writing anything): free the key. */
  release(deviceId: string, key: string): void {
    this.db
      .prepare("DELETE FROM link_client_ops WHERE device_id = ? AND client_key = ? AND state = 'pending'")
      .run(deviceId, key);
  }

  /** Reserve, store and finish in one go (an operation already known to have run). */
  put(deviceId: string, key: string, op: ClientOp, result: unknown, now = new Date()): void {
    this.db
      .prepare(
        "INSERT INTO link_client_ops (device_id, client_key, op, result, state, created_at) VALUES (?, ?, ?, ?, 'done', ?)",
      )
      .run(deviceId, key, op, JSON.stringify(result ?? null), now.toISOString());
  }

  /**
   * For a pending send left by a crash: the run of the person's message with
   * exactly this text that this device started on the thread within
   * [from, to], and that no other key of the device already answered with —
   * the send happened and only its result was never stored.
   */
  sentBetween(
    deviceId: string,
    threadId: string,
    initiatorId: string,
    text: string,
    from: string,
    to: string,
  ): string | undefined {
    const r = this.db
      .prepare(
        `SELECT m.id, m.content, m.run_id AS runId FROM messages m JOIN runs r ON r.id = m.run_id
          WHERE m.thread_id = ? AND m.role = 'user'
            AND r.initiator_kind = 'user' AND r.initiator_id = ?
            AND m.created_at >= ? AND m.created_at <= ?
            AND m.run_id NOT IN (
              SELECT json_extract(result, '$.runId') FROM link_client_ops
               WHERE device_id = ? AND state = 'done' AND json_extract(result, '$.runId') IS NOT NULL)
          ORDER BY m.created_at, m.rowid`,
      )
      .all(threadId, initiatorId, from, to, deviceId) as Array<{
      id: string;
      content: string;
      runId: string;
    }>;
    // R7.4: the content is sealed (a fresh nonce each time), so the text is compared after opening.
    return r.find((m) => openValue(this.db, "messages", "content", m.id, m.content) === text)?.runId;
  }

  /** Forget keys older than `days` (default 7). */
  prune(days = 7): number {
    const before = new Date(Date.now() - days * 86_400_000).toISOString();
    return Number(this.db.prepare("DELETE FROM link_client_ops WHERE created_at < ?").run(before).changes);
  }
}
