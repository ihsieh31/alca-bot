// 設定 tab (§2.1, §4.1 phone-devices): the computer this phone is paired with
// (→ 裝置: every paired phone and hands device, each with its permissions and
// a red 撤銷), this phone's 通知 switch, 外觀 and 語言 as menu rows, 進階 › 診斷,
// and 忘記這台電腦 as a red row on its own.
import { ago, h, haptic } from "./dom.ts";
import { applyLocalePref, LOCALE_STORAGE_KEY, t as tx } from "./i18n/index.ts";
import { kv, type ThemePref } from "./keystore.ts";
import { disablePush, openPushPrompt, PUSH_STATE_TEXT, type PushState, pushState } from "./push.ts";
import type { DeviceRow, Session } from "./session.ts";
import { actionSheet, pick, Sheet } from "./sheet.ts";
import { group, largeTitleScreen, row, switchEl, switchRow, techDetails } from "./ui.ts";

const SCOPE: Record<string, string> = {
  chat: tx("common.chat2"),
  approve: tx("common.approve"),
  view_screen: tx("common.viewScreen"),
  control_computer: tx("common.controlTheComputer"),
  hands: tx("common.runCommands"),
};

const THEMES: Array<[ThemePref, string]> = [
  ["system", tx("phone.devices.system")],
  ["light", tx("phone.devices.light")],
  ["dark", tx("phone.devices.dark")],
];

const LANGS: Array<[string, string]> = [
  ["auto", tx("phone.locale.auto")],
  ["zh-Hant-TW", "繁體中文"], // i18n-ignore: a language's own name, the same in every interface
  ["en", "English"],
];

function revoke(s: Session, d: DeviceRow, done?: () => void) {
  actionSheet({
    label: tx("phone.devices.revokeDevice"),
    title: tx("phone.devices.revoke", { name: d.name }),
    message: d.self
      ? tx("phone.devices.thisPhoneDisconnectsRightAway")
      : tx("phone.devices.itDisconnectsRightAwayAnd"),
    actions: [
      {
        label: tx("common.revoke"),
        tone: "danger",
        run: async () => {
          haptic("warn");
          await s.revoke(d.id);
          done?.();
        },
      },
    ],
  });
}

const seen = (d: DeviceRow) =>
  d.self
    ? tx("common.thisPhone")
    : d.online
      ? tx("common.online")
      : tx("common.last", { lastSeenAt: ago(d.lastSeenAt) });

function openDevice(s: Session, d: DeviceRow): Sheet {
  let sheet!: Sheet;
  const body = h(
    "div",
    { class: "device-page" },
    group({
      rows: [
        row({
          icon: d.kind === "hands" ? "terminal" : "phone",
          title: d.name,
          sub: seen(d),
          subTone: d.online && !d.self ? "success" : undefined,
        }),
      ],
    }),
    group({
      header: tx("phone.settings.permissions"),
      rows: Object.entries(SCOPE).map(([k, label]) =>
        row({
          title: label,
          value: d.scopes.includes(k) ? tx("phone.settings.allowed") : tx("phone.settings.notAllowed"),
          valueTone: d.scopes.includes(k) ? undefined : "muted",
        }),
      ),
      footer: tx("phone.settings.permissionsFooter"),
    }),
    group({
      rows: [
        row({
          title: tx("common.revoke"),
          tone: "danger",
          center: true,
          onclick: () => revoke(s, d, () => sheet.close()),
        }),
      ],
      footer: tx("phone.devices.revokingIsRecordedPermanentlyOn"),
    }),
    techDetails([
      [tx("phone.settings.deviceId"), d.id],
      [tx("phone.settings.platform"), d.platform],
      [tx("phone.settings.scopes"), d.scopes.join(", ")],
      [tx("phone.settings.paired"), d.createdAt],
    ]),
  );
  sheet = new Sheet(body, {
    label: d.name,
    size: "page",
    nav: { title: d.name, back: tx("phone.devices.devices") },
  });
  return sheet;
}

/** 裝置: every phone and hands device paired with this computer. */
export function openDevicesPage(s: Session): Sheet {
  const body = h("div", { class: "devices-page" });
  const paint = () => {
    body.replaceChildren(
      group({
        header: tx("phone.devices.phonesAndHandsDevicesConnected", { coreName: s.coreName }),
        rows: s.devices.length
          ? s.devices.map((d) =>
              row({
                icon: d.kind === "hands" ? "terminal" : "phone",
                title: d.name,
                sub: seen(d),
                subTone: d.online && !d.self ? "success" : undefined,
                chevron: true,
                onclick: () => openDevice(s, d),
              }),
            )
          : [row({ title: tx("common.loading2"), attrs: { "data-muted": "true" } })],
      }),
    );
  };
  const off = s.subscribe((w) => w === "devices" && paint());
  paint();
  void s.loadDevices().catch(() => undefined);
  return new Sheet(body, { label: tx("phone.devices.devices"), size: "page", onClose: off });
}

