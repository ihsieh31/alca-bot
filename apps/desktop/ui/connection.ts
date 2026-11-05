// 連線 dialog (P9): where paired phones find this computer. The relay in
// use, the opaque mailbox id (derived from this computer's key, so restarts
// do not change it), the 15-minute reachability self-check, an optional
// stable relay URL of the person's own (self-hosted or their own domain) and
// optional direct addresses (Tailscale serve, a LAN listener). Saving tells
// every connected phone the new addresses at once; no re-pairing.
import type { Api } from "./api.ts";
import { h } from "./dom.ts";
import { locale, t } from "./i18n/index.ts";
import { icon } from "./icons.ts";

interface Health {
  lastCheckAt: string | null;
  ok: boolean | null;
  reason: string;
  repairs: number;
  lastRepairAt: string | null;
  onlineSince: string | null;
}

interface ConnectionView {
  status: string;
  relayUrl: string;
  defaultRelayUrl: string;
  stableRelayUrl: string | null;
  siteUrl: string | null;
  defaultSiteUrl: string | null;
  googleClientId: string | null;
  directUrls: string[];
  lan: string[];
  relays: string[];
  mailbox: string;
  health: Health;
  selfCheckMinutes: number;
}

const REASON: Record<string, string> = {
  offline: t("common.notConnectedToTheRelay"),
  no_pong: t("desktop.connection.theRelayIsntResponding"),
  not_listed: t("desktop.connection.theRelayCantFindThis"),
  probe_failed: t("desktop.connection.theRelayCantBeReached"),
};

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : "—";

