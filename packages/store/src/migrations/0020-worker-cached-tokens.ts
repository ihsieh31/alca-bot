import type { Migration } from "../migrate.ts";

/**
 * Mac test B3 (migration 20): prompt-cache reads are booked apart from the
 * tokens that count against a worker's budget. `workers.tokens` keeps what
 * counts (new input + cache writes + output, plus a tenth of the cache
 * reads); `cached_tokens` is every cache read, shown beside it in the panel.
 */
export const workerCachedTokensSchema: Migration = {
  version: 20,
  name: "workers.cached_tokens",
  sql: `
ALTER TABLE workers ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
`,
};
