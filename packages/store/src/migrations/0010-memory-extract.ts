import type { Migration } from "../migrate.ts";

/**
 * P9: how a bot finds things to remember after a turn. `rules` (default) is
 * the rule extractor only; `model` also asks the bot's own engine, whose
 * proposals must quote the person's words and still pass the secret filter
 * and the tombstones.
 */
export const memoryExtractSchema: Migration = {
  version: 10,
  name: "bots: memory extraction mode (rules | model)",
  sql: `
ALTER TABLE bots ADD COLUMN memory_extract TEXT NOT NULL DEFAULT 'rules' CHECK (memory_extract IN ('rules','model'));
`,
};
