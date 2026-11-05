import type { Migration } from "../migrate.ts";

/**
 * Next round R8: integration providers besides Composio.
 *
 * - `connector_accounts.provider` may now be `composio`, `google` (Gmail /
 *   Calendar through the person's own OAuth client) or `mcp` (one account per
 *   MCP server the person added). A STRICT table's CHECK cannot change, so
 *   the table is rebuilt; `connector_grants` and `connector_triggers` refer
 *   to it and are rebuilt around it (children copied out first, then put back
 *   with the same rows), with every index and trigger of migration 7.
 * - `integration_servers`: the person's MCP servers. Only names of secrets
 *   are kept here (`secret_names`: header / environment variable names); the
 *   values live in the SecretStore as `integration.mcp.<id>.<name>`.
 *
 * No tool-class override table: the person chose not to tighten integration
 * policy (MCP tools are classified by the same host rules as Composio's).
 */
export const integrationsSchema: Migration = {
  version: 23,
  name: "integration providers (google, mcp)",
  sql: `
CREATE TABLE connector_grants_v23 AS SELECT * FROM connector_grants;
CREATE TABLE connector_triggers_v23 AS SELECT * FROM connector_triggers;
DROP TABLE connector_grants;
DROP TABLE connector_triggers;

CREATE TABLE connector_accounts_v23 (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL CHECK (provider IN ('composio','google','mcp')),
  remote_id  TEXT NOT NULL,
  toolkit    TEXT NOT NULL CHECK (length(toolkit) BETWEEN 1 AND 64),
  label      TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  status     TEXT NOT NULL CHECK (status IN ('pending','active','failed','expired','removed')),
  identity   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, remote_id)
) STRICT;
INSERT INTO connector_accounts_v23 (id, provider, remote_id, toolkit, label, status, identity, created_at, updated_at)
  SELECT id, provider, remote_id, toolkit, label, status, identity, created_at, updated_at FROM connector_accounts;
DROP TABLE connector_accounts;
ALTER TABLE connector_accounts_v23 RENAME TO connector_accounts;
CREATE INDEX connector_accounts_by_toolkit ON connector_accounts(toolkit, status);
CREATE TRIGGER connector_accounts_fixed BEFORE UPDATE OF provider, remote_id, toolkit ON connector_accounts
WHEN NEW.provider <> OLD.provider OR NEW.remote_id <> OLD.remote_id OR NEW.toolkit <> OLD.toolkit
BEGIN SELECT RAISE(ABORT, 'an account never changes provider, remote id or app'); END;
CREATE TRIGGER connector_accounts_removed_final BEFORE UPDATE OF status ON connector_accounts
WHEN OLD.status = 'removed' AND NEW.status <> 'removed'
BEGIN SELECT RAISE(ABORT, 'a removed account stays removed; connect it again'); END;

CREATE TABLE connector_grants (
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  account_id TEXT NOT NULL REFERENCES connector_accounts(id),
  access     TEXT NOT NULL CHECK (access IN ('read','act')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, account_id)
) STRICT;
INSERT INTO connector_grants (bot_id, account_id, access, created_at)
  SELECT bot_id, account_id, access, created_at FROM connector_grants_v23;
DROP TABLE connector_grants_v23;

CREATE TABLE connector_triggers (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES connector_accounts(id),
  slug       TEXT NOT NULL,
  remote_id  TEXT,
  trigger_id TEXT NOT NULL REFERENCES triggers(id),
  config     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  status     TEXT NOT NULL CHECK (status IN ('active','failed','removed')),
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO connector_triggers (id, account_id, slug, remote_id, trigger_id, config, status, detail, created_at)
  SELECT id, account_id, slug, remote_id, trigger_id, config, status, detail, created_at FROM connector_triggers_v23;
DROP TABLE connector_triggers_v23;
CREATE INDEX connector_triggers_by_remote ON connector_triggers(remote_id);

CREATE TABLE integration_servers (
  id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40),
  label        TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  transport    TEXT NOT NULL CHECK (transport IN ('stdio','http')),
  command      TEXT CHECK (command IS NULL OR length(command) BETWEEN 1 AND 1000),
  args         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(args) AND json_type(args) = 'array' AND length(args) <= 8000),
  cwd          TEXT CHECK (cwd IS NULL OR length(cwd) BETWEEN 1 AND 1000),
  url          TEXT CHECK (url IS NULL OR length(url) BETWEEN 1 AND 2000),
  secret_names TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(secret_names) AND json_type(secret_names) = 'array' AND length(secret_names) <= 4000),
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (transport <> 'stdio' OR command IS NOT NULL),
  CHECK (transport <> 'http' OR url IS NOT NULL)
) STRICT;
`,
};
