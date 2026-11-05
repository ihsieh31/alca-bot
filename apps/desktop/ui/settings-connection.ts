// 設定 → 連線 (P13 B3): which phone site and relay this computer uses
// (official or self-hosted), whether it is signed in with Google, and the
// paired devices with 撤銷. Changing the site / relay / direct addresses
// stays in the 連線 dialog and pairing in 手機與裝置 (the buttons open them).
import type { Api } from "./api.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { button, confirmButton, errText, kv, live, note, section, tag, when } from "./settings-parts.ts";

interface Device {
  id: string;
  name: string;
  kind: "phone" | "hands";
  platform?: string | null;
  scopes: string[];
  online: boolean;
  lastSeenAt: string | null;
}
interface LinkView {
  enabled: boolean;
  status?: string;
  devices?: Device[];
  connection?: {
    relayUrl: string;
    defaultRelayUrl: string;
    stableRelayUrl: string | null;
    siteUrl: string | null;
    defaultSiteUrl: string | null;
  };
}
interface RemoteView {
  available: boolean;
  state: "off" | "signing_in" | "registering" | "on" | "error";
  email?: string;
  error?: string;
}

export interface ConnectionHooks {
  openConnection?: (() => void) | undefined;
  openPairing?: (() => void) | undefined;
}

const host = (u: string | null | undefined) => {
  if (!u) return "—";
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const SCOPE: Record<string, string> = {
  chat: t("common.chat2"),
  approve: t("common.approve"),
  view_screen: t("common.viewScreen"),
  control_computer: t("desktop.settingsConnection.remoteControl"),
};
const STATUS: Record<string, string> = {
  online: t("desktop.settingsConnection.connectedToTheRelay"),
  connecting: t("desktop.settingsConnection.connecting"),
  offline: t("common.notConnectedToTheRelay"),
  closed: t("common.off"),
};

/** `extra`: the 設定 fields of this area (default scopes, pairing, the start-up relay). */
export function connectionSection(api: Api, hooks: ConnectionHooks, extra: Node[]): HTMLElement {
  const body = live(
    "st-conn",
    async () => {
      const link = await api.call<LinkView>("GET", "/api/link");
      const remote = link.enabled
        ? await api.call<RemoteView>("GET", "/api/link/remote").catch(() => undefined)
        : undefined;
      return { link, remote };
    },
    ({ link, remote }, reload) => {
      if (!link.enabled) return [note(t("desktop.settingsConnection.alcaLinkIsOffThis"))];
      const c = link.connection;
      const site = !c?.siteUrl
        ? [tag(t("desktop.settingsConnection.notSet"), "warn")]
        : c.defaultSiteUrl && c.siteUrl === c.defaultSiteUrl
          ? [tag(t("desktop.settingsConnection.official"), "ok"), ` ${host(c.siteUrl)}`]
          : [tag(t("desktop.settingsConnection.selfHosted")), ` ${host(c.siteUrl)}`];
      const relayOwn = !!c?.stableRelayUrl || (!!c && host(c.relayUrl) !== host(c.defaultRelayUrl));
      const google = !remote?.available
        ? [
            tag(t("desktop.settingsConnection.googleSignInNotSet")),
            h("small", { class: "st-dim" }, t("desktop.settingsConnection.needsAPhoneSiteFirst")),
          ]
        : remote.state === "on"
          ? [tag(t("desktop.settingsConnection.signedIn"), "ok"), ` ${remote.email ?? ""}`]
          : remote.state === "error"
            ? [tag(t("desktop.settingsConnection.somethingWentWrong"), "warn"), ` ${remote.error ?? ""}`]
            : remote.state === "off"
              ? [tag(t("desktop.settingsConnection.notSignedIn"))]
              : [tag(t("desktop.settingsConnection.signingIn"))];
      const devices = link.devices ?? [];
      const revoke = async (d: Device) => {
        try {
          await api.call("POST", `/api/link/devices/${d.id}/revoke`, {});
          reload({ text: t("desktop.settingsConnection.revoked", { name: d.name }), tone: "ok" });
        } catch (e) {
          reload({ text: t("desktop.settingsConnection.notRevoked", { e: errText(e) }), tone: "bad" });
        }
      };
      return [
        kv(t("common.status"), STATUS[link.status ?? ""] ?? link.status ?? "—"),
        kv(t("desktop.settingsConnection.phoneSite"), ...site),
        kv(
          t("common.relay"),
          relayOwn ? tag(t("desktop.settingsConnection.selfHosted")) : tag(t("common.default"), "ok"),
          ` ${host(c?.relayUrl)}`,
        ),
        kv(t("common.googleAccount"), ...google),
        h(
          "div",
          { class: "st-row st-actions" },
          hooks.openConnection
            ? button(t("desktop.settingsConnection.changeSiteAndRelay"), () => hooks.openConnection?.(), {
                id: "open-connection",
              })
            : null,
          hooks.openPairing
            ? button(t("desktop.settingsConnection.pairANewPhone"), () => hooks.openPairing?.(), {
                id: "open-pairing",
              })
            : null,
        ),
        h("span", { class: "lc-label" }, t("desktop.settingsConnection.pairedDevices")),
        devices.length
          ? h(
              "ul",
              { class: "st-devices" },
              ...devices.map((d) =>
                h(
                  "li",
                  { class: "st-device", "data-id": d.id },
                  h(
                    "span",
                    { class: "st-device-main" },
                    h("b", {}, d.name),
                    h(
                      "small",
                      {},
                      [
                        d.kind === "hands" ? "hands" : t("common.phone"),
                        d.online
                          ? t("common.online")
                          : d.lastSeenAt
                            ? t("common.last", { lastSeenAt: when(d.lastSeenAt) })
                            : t("desktop.settingsConnection.neverConnected"),
                        d.scopes.map((s) => SCOPE[s] ?? s).join(t("common.text")),
                      ].join(t("common.joinComma")),
                    ),
                  ),
                  confirmButton(
                    t("common.revoke"),
                    t("desktop.settingsConnection.revoke"),
                    () => void revoke(d),
                  ),
                ),
              ),
            )
          : note(t("common.noPairedDevicesYet")),
      ];
    },
  );
  return section("connection", t("common.connection"), body, ...extra);
}
