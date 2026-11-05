import type { DatabaseSync } from "node:sqlite";
import { newStoreId } from "../ids.ts";

export interface PushSubscriptionRecord {
  id: string;
  deviceId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: number | null;
  failures: number;
}

interface Row {
  id: string;
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  created_at: string;
  last_sent_at: string | null;
  last_status: number | null;
  failures: number;
}

const rec = (r: Row): PushSubscriptionRecord => ({
  id: r.id,
  deviceId: r.device_id,
  endpoint: r.endpoint,
  keys: { p256dh: r.p256dh, auth: r.auth },
  userAgent: r.user_agent,
  createdAt: r.created_at,
  lastSentAt: r.last_sent_at,
  lastStatus: r.last_status,
  failures: r.failures,
});

export type PushOutcome = "sent" | "gone" | "retry" | "rejected" | "skipped";

export interface PushEventRecord {
  seq: number;
  at: string;
  deviceId: string;
  kind: string;
  ref: string;
  outcome: PushOutcome;
  status: number | null;
}

/** Web Push subscriptions per paired device (P8) and the content-free delivery log. */
export class PushRepo {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Save a device's subscription. The same endpoint from the same device
   * refreshes its keys; an endpoint another device already holds is refused.
   */
  upsert(deviceId: string, s: { endpoint: string; p256dh: string; auth: string; userAgent?: string }) {
    const existing = this.byEndpoint(s.endpoint);
    if (existing && existing.deviceId !== deviceId) throw new Error("endpoint belongs to another device");
    if (existing) {
      this.db
        .prepare("UPDATE push_subscriptions SET p256dh = ?, auth = ?, failures = 0 WHERE id = ?")
        .run(s.p256dh, s.auth, existing.id);
      return this.get(existing.id) as PushSubscriptionRecord;
    }
    const id = newStoreId("psb");
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, device_id, endpoint, p256dh, auth, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        deviceId,
        s.endpoint,
        s.p256dh,
        s.auth,
        (s.userAgent ?? "").slice(0, 200),
        new Date().toISOString(),
      );
    return this.get(id) as PushSubscriptionRecord;
  }

  get(id: string): PushSubscriptionRecord | undefined {
    const r = this.db.prepare("SELECT * FROM push_subscriptions WHERE id = ?").get(id) as Row | undefined;
    return r ? rec(r) : undefined;
  }

  byEndpoint(endpoint: string): PushSubscriptionRecord | undefined {
    const r = this.db.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").get(endpoint) as
      | Row
      | undefined;
    return r ? rec(r) : undefined;
  }

  forDevice(deviceId: string): PushSubscriptionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM push_subscriptions WHERE device_id = ? ORDER BY created_at")
        .all(deviceId) as unknown as Row[]
    ).map(rec);
  }

  /** Subscriptions of devices that are not revoked. */
  live(): PushSubscriptionRecord[] {
    return (
      this.db
        .prepare(
          `SELECT s.* FROM push_subscriptions s JOIN devices d ON d.id = s.device_id
           WHERE d.revoked_at IS NULL ORDER BY s.created_at`,
        )
        .all() as unknown as Row[]
    ).map(rec);
  }

  remove(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id).changes) > 0;
  }

  removeForDevice(deviceId: string, endpoint?: string): number {
    const r = endpoint
      ? this.db
          .prepare("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?")
          .run(deviceId, endpoint)
      : this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(deviceId);
    return Number(r.changes);
  }

  /** Record one delivery attempt on the subscription and in the log. */
  record(
    sub: Pick<PushSubscriptionRecord, "id" | "deviceId">,
    e: { kind: string; ref: string; outcome: PushOutcome; status?: number | null },
  ): void {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO push_events (at, device_id, kind, ref, outcome, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(at, sub.deviceId, e.kind, e.ref, e.outcome, e.status ?? null);
    if (e.outcome === "sent")
      this.db
        .prepare("UPDATE push_subscriptions SET last_sent_at = ?, last_status = ?, failures = 0 WHERE id = ?")
        .run(at, e.status ?? null, sub.id);
    else if (e.outcome === "retry" || e.outcome === "rejected")
      this.db
        .prepare("UPDATE push_subscriptions SET last_status = ?, failures = failures + 1 WHERE id = ?")
        .run(e.status ?? null, sub.id);
  }

  events(limit = 50): PushEventRecord[] {
    return (
      this.db.prepare("SELECT * FROM push_events ORDER BY seq DESC LIMIT ?").all(limit) as unknown as Array<{
        seq: number;
        at: string;
        device_id: string;
        kind: string;
        ref: string;
        outcome: PushOutcome;
        status: number | null;
      }>
    ).map((r) => ({
      seq: r.seq,
      at: r.at,
      deviceId: r.device_id,
      kind: r.kind,
      ref: r.ref,
      outcome: r.outcome,
      status: r.status,
    }));
  }
}
