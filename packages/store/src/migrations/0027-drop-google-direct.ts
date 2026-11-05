import type { Migration } from "../migrate.ts";

/**
 * Google direct removed (2026-11-05): the person chose to read Gmail /
 * Google Calendar through Composio only, so Alca no longer connects to Google
 * with its own OAuth client for mail or calendar (next round R8's `google`
 * provider is gone). Migration 23 is not edited: its CHECK still admits
 * `google`, and `integration_servers` stays (the person's MCP servers).
 *
 * An account left over from Google direct is disconnected the way
 * `ConnectorRepo.remove` does it — its grants deleted, its status `removed`
 * (the row stays: audit refers to it), its app triggers `removed` — and the
 * P3 triggers those app triggers fed are turned off (nothing polls them any
 * more). The refresh tokens are in the vault, not here: the desktop deletes
 * `integration.google.*` at start (dropGoogleDirectTokens).
 */
export const dropGoogleDirectSchema: Migration = {
  version: 27,
  name: "drop google direct accounts",
  sql: `
DELETE FROM connector_grants WHERE account_id IN (SELECT id FROM connector_accounts WHERE provider = 'google');
UPDATE triggers SET enabled = 0
  WHERE id IN (SELECT ct.trigger_id FROM connector_triggers ct JOIN connector_accounts a ON a.id = ct.account_id WHERE a.provider = 'google');
UPDATE connector_triggers SET status = 'removed'
  WHERE account_id IN (SELECT id FROM connector_accounts WHERE provider = 'google');
UPDATE connector_accounts SET status = 'removed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE provider = 'google' AND status <> 'removed';
`,
};
