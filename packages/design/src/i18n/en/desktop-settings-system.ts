// English strings, desktop-settings-system. Same keys as ../zh/desktop-settings-system.ts (typecheck enforces it).
export const desktopSettingsSystem = {
  "desktop.settingsSystem.auditLog": "Audit log",
  "desktop.settingsSystem.automaticChecksAreOffEngineering":
    "Automatic checks are off (engineering.updates.check)",
  "desktop.settingsSystem.backUpNow": "Back up now",
  "desktop.settingsSystem.backedUp": "Backed up: {made}",
  "desktop.settingsSystem.backupFile": "Backup file {name}",
  "desktop.settingsSystem.chatMessages": "Chat messages",
  "desktop.settingsSystem.chatsAllowed": ", {allowChatIdsCount} chats allowed",
  "desktop.settingsSystem.checkForUpdates": "Check for updates",
  "desktop.settingsSystem.checked": "Checked",
  "desktop.settingsSystem.cleanupAndChecks": "Cleanup and checks",
  "desktop.settingsSystem.copyDiagnostics": "Copy diagnostics",
  "desktop.settingsSystem.daily": "Daily",
  "desktop.settingsSystem.dailyBackups": "Daily backups",
  "desktop.settingsSystem.databaseVersion": "{p0}, {bytes}, database version {version}",
  "desktop.settingsSystem.daysFromWhenTheJob": "{jobEventsDays} days (from when the job ends)",
  "desktop.settingsSystem.daysFromWhenTheRun": "{runEventsDays} days (from when the run ends)",
  "desktop.settingsSystem.daysTriggersCachedContentWatches":
    "{externalDays} days (triggers, cached content, watches, teammates, routine checks; each routine keeps at least its latest 20 checks)",
  "desktop.settingsSystem.deletedContentIsZeroedIn":
    "Deleted content is zeroed in the database; deleting a chat also removes it from backups by default (unticked, daily backups may keep it for up to 7 days). Chat content is encrypted in the database and backups; the audit log, the short titles of chats and workers, and ids are not. File-system snapshots are outside Alca's control, so turning on full-disk encryption is recommended.",
  "desktop.settingsSystem.downloadFailed": "Download failed",
  "desktop.settingsSystem.downloadStartedProgressAlsoShows":
    "Download started; progress also shows in the browser panel",
  "desktop.settingsSystem.downloadTheBrowserAutomaticallyWhen":
    "Download the browser automatically when needed",
  "desktop.settingsSystem.downloading": "Downloading",
  "desktop.settingsSystem.enabledButNotRunning": "Enabled but not running",
  "desktop.settingsSystem.encryption": "Encryption",
  "desktop.settingsSystem.externalContentAndSideRecords": "External content and side records",
  "desktop.settingsSystem.folder": "Folder",
  "desktop.settingsSystem.folderOpened": "Folder opened",
  "desktop.settingsSystem.foundChromiumOnThisComputer": " found Chromium on this computer",
  "desktop.settingsSystem.hourlyFirstRunWithinAn": "Hourly; first run within an hour of startup",
  "desktop.settingsSystem.hourlyLastNextAround": "Hourly; last {lastSweepAt}, next around {nextSweepAt}",
  "desktop.settingsSystem.keep": "Keep {dailyBackups}",
  "desktop.settingsSystem.keptForeverCantBeDeleted": "Kept forever; can't be deleted",
  "desktop.settingsSystem.keptUntilYouDeleteThe":
    "Kept until you delete the chat; deleting a chat also deletes its run steps, tool records and cached content",
  "desktop.settingsSystem.lastCheckFailed": "Last check failed: {error}",
  "desktop.settingsSystem.latestDailyBackup": "Latest daily backup",
  "desktop.settingsSystem.logFile": "Log file",
  "desktop.settingsSystem.logsFolderOpened": "Logs folder opened",
  "desktop.settingsSystem.manual": "Manual",
  "desktop.settingsSystem.newVersionAvailable": "New version {tag} available",
  "desktop.settingsSystem.noBackupsYetABackup":
    "No backups yet. A backup is made automatically before a database upgrade.",
  "desktop.settingsSystem.noBrowserYet": "No browser yet",
  "desktop.settingsSystem.noHourlyCleanupInDev": "No hourly cleanup in dev mode",
  "desktop.settingsSystem.noPublishedVersionsYet": "No published versions yet",
  "desktop.settingsSystem.notCheckedYet": "Not checked yet",
  "desktop.settingsSystem.notSetUpYet": "Not set up yet",
  "desktop.settingsSystem.notStarted": "Not started: {e}",
  "desktop.settingsSystem.openFolder": "Open folder",
  "desktop.settingsSystem.openTheLogsFolder": "Open the logs folder",
  "desktop.settingsSystem.preUpgradeAndManualBackups":
    "Pre-upgrade and manual backups keep the latest {keep}; daily backups keep another {keepDaily}, in {dir}. To restore: {restoreHint}.",
  "desktop.settingsSystem.readyToUse": "Ready to use",
  "desktop.settingsSystem.replying": "Replying",
  "desktop.settingsSystem.retryDownload": "Retry download",
  "desktop.settingsSystem.rolledBack": "{p0}Rolled back: {from} → {to}",
  "desktop.settingsSystem.runStepRecords": "Run step records",
  "desktop.settingsSystem.setUpTelegram": "Set up Telegram…",
  "desktop.settingsSystem.talkToAlcaThroughYour":
    "Talk to Alca through your own Telegram bot; Telegram can't approve cards.",
  "desktop.settingsSystem.theAuditLogWasRestored":
    "The audit log was restored with the backup, back to entry {lastId}.",
  "desktop.settingsSystem.theHourlyCheckFoundThe":
    'The hourly check found the audit log failed verification; press "Verify audit log" to see why.',
  "desktop.settingsSystem.theLastDailyBackupTook":
    "The last daily backup took {p0} seconds; from now on it runs only when no work is in progress.",
  "desktop.settingsSystem.thisLaunchTurnedOffAlcas": "This launch turned off Alca's browser (--browser off).",
  "desktop.settingsSystem.thisLaunchUsedNoBrowser":
    "This launch used --no-browser-download, so it won't download automatically; the setting applies from the next normal launch.",
  "desktop.settingsSystem.toolRecords": "Tool records",
  "desktop.settingsSystem.upToDateLatest": "Up to date (latest {tag})",
  "desktop.settingsSystem.updates": "Updates",
  "desktop.settingsSystem.verified": "Verified {at}",
  "desktop.settingsSystem.verifyAuditLog": "Verify audit log",
  "desktop.settingsSystem.verifying": "Verifying…",
  "desktop.settingsSystem.whenChromiumIsntFoundAlca":
    "When Chromium isn't found, Alca downloads Chrome for Testing (about 200 MB) into Alca's folder in the background at startup. Your everyday Google Chrome is never used. With this off, press \"Download the browser\".",
  "desktop.settingsSystem.whenStartedFromATerminal":
    "When started from a terminal, logs go to the terminal; only the background service writes logs/core.log",
};
