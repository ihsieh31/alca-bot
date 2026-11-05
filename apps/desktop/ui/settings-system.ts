// 設定 → 瀏覽器, Telegram, 資料 (was 備份; next round §3 / §4), 關於 (P13 B3). Each block reads its own API
// and every button does what it says: 下載瀏覽器 starts the download,
// 現在備份 takes a backup, 打開記錄檔資料夾 opens the folder. Restoring a
// backup is CLI only (the core must be stopped).
import type { Api } from "./api.ts";
import { perfBlock, transferBlock } from "./data-transfer.ts";
import { h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { button, bytes, errText, kv, live, note, section, tag, when } from "./settings-parts.ts";
import { sealBlock } from "./settings-seal.ts";

interface BrowserStatus {
  enabled: boolean;
  chromium?: boolean;
  install?: {
    phase: string;
    version?: string;
    received?: number;
    total?: number;
    error?: string;
    auto: boolean;
  };
}
interface TelegramView {
  enabled: boolean;
  tokenSet: boolean;
  botUsername: string | null;
  running: boolean;
  lastError: string | null;
  allowChatIds: number[];
}
interface BackupsView {
  dir: string;
  keep: number;
  keepDaily: number;
  backups: Array<{ name: string; version: number; kind: "manual" | "daily"; bytes: number; takenAt: string }>;
  restoreHint: string;
  made?: string;
}
interface DataView {
  retention: { runEventsDays: number; jobEventsDays: number; externalDays: number; dailyBackups: number };
  hourly: boolean;
  lastSweepAt?: string;
  nextSweepAt?: string;
  lastPruned?: Record<string, number>;
  lastDailyBackup?: { name: string; takenAt: string };
  slowBackupMs?: number;
  audit?: { ok: boolean; at: string; reason?: string; id?: number };
  anchor?: { lastId: number; at: string; restored: boolean };
}
interface VerifyView {
  ok: boolean;
  lines: string[];
  diagnostic: string;
  rows: number;
  at: string;
}
interface UpdateView {
  check: "notify" | "off";
  channel: "stable" | "prerelease";
  kind: "installed" | "bundled" | "checkout" | "unknown";
  current: string;
  lastCheck?: { at: string; latest?: { tag: string; url: string }; newer: boolean; error?: string };
  action?: string;
  rolledBack?: { from: string; to: string; at: string; auto: boolean };
}
interface AboutView {
  update?: UpdateView;
  version: string;
  dataDir: string;
  logsDir: string;
  logFile: string;
  logFileExists: boolean;
  node: string;
  platform: string;
}

const BUSY = ["checking", "downloading", "verifying", "extracting"];

export function browserSection(
  api: Api,
  auto: { on: boolean; locked: boolean; save: (on: boolean) => void },
): HTMLElement {
  const body = live(
    "st-browser",
    () => api.call<BrowserStatus>("GET", "/api/browser/status"),
    (st, reload) => {
      if (!st.enabled) return [note(tx("desktop.settingsSystem.thisLaunchTurnedOffAlcas"))];
      const i = st.install;
      const mb = (n?: number) => (n === undefined ? "?" : (n / 1024 / 1024).toFixed(0));
      const state =
        i && BUSY.includes(i.phase)
          ? [
              tag(tx("desktop.settingsSystem.downloading")),
              i.phase === "downloading" ? ` ${mb(i.received)} / ${mb(i.total)} MB` : "",
            ]
          : i?.phase === "failed"
            ? [tag(tx("desktop.settingsSystem.downloadFailed"), "warn"), ` ${i.error ?? ""}`]
            : st.chromium
              ? [
                  tag(tx("desktop.settingsSystem.readyToUse"), "ok"),
                  i?.version
                    ? ` Chrome for Testing ${i.version}`
                    : tx("desktop.settingsSystem.foundChromiumOnThisComputer"),
                ]
              : [tag(tx("desktop.settingsSystem.noBrowserYet"), "warn")];
      const download =
        !st.chromium && !(i && BUSY.includes(i.phase))
          ? button(
              i?.phase === "failed"
                ? tx("desktop.settingsSystem.retryDownload")
                : tx("common.downloadTheBrowserAbout200"),
              () =>
                void api.call("POST", "/api/browser/install", {}).then(
                  () =>
                    reload({
                      text: tx("desktop.settingsSystem.downloadStartedProgressAlsoShows"),
                      tone: "ok",
                    }),
                  (e) =>
                    reload({ text: tx("desktop.settingsSystem.notStarted", { e: errText(e) }), tone: "bad" }),
                ),
              { id: "browser-install" },
            )
          : null;
      return [
        kv(tx("common.status"), ...state),
        download ? h("div", { class: "st-row st-actions" }, download) : null,
      ];
    },
  );
  return section(
    "browser",
    tx("common.browser"),
    body,
    h(
      "label",
      { class: "st-check st-line" },
      h("input", {
        type: "checkbox",
        "data-field": "browserAutoDownload",
        ...(auto.on ? { checked: true } : {}),
        ...(auto.locked ? { disabled: true } : {}),
        onchange: (ev: Event) => auto.save((ev.target as HTMLInputElement).checked),
      }),
      h(
        "span",
        {},
        h("b", {}, tx("desktop.settingsSystem.downloadTheBrowserAutomaticallyWhen")),
        h(
          "small",
          {},
          auto.locked
            ? tx("desktop.settingsSystem.thisLaunchUsedNoBrowser")
            : tx("desktop.settingsSystem.whenChromiumIsntFoundAlca"),
        ),
      ),
    ),
  );
}

export function telegramSection(api: Api, open: (() => void) | undefined): HTMLElement {
  const body = live(
    "st-telegram",
    () => api.call<TelegramView>("GET", "/api/telegram"),
    (t) => [
      kv(
        tx("common.status"),
        !t.tokenSet
          ? tag(tx("desktop.settingsSystem.notSetUpYet"))
          : t.enabled && t.running
            ? tag(tx("desktop.settingsSystem.replying"), "ok")
            : t.enabled
              ? tag(tx("desktop.settingsSystem.enabledButNotRunning"), "warn")
              : tag(tx("common.disabled")),
        t.botUsername ? ` @${t.botUsername}` : "",
        t.tokenSet
          ? tx("desktop.settingsSystem.chatsAllowed", { allowChatIdsCount: t.allowChatIds.length })
          : "",
      ),
      t.lastError ? note(t.lastError, "bad") : null,
    ],
  );
  return section(
    "telegram",
    "Telegram",
    h("p", { class: "lc-help" }, tx("desktop.settingsSystem.talkToAlcaThroughYour")),
    body,
    open
      ? h(
          "div",
          { class: "st-row st-actions" },
          button(tx("desktop.settingsSystem.setUpTelegram"), open, { id: "open-telegram" }),
        )
      : null,
  );
}

/** §4: what is kept how long, what the hourly slot last did, and §3's 驗證稽核紀錄. */
function dataBlock(api: Api): HTMLElement {
  const result = h("div", { class: "st-verify", "aria-live": "polite" });
  const showVerify = (v: VerifyView) =>
    result.replaceChildren(
      h(
        "div",
        { class: "st-verify-card", "data-tone": v.ok ? "ok" : "bad", role: v.ok ? "status" : "alert" },
        ...v.lines.map((l) => h("p", {}, l.trim())),
        v.ok
          ? h("small", { class: "st-dim" }, tx("desktop.settingsSystem.verified", { at: when(v.at) }))
          : h(
              "div",
              { class: "st-row st-actions" },
              button(
                tx("desktop.settingsSystem.openFolder"),
                () => void api.call("POST", "/api/settings/open-data", {}).catch(() => undefined),
                {
                  id: "verify-open-data",
                },
              ),
              button(
                tx("desktop.settingsSystem.copyDiagnostics"),
                () => void navigator.clipboard?.writeText(v.diagnostic).catch(() => undefined),
                { id: "verify-copy" },
              ),
            ),
      ),
    );
  const body = live(
    "st-data",
    () => api.call<DataView>("GET", "/api/settings/data"),
    (d) => [
      kv(tx("desktop.settingsSystem.chatMessages"), tx("desktop.settingsSystem.keptUntilYouDeleteThe")),
      kv(
        tx("desktop.settingsSystem.runStepRecords"),
        tx("desktop.settingsSystem.daysFromWhenTheRun", { runEventsDays: d.retention.runEventsDays }),
      ),
      kv(
        tx("desktop.settingsSystem.toolRecords"),
        tx("desktop.settingsSystem.daysFromWhenTheJob", { jobEventsDays: d.retention.jobEventsDays }),
      ),
      kv(
        tx("desktop.settingsSystem.externalContentAndSideRecords"),
        tx("desktop.settingsSystem.daysTriggersCachedContentWatches", {
          externalDays: d.retention.externalDays,
        }),
      ),
      kv(tx("desktop.settingsSystem.auditLog"), tx("desktop.settingsSystem.keptForeverCantBeDeleted")),
      kv(
        tx("desktop.settingsSystem.dailyBackups"),
        d.retention.dailyBackups
          ? tx("desktop.settingsSystem.keep", { dailyBackups: d.retention.dailyBackups })
          : tx("common.close"),
      ),
      d.hourly
        ? kv(
            tx("desktop.settingsSystem.cleanupAndChecks"),
            d.nextSweepAt
              ? tx("desktop.settingsSystem.hourlyLastNextAround", {
                  lastSweepAt: when(d.lastSweepAt ?? ""),
                  nextSweepAt: when(d.nextSweepAt),
                })
              : tx("desktop.settingsSystem.hourlyFirstRunWithinAn"),
          )
        : kv(
            tx("desktop.settingsSystem.cleanupAndChecks"),
            tag(tx("desktop.settingsSystem.noHourlyCleanupInDev"), "warn"),
          ),
      d.lastDailyBackup
        ? kv(tx("desktop.settingsSystem.latestDailyBackup"), when(d.lastDailyBackup.takenAt))
        : null,
      d.slowBackupMs
        ? note(
            tx("desktop.settingsSystem.theLastDailyBackupTook", { p0: (d.slowBackupMs / 1000).toFixed(1) }),
          )
        : null,
      d.audit && !d.audit.ok ? note(tx("desktop.settingsSystem.theHourlyCheckFoundThe"), "bad") : null,
      d.anchor?.restored
        ? note(tx("desktop.settingsSystem.theAuditLogWasRestored", { lastId: d.anchor.lastId }))
        : null,
      h(
        "div",
        { class: "st-row st-actions" },
        button(
          tx("desktop.settingsSystem.verifyAuditLog"),
          () => {
            result.replaceChildren(note(tx("desktop.settingsSystem.verifying")));
            void api
              .call<VerifyView>("POST", "/api/settings/verify", {})
              .then(showVerify, (e) => result.replaceChildren(note(errText(e), "bad")));
          },
          { id: "verify-audit" },
        ),
      ),
      result,
      h("p", { class: "lc-help" }, tx("desktop.settingsSystem.deletedContentIsZeroedIn")),
    ],
  );
  return body;
}

export function backupSection(api: Api): HTMLElement {
  const body = live(
    "st-backups",
    () => api.call<BackupsView>("GET", "/api/settings/backups"),
    (b, reload) => [
      b.backups.length
        ? h(
            "ul",
            { class: "st-backups-list" },
            ...b.backups.map((x) =>
              h(
                "li",
                { class: "st-backup" },
                h("span", { class: "st-backup-when" }, when(x.takenAt)),
                // B8: the list shortens the name, but `alca db restore` needs all of it.
                h(
                  "code",
                  {
                    class: "st-backup-name",
                    title: x.name,
                    "aria-label": tx("desktop.settingsSystem.backupFile", { name: x.name }),
                  },
                  x.name,
                ),
                h(
                  "small",
                  {},
                  tx("desktop.settingsSystem.databaseVersion", {
                    p0:
                      x.kind === "daily"
                        ? tx("desktop.settingsSystem.daily")
                        : tx("desktop.settingsSystem.manual"),
                    bytes: bytes(x.bytes),
                    version: x.version,
                  }),
                ),
              ),
            ),
          )
        : note(tx("desktop.settingsSystem.noBackupsYetABackup")),
      h(
        "div",
        { class: "st-row st-actions" },
        button(
          tx("desktop.settingsSystem.backUpNow"),
          () =>
            void api.call<BackupsView>("POST", "/api/settings/backups", {}).then(
              (r) =>
                reload({ text: tx("desktop.settingsSystem.backedUp", { made: r.made ?? "" }), tone: "ok" }),
              (e) => reload({ text: errText(e), tone: "bad" }),
            ),
          { id: "backup-now" },
        ),
      ),
      h(
        "p",
        { class: "lc-help" },
        tx("desktop.settingsSystem.preUpgradeAndManualBackups", {
          keep: b.keep,
          keepDaily: b.keepDaily,
          dir: b.dir,
          restoreHint: b.restoreHint,
        }),
      ),
    ],
  );
  return section(
    "backups",
    tx("common.data"),
    perfBlock(api),
    dataBlock(api),
    h("h4", { class: "st-sub" }, tx("desktop.settingsSystem.encryption")),
    sealBlock(api),
    h("h4", { class: "st-sub" }, tx("common.backup")),
    body,
    transferBlock(api),
  );
}

/** Phase E: 更新 — the daily check's result; installing is `alca update install` on the terminal. */
function updateRow(
  api: Api,
  u: UpdateView,
  reload: (m: { text: string; tone: "ok" | "bad" }) => void,
): HTMLElement {
  const lc = u.lastCheck;
  const text =
    u.check === "off" && !lc
      ? tx("desktop.settingsSystem.automaticChecksAreOffEngineering")
      : !lc
        ? tx("desktop.settingsSystem.notCheckedYet")
        : lc.error
          ? tx("desktop.settingsSystem.lastCheckFailed", { error: lc.error })
          : lc.newer && lc.latest
            ? tx("desktop.settingsSystem.newVersionAvailable", { tag: lc.latest.tag })
            : lc.latest
              ? tx("desktop.settingsSystem.upToDateLatest", { tag: lc.latest.tag })
              : tx("desktop.settingsSystem.noPublishedVersionsYet");
  return h(
    "div",
    {},
    kv(
      tx("desktop.settingsSystem.updates"),
      text,
      lc
        ? h("small", { class: "st-dim" }, `${tx("common.joinComma")}${new Date(lc.at).toLocaleString()}`)
        : "",
      " ",
      button(
        tx("desktop.settingsSystem.checkForUpdates"),
        () =>
          void api.call("POST", "/api/settings/update-check", {}).then(
            () => reload({ text: tx("desktop.settingsSystem.checked"), tone: "ok" }),
            (e) => reload({ text: errText(e), tone: "bad" }),
          ),
        { id: "update-check" },
      ),
    ),
    ...(lc?.newer && u.action ? [note(u.action)] : []),
    ...(u.rolledBack
      ? [
          note(
            tx("desktop.settingsSystem.rolledBack", {
              p0: u.rolledBack.auto ? tx("common.auto") : "",
              from: u.rolledBack.from,
              to: u.rolledBack.to,
            }),
          ),
        ]
      : []),
  );
}

export function aboutSection(api: Api, logLevel: Node): HTMLElement {
  const open = (path: string, done: string, reload: (m: { text: string; tone: "ok" | "bad" }) => void) =>
    void api.call("POST", path, {}).then(
      () => reload({ text: done, tone: "ok" }),
      (e) => reload({ text: errText(e), tone: "bad" }),
    );
  const body = live(
    "st-about",
    () => api.call<AboutView>("GET", "/api/settings/about"),
    (a, reload) => [
      kv(
        tx("common.version"),
        // §4.2: the version only; Node and the platform are in its tooltip.
        h("span", { title: `Node ${a.node}${tx("common.joinComma")}${a.platform}` }, `Alca ${a.version}`),
      ),
      ...(a.update ? [updateRow(api, a.update, reload)] : []),
      kv(tx("desktop.settingsSystem.folder"), h("code", {}, a.dataDir)),
      kv(
        tx("desktop.settingsSystem.logFile"),
        a.logFileExists ? h("code", {}, a.logFile) : tx("desktop.settingsSystem.whenStartedFromATerminal"),
      ),
      h(
        "div",
        { class: "st-row st-actions" },
        button(
          tx("desktop.settingsSystem.openFolder"),
          () => open("/api/settings/open-data", tx("desktop.settingsSystem.folderOpened"), reload),
          {
            id: "open-data",
          },
        ),
        button(
          tx("desktop.settingsSystem.openTheLogsFolder"),
          () => open("/api/settings/open-logs", tx("desktop.settingsSystem.logsFolderOpened"), reload),
          {
            id: "open-logs",
          },
        ),
      ),
    ],
  );
  return section("about", tx("common.about"), body, logLevel);
}
