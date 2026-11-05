import type { Migration } from "../migrate.ts";

/**
 * Mac device test 2026-11-05 BUG-4: `jobs.title` held the first 80
 * characters of each message (turn jobs) and `jobs.input` a worker's goal (up
 * to 4,000 characters), both in plaintext, though the message and
 * `workers.goal` are sealed. From this version a turn job's title is the
 * fixed word `turn`, a worker's job keeps no title or goal (the worker row
 * has them, sealed), and `jobs.title` / `input` / `result` are sealed columns
 * (`SEALED.jobs`).
 *
 * 1. The copies already stored are dropped: turn titles become `turn`; a
 *    worker job's title is cleared and `goal` removed from its input.
 * 2. `meta.seal_progress` forgets `done`, `clean` and any `jobs` position:
 *    the background pass walks `jobs` from the start and seals what is left,
 *    and every backup taken until it finishes again counts as plaintext
 *    (設定 → 資料 lists them; 刪除舊的明文備份 waits for the pass).
 *
 * `jobs` has no "never rewritten" trigger on these columns, so no seal gate.
 */
export const sealJobsSchema: Migration = {
  version: 28,
  name: "seal jobs title / input / result; drop copied message text",
  sql: `
UPDATE jobs SET title = 'turn' WHERE kind = 'turn' AND title IS NOT NULL AND title <> 'turn';
UPDATE jobs SET title = NULL, input = json_remove(input, '$.goal')
  WHERE kind = 'subagent' AND (title IS NOT NULL OR json_type(input, '$.goal') IS NOT NULL);
UPDATE meta SET v = json_remove(v, '$.done', '$.clean', '$.jobs')
  WHERE k = 'seal_progress' AND json_valid(v);
`,
};
