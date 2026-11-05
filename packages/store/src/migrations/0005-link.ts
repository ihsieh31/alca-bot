import type { Migration } from "../migrate.ts";

/**
 * P4 Alca Link. `devices` (from migration 1) becomes the list of paired
 * devices: phones and hands daemons, each with the long-term public key that
 * was pinned at pairing. There never was a bearer token: a device proves
 * itself by signing every session handshake with that key, so the old
 * `token_hash` column holds the key's SHA-256 fingerprint instead.
 *
 * - `kind`: `phone` (PWA) or `hands` (stateless executor).
 * - The key and its fingerprint never change; revocation stays permanent.
 */
export const linkSchema: Migration = {
  version: 5,
  name: "link_devices",
  sql: `
ALTER TABLE devices RENAME COLUMN token_hash TO key_fingerprint;
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'phone' CHECK (kind IN ('phone','hands'));
ALTER TABLE devices ADD COLUMN platform TEXT NOT NULL DEFAULT '';
CREATE TRIGGER devices_key_final BEFORE UPDATE OF pubkey, key_fingerprint, kind ON devices
WHEN NEW.pubkey <> OLD.pubkey OR NEW.key_fingerprint <> OLD.key_fingerprint OR NEW.kind <> OLD.kind
BEGIN SELECT RAISE(ABORT, 'a device key never changes; pair again instead'); END;
CREATE TRIGGER devices_no_delete BEFORE DELETE ON devices
BEGIN SELECT RAISE(ABORT, 'devices are revoked, not deleted'); END;
`,
};
