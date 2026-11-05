import type { Migration } from "../migrate.ts";

/**
 * P11 更多供應商: custom providers may now be an ACP agent (binary + args +
 * env names) or an Anthropic-compatible API besides OpenAI-compatible and
 * Gemini; `config` holds the kind's own fields (command, key env name, model
 * list). `provider_settings` keeps the person's choices for the built-in
 * providers (a base URL or command override, the OpenAI wire, a default
 * model) and whether the vault holds a key for it — never the key itself.
 */
export const providersSchema: Migration = {
  version: 11,
  name: "providers: custom ACP / Anthropic providers, settings for built-in providers",
  sql: `
CREATE TABLE engine_providers_v11 (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('openai','gemini','anthropic','acp')),
  label       TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  base_url    TEXT NOT NULL CHECK (length(base_url) <= 500),
  model       TEXT NOT NULL CHECK (length(model) <= 200),
  has_key     INTEGER NOT NULL DEFAULT 0 CHECK (has_key IN (0,1)),
  config      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  created_at  TEXT NOT NULL,
  removed_at  TEXT
) STRICT;
INSERT INTO engine_providers_v11 (id, kind, label, base_url, model, has_key, created_at, removed_at)
  SELECT id, kind, label, base_url, model, has_key, created_at, removed_at FROM engine_providers;
DROP TABLE engine_providers;
ALTER TABLE engine_providers_v11 RENAME TO engine_providers;

CREATE TABLE provider_settings (
  id          TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 60),
  settings    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
  has_key     INTEGER NOT NULL DEFAULT 0 CHECK (has_key IN (0,1)),
  updated_at  TEXT NOT NULL
) STRICT;
`,
};
