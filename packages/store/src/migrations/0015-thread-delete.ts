import type { Migration } from "../migrate.ts";

/**
 * P13 A6 (migration 15): a conversation can be deleted. The row stays (runs,
 * approvals and the audit log point at it and are kept by design) but it is
 * marked `deleted_at`, its title is cleared and its messages, drafts and
 * engine sessions are removed; it never lists or opens again. The index
 * serves the paged list (newest activity first, cursor updated_at + id).
 */
export const threadDeleteSchema: Migration = {
  version: 15,
  name: "threads.deleted_at + paged list index",
  sql: `
ALTER TABLE threads ADD COLUMN deleted_at TEXT;
CREATE INDEX threads_by_activity ON threads(updated_at DESC, id DESC);
`,
};
