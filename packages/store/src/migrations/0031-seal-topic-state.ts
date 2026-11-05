import type { Migration } from "../migrate.ts";

/**
 * Review 2026-11-05 #2 / #3 (migration 31): two places still kept the words
 * migration 30 sealed.
 *
 * - `offers.topic` was the first 30 characters of the offer's action — a
 *   literal prefix of a sealed column (「回 王小明 的報價信」). It is a sealed
 *   column now (`SEALED.offers`); 別再提這類 matches on the opened value.
 * - `bot_addons.state_json` holds 主動留意's queue of paid-for candidates (up
 *   to 30) and its homework candidate, each with the fact and the action the
 *   model wrote from mail and calendar evidence. The whole state is a sealed
 *   column now (`SEALED.bot_addons`, row identity `bot_id:addon_id`).
 *
 * Neither column has a "never rewritten" trigger, so no seal gate row. As in
 * migrations 28 and 30, `meta.seal_progress` forgets `done`, `clean` and the
 * `offers` / `bot_addons` positions: the background pass walks both tables
 * again, and every backup taken until it finishes counts as plaintext.
 */
export const sealTopicStateSchema: Migration = {
  version: 31,
  name: "seal offers.topic and bot_addons.state_json",
  sql: `
UPDATE meta SET v = json_remove(v, '$.done', '$.clean', '$.offers', '$.bot_addons')
  WHERE k = 'seal_progress' AND json_valid(v);
`,
};