export function setupConnectionDialog(api: Api): { open(): void } {
  const body = h("div", { class: "lk-body lc-body" });
  const dialog = h(
    "dialog",
    { class: "lk-dialog lc-dialog", "aria-label": t("common.connection") },
    h(
      "header",
      { class: "lk-head" },
      h("h2", { tabindex: "-1", autofocus: true }, t("common.connection")),
      h(
        "button",
        {
          class: "tool-btn",
          type: "button",
          "aria-label": t("common.close"),
          title: t("common.close"),
          onclick: () => dialog.close(),
        },
        icon("cross"),
      ),
    ),
    body,
  );
  document.body.append(dialog);

  const row = (k: string, v: Node | string, tone?: string) =>
    h(
      "div",
      { class: "lc-row" },
      h("span", { class: "lc-k" }, k),
      h("span", { class: "lc-v", ...(tone ? { "data-tone": tone } : {}) }, v),
    );

  const paint = (c: ConnectionView, msg?: { text: string; tone: string }) => {
    const ok = c.status === "online" && c.health.ok !== false;
    const stable = h("input", {
      class: "field",
      type: "url",
      inputmode: "url",
      spellcheck: "false",
      placeholder: t("desktop.connection.httpsRelayYourDomain"),
      value: c.stableRelayUrl ?? "",
      "aria-label": t("desktop.connection.yourOwnStableAddress"),
    }) as HTMLInputElement;
    const direct = h("textarea", {
      class: "field lc-area",
      rows: "2",
      spellcheck: "false",
      placeholder: t("desktop.connection.wssYourMacTailnetTs"),
      "aria-label": t("desktop.connection.directAddress"),
    }) as HTMLTextAreaElement;
    direct.value = c.directUrls.join("\n");
    const site = h("input", {
      class: "field",
      type: "url",
      inputmode: "url",
      spellcheck: "false",
      placeholder: c.defaultSiteUrl ?? t("desktop.connection.httpsAlcaYourDomain"),
      value: c.siteUrl ?? "",
      "aria-label": t("desktop.connection.selfHostedAlcaSite"),
    }) as HTMLInputElement;
    const gid = h("input", {
      class: "field",
      type: "text",
      spellcheck: "false",
      placeholder: "…apps.googleusercontent.com",
      value: c.googleClientId ?? "",
      "aria-label": t("desktop.connection.theSitesGoogleClientId"),
    }) as HTMLInputElement;
    const save = h(
      "button",
      { class: "btn btn-primary lc-btn", type: "button" },
      t("common.save"),
    ) as HTMLButtonElement;
    const check = h(
      "button",
      { class: "btn btn-quiet lc-btn", type: "button" },
      t("common.checkNow"),
    ) as HTMLButtonElement;
    check.addEventListener("click", async () => {
      check.disabled = true;
      const next = await api.call<ConnectionView>("POST", "/api/link/connection/check").catch(() => c);
      paint(
        next,
        next.health.ok ? { text: t("desktop.connection.checkPassedThePhoneCan"), tone: "ok" } : undefined,
      );
    });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const next = await api.call<ConnectionView>("PUT", "/api/link/connection", {
          relayUrl: stable.value.trim(),
          directUrls: direct.value.split(/\s+/).filter(Boolean),
          siteUrl: site.value.trim(),
          googleClientId: gid.value.trim(),
        });
        paint(next, { text: t("desktop.connection.savedConnectedPhonesAlreadyHave"), tone: "ok" });
      } catch (e) {
        paint(c, { text: e instanceof Error ? e.message : t("desktop.connection.notSaved"), tone: "bad" });
      }
    });
    const h0 = c.health;
    body.replaceChildren(
      h(
        "section",
        { class: "lc-state", "data-tone": ok ? "ok" : "warn" },
        h("span", { class: "lc-dot", "aria-hidden": "true" }, icon(ok ? "check" : "alert")),
        h(
          "div",
          {},
          h(
            "b",
            {},
            ok
              ? t("desktop.connection.thePhoneCanFindThis")
              : c.status === "online"
                ? t("desktop.connection.reRegistering")
                : t("desktop.connection.connectingToTheRelay"),
          ),
        ),
        check,
      ),
      // §4.2: relay, mailbox id, self-check and addresses are 技術細節.
      h(
        "details",
        { class: "tech lc-tech" },
        h("summary", {}, t("common.technicalDetails")),
        h(
          "p",
          { class: "lk-note" },
          t("desktop.connection.via", {
            relayUrl: host(c.relayUrl),
            p1: c.stableRelayUrl ? t("desktop.connection.yourOwnAddress") : "",
          }),
        ),
        h(
          "div",
          { class: "lc-rows" },
          row(t("desktop.connection.mailboxId"), h("code", { class: "lc-code" }, c.mailbox)),
          row(
            t("desktop.connection.selfCheck"),
            t("desktop.connection.everyMinLast", {
              selfCheckMinutes: c.selfCheckMinutes,
              lastCheckAt: time(h0.lastCheckAt),
              p2:
                h0.ok === false
                  ? `${t("common.joinComma")}${REASON[h0.reason] ?? h0.reason}`
                  : h0.ok
                    ? t("desktop.connection.ok")
                    : "",
            }),
            h0.ok === false ? "warn" : undefined,
          ),
          row(
            t("desktop.connection.autoRepair"),
            h0.repairs
              ? t("desktop.connection.timesLast", {
                  repairs: h0.repairs,
                  lastRepairAt: time(h0.lastRepairAt),
                })
              : t("desktop.connection.notNeededYet"),
          ),
          row(
            t("desktop.connection.addressesThePhoneKnows"),
            `${c.relays.map(host).join(t("common.text"))}${c.directUrls.length ? t("desktop.connection.direct", { directUrlsCount: c.directUrls.length }) : ""}`,
          ),
        ),
        h("p", { class: "lk-note lc-why" }, t("desktop.connection.theMailboxIdIsDerived")),
      ),
      h(
        "label",
        { class: "lc-field" },
        h(
          "span",
          { class: "lc-label" },
          t("desktop.connection.yourOwnStableAddress"),
          h("small", {}, t("desktop.connection.optional")),
        ),
        stable,
        h(
          "small",
          { class: "lc-help" },
          t("desktop.connection.aSelfHostedRendezvousServer", { defaultRelayUrl: host(c.defaultRelayUrl) }),
        ),
      ),
      h(
        "label",
        { class: "lc-field" },
        h(
          "span",
          { class: "lc-label" },
          t("desktop.connection.directAddressTailscaleLan"),
          h("small", {}, t("desktop.connection.optional")),
        ),
        direct,
        h(
          "small",
          { class: "lc-help" },
          c.lan.length
            ? t("desktop.connection.listeningOnTheLanTurn", { p0: c.lan.map(host).join(t("common.text")) })
            : t("desktop.connection.startWithLinkLan4318"),
        ),
      ),
      h(
        "details",
        { class: "lc-field lc-self", ...(c.siteUrl ? { open: true } : {}) },
        h(
          "summary",
          { class: "lc-label" },
          t("desktop.connection.selfHostedAlcaSite"),
          h("small", {}, t("desktop.connection.optional")),
        ),
        site,
        gid,
        h(
          "small",
          { class: "lc-help" },
          c.defaultSiteUrl
            ? t("desktop.connection.leaveBlankToUseThe", { defaultSiteUrl: host(c.defaultSiteUrl) })
            : t("desktop.connection.thisBuildHasNoBuilt"),
        ),
      ),
      h(
        "div",
        { class: "lc-foot" },
        msg ? h("p", { class: "lc-msg", "data-tone": msg.tone }, msg.text) : h("span", {}),
        save,
      ),
    );
  };

  return {
    open() {
      dialog.showModal();
      body.replaceChildren(h("p", { class: "lk-note" }, t("common.loading")));
      void api
        .call<ConnectionView>("GET", "/api/link/connection")
        .then((c) => paint(c))
        .catch(() =>
          body.replaceChildren(h("p", { class: "lk-note" }, t("desktop.connection.alcaLinkIsntOnYet"))),
        );
    },
  };
}
