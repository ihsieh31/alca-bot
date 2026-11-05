// The vault moved to @alca/os (one implementation, one SecretStore interface);
// re-exported here so existing imports keep working.
export {
  type CommandRunner,
  defaultKeySource,
  FileKeySource,
  type KeySource,
  keychainAccount,
  LazyKeySource,
  MacKeychainKeySource,
  SecretServiceKeySource,
  Vault,
  type VaultBackend,
  VaultError,
  vaultBackendFromEnv,
} from "@alca/os";

/** A short preview for the UI: never more than the last four characters. */
export function preview(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 8 ? "••••" : `••••${value.slice(-4)}`;
}
