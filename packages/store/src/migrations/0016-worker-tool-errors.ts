import type { Migration } from "../migrate.ts";

/**
 * Mac test 2026-11-04b C2 (migration 16): a worker whose turn ended normally
 * can still have failed at what it was asked to do (the browser would not
 * start). The count of failed tool calls, and the error of the last call when
 * that call failed, travel with its result so the router's report says so.
 */
export const workerToolErrorsSchema: Migration = {
  version: 16,
  name: "workers.tool_errors + last_tool_error",
  sql: `
ALTER TABLE workers ADD COLUMN tool_errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN last_tool_error TEXT;
`,
};
