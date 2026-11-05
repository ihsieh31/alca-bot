import type { Migration } from "../migrate.ts";

/**
 * Next round R9.6 (G2): the language of a bot's router and worker rules.
 * `auto` (the default) = judged from the bot's instructions as before
 * (`botLanguage`); `zh` / `en` pin it. Replies still follow the language of
 * the user's message.
 */
export const botLanguageSchema: Migration = {
  version: 26,
  name: "bots.language",
  sql: `
ALTER TABLE bots ADD COLUMN language TEXT NOT NULL DEFAULT 'auto' CHECK (language IN ('auto', 'zh', 'en'));
`,
};
