import type { Migration } from "../migrate.ts";

/**
 * P13 (migration 14): a queued phone send reserves its client key *before*
 * the message is sent (state 'pending'), and the row becomes 'done' with the
 * result right after. A crash between the two leaves a pending reservation,
 * which the next flush resolves by looking for the message itself instead of
 * sending it again. Rows from migration 13 are all finished ('done').
 */
export const linkSendsPendingSchema: Migration = {
  version: 14,
  name: "link_client_ops.state: reserve a client key before sending",
  sql: `
ALTER TABLE link_client_ops ADD COLUMN state TEXT NOT NULL DEFAULT 'done' CHECK (state IN ('pending','done'));
`,
};
