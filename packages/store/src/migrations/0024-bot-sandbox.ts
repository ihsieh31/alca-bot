import type { Migration } from "../migrate.ts";

/**
 * Next round §5.4 (Phase C): a bot's OS sandbox setting, JSON text like
 * `bots.harness` (`{ mode: "auto"|"on"|"off", network: "open"|"none",
 * extraWritable?: string[] }`). NULL = the default (`auto`: on at 自主 and
 * 完全授權, network open). Loosening it needs the approve key (team-api.ts).
 */
export const botSandboxSchema: Migration = {
  version: 24,
  name: "bots.sandbox",
  sql: `
ALTER TABLE bots ADD COLUMN sandbox TEXT CHECK (sandbox IS NULL OR (json_valid(sandbox) AND length(sandbox) <= 2000));
`,
};
