// English strings, desktop-settings-seal. Same keys as ../zh/desktop-settings-seal.ts (typecheck enforces it).
export const desktopSettingsSeal = {
  "desktop.settingsSeal.afterDeletingThemTheresNo":
    "After deleting them there's no way back to an older Alca (older versions can't read encrypted content and could only use the plaintext backups from before the upgrade). When you move computers, remember to bring the data key with alca secrets export; backups can't be opened without it.",
  "desktop.settingsSeal.allEncrypted": "All encrypted",
  "desktop.settingsSeal.chatContentEncryption": "Chat content encryption",
  "desktop.settingsSeal.dataKey": "Data key",
  "desktop.settingsSeal.databaseMovedAsideDuringRestore": "Database moved aside during restore",
  "desktop.settingsSeal.deleteOldBackupsAndMake": "Delete old backups and make an encrypted backup now",
  "desktop.settingsSeal.deletedOldBackupsTheNew":
    "Deleted {removedCount} old backups; the new encrypted backup is done",
  "desktop.settingsSeal.encryptingInTheBackgroundRows": "Encrypting in the background; {remaining} rows left",
  "desktop.settingsSeal.oldBackupsContainUnencryptedContent":
    "Old backups ({backupsCount}) contain unencrypted content:",
  "desktop.settingsSeal.rowsNotYetEncryptedContinues":
    "{remaining} rows not yet encrypted (continues hourly)",
  "desktop.settingsSeal.theseOldBackupsCanBe":
    "These old backups can be deleted only after all data is encrypted.",
  "desktop.settingsSeal.vaultKey": "{keyName} (vault, key {currentKeyId})",
  "desktop.settingsSeal.vaultKeyLocation": "Vault key location",
  "desktop.settingsSeal.whenTheVaultKeyIs":
    "When the vault key is in a file, the data key sits next to the database: encryption only stops someone who takes the database file alone.",
};
