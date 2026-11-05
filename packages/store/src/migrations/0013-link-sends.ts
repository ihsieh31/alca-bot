import type { Migration } from "../migrate.ts";

/**
 * P13 queued sends from a phone (migration 13). A phone that was offline flushes its outbox
 * on reconnect; each item carries a client key (random, made on the phone)
 * so a retry after a lost answer — or after the core restarted — returns the
 * first result instead of sending the message twice. One row per (device,
 * key); a key is never reused for another operation. Rows older than a week
 * are pruned (the phone gives up on an item long before that).
 */
export const linkSendsSchema: Migration = {
  version: 13,
  name: "link_client_ops: idempotency keys for a phone's queued sends",
  sql: `
CREATE TABLE link_client_ops (
  device_id  TEXT NOT NULL REFERENCES devices(id),
  client_key TEXT NOT NULL CHECK (length(client_key) BETWEEN 8 AND 64),
  op         TEXT NOT NULL CHECK (op IN ('threads.create','threads.send')),
  result     TEXT NOT NULL CHECK (json_valid(result)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, client_key)
) STRICT;
CREATE INDEX link_client_ops_age ON link_client_ops(created_at);
`,
};
