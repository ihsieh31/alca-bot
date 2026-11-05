import type { DatabaseSync } from "node:sqlite";
import { newStoreId } from "../ids.ts";

export type DeviceKind = "phone" | "hands";

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  platform: string;
  /** Long-term public key (base64url, SEC1 uncompressed P-256). */
  pubkey: string;
  keyFingerprint: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface DeviceRow {
  id: string;
  name: string;
  kind: DeviceKind;
  platform: string;
  pubkey: string;
  key_fingerprint: string;
  scopes: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

const device = (r: DeviceRow): Device => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  platform: r.platform,
  pubkey: r.pubkey,
  keyFingerprint: r.key_fingerprint,
  scopes: JSON.parse(r.scopes) as string[],
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  revokedAt: r.revoked_at,
});

/** Paired devices (Alca Link). Rows are revoked, never deleted. */
export class DeviceRepo {
  readonly db: DatabaseSync;
  #revision = 0;
  /** `PRAGMA data_version` when last read, and when (ms). */
  #external = 0;
  #externalAt = Number.NEGATIVE_INFINITY;
  readonly #now: () => number;
  constructor(db: DatabaseSync, o: { now?: () => number } = {}) {
    this.db = db;
    this.#now = o.now ?? Date.now;
  }

  /**
   * PERF-2026-11: bumped by every write that can change what a device may do
   * (add, rename, setScopes, revoke; not `seen`), so a reader that checks a
   * device per streamed event (Link's `still()`) keeps its last read until
   * this changes instead of a SQLite read per event per phone.
   *
   * Review 2026-11-05 #10: a write this repo did not make — another
   * connection to the file (the database worker, an import, a second Store,
   * the CLI) — changes SQLite's `PRAGMA data_version`, which is folded in
   * (read at most every EXTERNAL_CHECK_MS, so a revoke made elsewhere applies
   * within that).
   */
  get revision(): number {
    const now = this.#now();
    if (now - this.#externalAt >= DeviceRepo.EXTERNAL_CHECK_MS) {
      this.#externalAt = now;
      try {
        this.#external = Number(
          (this.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version,
        );
      } catch {
        // a closed connection: the in-repo count still holds
      }
    }
    return this.#revision + this.#external;
  }

  static readonly EXTERNAL_CHECK_MS = 1000;

  /** Something replaced device rows behind this repo's back (a restore or import in this process). */
  bump(): void {
    this.#revision += 1;
  }

  add(d: {
    name: string;
    kind: DeviceKind;
    platform: string;
    pubkey: string;
    keyFingerprint: string;
    scopes: string[];
  }): Device {
    const id = newStoreId("dev");
    this.#revision += 1;
    this.db
      .prepare(
        `INSERT INTO devices (id, name, kind, platform, pubkey, key_fingerprint, scopes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        d.name,
        d.kind,
        d.platform,
        d.pubkey,
        d.keyFingerprint,
        JSON.stringify(d.scopes),
        new Date().toISOString(),
      );
    return this.get(id) as Device;
  }

  get(id: string): Device | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
    return r ? device(r) : undefined;
  }

  byFingerprint(fp: string): Device | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE key_fingerprint = ?").get(fp) as
      | DeviceRow
      | undefined;
    return r ? device(r) : undefined;
  }

  list(o: { includeRevoked?: boolean } = {}): Device[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM devices ${o.includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at`,
      )
      .all() as unknown as DeviceRow[];
    return rows.map(device);
  }

  seen(id: string, at = new Date().toISOString()): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  rename(id: string, name: string): void {
    this.#revision += 1;
    this.db.prepare("UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL").run(name, id);
  }

  setScopes(id: string, scopes: string[]): void {
    this.#revision += 1;
    this.db
      .prepare("UPDATE devices SET scopes = ? WHERE id = ? AND revoked_at IS NULL")
      .run(JSON.stringify(scopes), id);
  }

  /** Permanent. Returns false when the device was unknown or already revoked. */
  revoke(id: string): boolean {
    this.#revision += 1;
    const r = this.db
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
    return Number(r.changes) > 0;
  }
}
