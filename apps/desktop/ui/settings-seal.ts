// 設定 → 資料 → 加密 (next round R7, Phase F2): whether the content columns
// are sealed, how far the background pass is, where the vault key that
// protects the data key lives, and the one question about the old backups
// (user decision: they go only once everything is sealed).
import type { Api } from "./api.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { button, bytes, errText, kv, live, note, tag, when } from "./settings-parts.ts";

interface EncryptionView {
  on: true;
  keyName: string;
  keyIds: number[];
  currentKeyId: number;
  vault: { where: string; degraded: boolean; text: string };
  plaintext: Record<string, number>;
  remaining: number;
  sealed: Record<string, number>;
  doneAt?: string;
  running: boolean;
  backups: Array<{ name: string; takenAt: string; bytes: number; kind: "backup" | "moved-aside" }>;
  canDropBackups: boolean;
}

export function sealBlock(api: Api): HTMLElement {
  return live(
    "st-seal",
    () => api.call<EncryptionView>("GET", "/api/settings/encryption"),
    (e, reload) => [
      kv(
        t("desktop.settingsSeal.chatContentEncryption"),
        e.remaining === 0 && e.doneAt
          ? tag(t("desktop.settingsSeal.allEncrypted"), "ok")
          : tag(
              e.running
                ? t("desktop.settingsSeal.encryptingInTheBackgroundRows", { remaining: e.remaining })
                : t("desktop.settingsSeal.rowsNotYetEncryptedContinues", { remaining: e.remaining }),
              "warn",
            ),
      ),
      kv(
        t("desktop.settingsSeal.dataKey"),
        t("desktop.settingsSeal.vaultKey", { keyName: e.keyName, currentKeyId: e.currentKeyId }),
      ),
      kv(
        t("desktop.settingsSeal.vaultKeyLocation"),
        e.vault.degraded ? tag(e.vault.text, "warn") : e.vault.text,
      ),
      e.vault.degraded ? note(t("desktop.settingsSeal.whenTheVaultKeyIs"), "bad") : null,
      e.backups.length
        ? h(
            "div",
            { class: "st-seal-backups" },
            h(
              "p",
              {},
              t("desktop.settingsSeal.oldBackupsContainUnencryptedContent", {
                backupsCount: e.backups.length,
              }),
            ),
            h(
              "ul",
              { class: "st-backups-list" },
              ...e.backups.map((b) =>
                h(
                  "li",
                  { class: "st-backup" },
                  h("span", { class: "st-backup-when" }, when(b.takenAt)),
                  h("code", { class: "st-backup-name", title: b.name }, b.name),
                  h(
                    "small",
                    {},
                    `${b.kind === "moved-aside" ? t("desktop.settingsSeal.databaseMovedAsideDuringRestore") : t("common.backup")}${t("common.joinComma")}${bytes(b.bytes)}`,
                  ),
                ),
              ),
            ),
            e.canDropBackups
              ? h(
                  "div",
                  { class: "st-row st-actions" },
                  button(
                    t("desktop.settingsSeal.deleteOldBackupsAndMake"),
                    () =>
                      void api
                        .call<{ backup: string; removed: string[] }>(
                          "POST",
                          "/api/settings/encryption/drop-plaintext-backups",
                          {},
                        )
                        .then(
                          (r) =>
                            reload({
                              text: t("desktop.settingsSeal.deletedOldBackupsTheNew", {
                                removedCount: r.removed.length,
                              }),
                              tone: "ok",
                            }),
                          (err) => reload({ text: errText(err), tone: "bad" }),
                        ),
                    { danger: true, id: "seal-drop-backups" },
                  ),
                )
              : note(t("desktop.settingsSeal.theseOldBackupsCanBe")),
            h("p", { class: "lc-help" }, t("desktop.settingsSeal.afterDeletingThemTheresNo")),
          )
        : null,
    ],
  );
}
