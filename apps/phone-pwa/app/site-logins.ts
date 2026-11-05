// 網站登入 on the phone (design §0.2.7): the website logins the computer
// keeps, listed in 連接 → 帳號, each removable with `approve`. Adding one is
// computer-only — the password never travels the relay — so there is no form
// here, and the list never holds a password.
import { PHONE_LOGINS_NOTE, type PhoneSiteLogin, phoneLoginLine } from "./connect-view.ts";
import { haptic } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { actionSheet } from "./sheet.ts";
import { group, row } from "./ui.ts";

export interface LoginsDeps {
  /** May change things (the approve scope). */
  can: boolean;
  remove(id: string): Promise<unknown>;
  toast(message: string): void;
  reload(): Promise<void>;
}

function confirmRemove(l: PhoneSiteLogin, d: LoginsDeps): void {
  const line = phoneLoginLine(l);
  actionSheet({
    label: t("phone.siteLogins.deleteSiteLogin"),
    title: t("phone.siteLogins.deleteTheLoginFor", { title: line.title }),
    message: t("phone.siteLogins.theComputerDeletesThisUsername"),
    actions: [
      {
        label: t("common.delete"),
        tone: "danger",
        run: async () => {
          try {
            await d.remove(l.id);
          } catch (e) {
            throw new Error(e instanceof Error ? e.message : t("phone.siteLogins.notDeletedPleaseTryAgain"));
          }
          haptic("success");
          d.toast(t("phone.siteLogins.deletedTheLoginFor", { title: line.title }));
          await d.reload();
        },
      },
    ],
  });
}

/** The 網站登入 section: one row per login (tap → 刪除 in an action sheet), and where to add one. */
export function loginsGroup(logins: readonly PhoneSiteLogin[], d: LoginsDeps): HTMLElement {
  return group({
    header: t("common.siteLogins"),
    rows: logins.length
      ? logins.map((l) => {
          const line = phoneLoginLine(l);
          return row({
            icon: "globe",
            title: line.title,
            sub: t("phone.siteLogins.line", { account: line.account, who: line.who }),
            ...(d.can
              ? {
                  value: t("common.delete"),
                  valueTone: "danger" as const,
                  label: t("phone.siteLogins.deleteTheLoginFor2", { title: line.title }),
                  onclick: () => confirmRemove(l, d),
                }
              : {}),
          });
        })
      : [row({ title: t("phone.siteLogins.noSiteLoginsSavedYet"), attrs: { "data-muted": "true" } })],
    footer: PHONE_LOGINS_NOTE,
  });
}
