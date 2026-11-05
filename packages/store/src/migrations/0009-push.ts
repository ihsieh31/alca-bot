import type { Migration } from "../migrate.ts";

/**
 * P8 Web Push. One row per push subscription a paired phone handed the core
 * over Link (endpoint + the browser's ECDH key and auth secret, RFC 8291).
 * A subscription belongs to exactly one device and never moves; a revoked
 * device's subscriptions are removed with it (trigger) and cannot be added
 * again. `push_events` is the append-only delivery log: what kind was sent,
 * the opaque id, the outcome — never any content.
 */
export const pushSchema: Migration = {
  version: 9,
  name: "push: subscriptions per paired device, delivery log",
  sql: `
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  endpoint TEXT NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%' OR endpoint LIKE 'http://127.0.0.1:%'),
  p256dh TEXT NOT NULL CHECK (length(p256dh) BETWEEN 80 AND 100),
  auth TEXT NOT NULL CHECK (length(auth) BETWEEN 20 AND 30),
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_sent_at TEXT,
  last_status INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_device ON push_subscriptions(device_id);
CREATE TRIGGER push_subscriptions_owner_final BEFORE UPDATE OF device_id, endpoint ON push_subscriptions
BEGIN SELECT RAISE(ABORT, 'a push subscription never changes owner or endpoint'); END;
CREATE TRIGGER push_subscriptions_live_device BEFORE INSERT ON push_subscriptions
WHEN (SELECT revoked_at FROM devices WHERE id = NEW.device_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a revoked device cannot subscribe'); END;
CREATE TRIGGER devices_revoke_drops_push AFTER UPDATE OF revoked_at ON devices
WHEN NEW.revoked_at IS NOT NULL
BEGIN DELETE FROM push_subscriptions WHERE device_id = NEW.id; END;

CREATE TABLE push_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approval','question','handoff','test')),
  ref TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent','gone','retry','rejected','skipped')),
  status INTEGER
);
CREATE TRIGGER push_events_no_update BEFORE UPDATE ON push_events
BEGIN SELECT RAISE(ABORT, 'push_events is append-only'); END;
CREATE TRIGGER push_events_no_delete BEFORE DELETE ON push_events
BEGIN SELECT RAISE(ABORT, 'push_events is append-only'); END;
`,
};