export interface SettingsActions {
  theme(): ThemePref;
  onTheme(t: ThemePref): void;
  onForget(): void;
  onDiag(): void;
}

export function settingsScreen(s: Session, o: SettingsActions): HTMLElement {
  // 通知 (P8): one switch; turning it on goes through the prompt (it explains what a ping says).
  const pushSub = h("span", {}, tx("common.loading"));
  const sw = switchEl(false, tx("common.notifications"), async (on, el) => {
    haptic("tap");
    if (!on) paintPush(await disablePush(s));
    else {
      el.checked = false;
      await openPushPrompt(s, paintPush);
    }
  });
  const paintPush = (st: PushState) => {
    sw.checked = st === "on";
    pushSub.textContent = st === "on" ? tx("phone.devices.whenSomethingWaitsForYour") : PUSH_STATE_TEXT[st];
  };
  void pushState().then(paintPush);
  const langPref = (() => {
    try {
      return localStorage.getItem(`${LOCALE_STORAGE_KEY}.pref`) ?? "auto";
    } catch {
      return "auto";
    }
  })();
  const themeValue = h("span", {}, THEMES.find((x) => x[0] === o.theme())?.[1] ?? "");
  const computer = h("div", { class: "cells" });
  const paintComputer = () =>
    computer.replaceChildren(
      row({
        icon: "laptop",
        title: s.coreName,
        sub: s.conn === "online" ? tx("phone.settings.connected") : tx("phone.chat.macOffline"),
        subTone: s.conn === "online" ? "success" : undefined,
        chevron: true,
        onclick: () => openDevicesPage(s),
        attrs: { "data-row": "devices" },
      }),
    );
  paintComputer();
  s.subscribe((w) => w === "conn" && paintComputer());
  const body = h(
    "div",
    { class: "settings-body" },
    h("section", { class: "group" }, h("h3", { class: "group-h" }, tx("phone.settings.computer")), computer),
    group({
      header: tx("common.thisPhone"),
      rows: [
        switchRow({ icon: "bell", title: tx("common.notifications"), sub: pushSub, sw }),
        row({
          icon: "sun",
          title: tx("phone.devices.appearance"),
          value: themeValue,
          chevron: true,
          onclick: () =>
            pick({
              label: tx("phone.devices.appearance"),
              options: THEMES,
              current: o.theme(),
              onPick: (k) => {
                o.onTheme(k);
                void kv.set("theme", k);
                themeValue.textContent = THEMES.find((x) => x[0] === k)?.[1] ?? "";
              },
            }),
        }),
        row({
          icon: "globe",
          title: tx("phone.locale.title"),
          value: LANGS.find((x) => x[0] === langPref)?.[1] ?? "",
          chevron: true,
          onclick: () =>
            pick({
              label: tx("phone.locale.title"),
              options: LANGS,
              current: langPref,
              onPick: (k) => {
                try {
                  localStorage.setItem(`${LOCALE_STORAGE_KEY}.pref`, k);
                } catch {
                  // No storage: the choice lasts for this page.
                }
                applyLocalePref(k);
              },
            }),
        }),
      ],
    }),
    group({
      header: tx("phone.settings.advanced"),
      rows: [
        row({
          icon: "pulse",
          title: tx("common.diagnostics"),
          sub: tx("phone.devices.connectionNotificationsStorageAndVersion"),
          chevron: true,
          onclick: () => o.onDiag(),
          attrs: { "data-row": "diag" },
        }),
      ],
    }),
    group({
      rows: [
        row({
          title: tx("phone.devices.forgetThisComputer"),
          tone: "danger",
          center: true,
          onclick: () =>
            actionSheet({
              label: tx("phone.devices.forgetThisComputer"),
              title: tx("phone.settings.forgetTitle", { name: s.coreName }),
              message: tx("phone.settings.forgetText"),
              actions: [
                { label: tx("phone.devices.forgetThisComputer"), tone: "danger", run: () => o.onForget() },
              ],
            }),
        }),
      ],
    }),
  );
  return largeTitleScreen({ title: tx("phone.ui.tabSettings"), content: body, className: "settings-screen" })
    .el;
}
