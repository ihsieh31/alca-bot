// 用 Google 登入 (P10, P12): the phone site's front door. Sign in with Google
// → the computers this account registered (only one: picked for you) → this
// phone shows a 6-digit code → type it on the computer → the normal app.
// After that the phone reconnects with its own key; Google is not asked again.
import {
  type ComputerListing,
  ENROLL_TTL_MS,
  enrollDevice,
  formatEnrollCode,
  generateIdentity,
  type Identity,
  type LinkCredentials,
  LinkError,
  listComputers,
  newEnrollCode,
} from "@alca/link/browser";
import type { SiteConfig } from "./config.ts";
import { browserLabel } from "./device.ts";
import { h, haptic, icon } from "./dom.ts";
import { type GoogleUser, redirectSignIn, tokenFresh } from "./google.ts";
import { googleButton } from "./google-button.ts";
import { t } from "./i18n/index.ts";
import { kv } from "./keystore.ts";
import { deviceName, pairedScreen } from "./pairing.ts";

const ERRORS: Record<string, string> = {
  bad_token: t("phone.account.theRendezvousServerDidntAccept"),
  no_such_computer: t("phone.account.thisComputerIsNoLonger"),
  offline: t("phone.account.theComputerIsOfflineRight"),
  rate_limited: t("common.tooManyAttemptsWaitA"),
  timeout: t("common.theRendezvousServerDidntRespond"),
  denied: t("phone.account.cancelWasPressedOnThe"),
  wrong_code: t("phone.account.tooManyWrongEntriesOn"),
  expired: t("phone.account.theCodeExpiredGenerateA"),
  refused: t("phone.account.theComputerRefusedThisPhone"),
  fingerprint_mismatch: t("phone.account.theComputersKeyDoesntMatch"),
  relay: t("phone.account.thisRendezvousServerDoesntHave"),
  upgrade_required: t("phone.account.thisPagesPairingProtocolIs"),
};
const why = (e: unknown) => {
  const c = e instanceof LinkError ? e.code : "offline";
  return ERRORS[c] ?? t("phone.account.connectionFailed", { c });
};

export interface AccountFlow {
  config: SiteConfig & { googleClientId: string };
  identity: Identity | undefined;
  /** A Google sign-in already in hand (back from the redirect fallback). */
  user?: GoogleUser | undefined;
  onEnrolled(c: LinkCredentials, id: Identity): void;
  /** 改用配對碼 */
  onPairCode(): void;
}

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 90) return t("common.justNow");
  if (s < 3600) return t("common.minAgo", { p0: Math.round(s / 60) });
  if (s < 86_400) return t("common.hrAgo", { p0: Math.round(s / 3600) });
  return t("common.daysAgo", { p0: Math.round(s / 86_400) });
};

/** Phone ↔ computer, joined by a sealed line: the hero of the sign-in screen. */
function linkArt(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 240 120");
  svg.setAttribute("class", "gs-art");
  svg.setAttribute("aria-hidden", "true");
  const add = (tag: string, a: Record<string, string>) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
    svg.append(e);
    return e;
  };
  // computer
  add("rect", { x: "132", y: "26", width: "92", height: "60", rx: "7", class: "gs-line" });
  add("path", { d: "M120 96h116", class: "gs-line" });
  add("path", { d: "M146 44h40M146 54h56M146 64h30", class: "gs-faint" });
  // phone
  add("rect", { x: "18", y: "30", width: "40", height: "70", rx: "9", class: "gs-line" });
  add("path", { d: "M32 37h12", class: "gs-faint" });
  // the sealed line
  add("path", { d: "M64 64C86 64 92 56 110 56s22 0 22 0", class: "gs-dash" });
  add("circle", { cx: "96", cy: "58", r: "11", class: "gs-seal" });
  add("path", { d: "M92 58v-3a4 4 0 0 1 8 0v3M90.5 58h11v7h-11z", class: "gs-lock" });
  return svg;
}

export function googleScreen(o: AccountFlow): HTMLElement {
  const screen = h("section", { class: "screen gs", "aria-label": t("common.signInWithGoogle") });
  let user = o.user;
  const signIn = () => {
    const slot = googleButton({ onClick: () => redirectSignIn(o.config.googleClientId) });
    slot.dataset.autofocus = "true";
    // §3.13 step 1: art, title, one sentence; Google as the one primary, 配對碼 as text.
    screen.replaceChildren(
      h(
        "div",
        { class: "ob-head gs-hero" },
        linkArt(),
        h("h1", { class: "ob-title gs-title" }, t("common.connectToYourComputer")),
        h("p", { class: "ob-sub gs-sub" }, t("phone.account.onceSignedInItFinds")),
      ),
      h(
        "div",
        { class: "ob-actions ob-bottom gs-actions" },
        slot,
        h(
          "button",
          { class: "text-btn ob-alt", type: "button", onclick: () => o.onPairCode() },
          t("phone.account.connectWithAPairingCode"),
        ),
      ),
      h("p", { class: "ob-foot pair-foot" }, icon("lock", 14), t("common.endToEndEncryptedThe")),
    );
  };

  let auto = true;
  const pick = async () => {
    if (!tokenFresh(user)) return signIn();
    const u = user;
    const list = h("div", { class: "cells pc-list", role: "list", "aria-busy": "true" });
    const note = h("p", { class: "group-f pc-note" });
    const refresh = h(
      "button",
      { class: "text-btn ob-alt pc-refresh", type: "button", onclick: () => void pick() },
      t("common.refresh"),
    );
    // §4.1 phone-pick-computer: a grouped list of computers under a large title;
    // the Google account sits in the bar (tap the back chevron to switch).
    screen.replaceChildren(
      h(
        "header",
        { class: "pc-top" },
        h(
          "button",
          {
            class: "icon-btn",
            type: "button",
            "aria-label": t("phone.account.switchAccount"),
            onclick: () => {
              user = undefined;
              signIn();
            },
          },
          icon("back", 24),
        ),
        h(
          "div",
          { class: "pc-account" },
          h("span", { class: "pc-email" }, u.email ?? t("common.googleAccount")),
          h(
            "span",
            { class: "pc-avatar", "aria-hidden": "true" },
            (u.name ?? u.email ?? "?").slice(0, 1).toUpperCase(),
          ),
        ),
      ),
      h(
        "div",
        { class: "pc-head" },
        h("h1", { class: "large-title" }, t("phone.account.chooseAComputer")),
        h("p", { class: "ob-sub" }, t("phone.account.computersRegisteredUnderThisGoogle")),
      ),
      h("div", { class: "group pc-group" }, list, note),
      refresh,
    );
    let computers: ComputerListing[];
    try {
      computers = await listComputers(o.config.relayUrl, u.idToken);
    } catch (e) {
      list.removeAttribute("aria-busy");
      note.textContent = why(e);
      note.classList.add("pc-error");
      list.hidden = true;
      if (e instanceof LinkError && e.code === "bad_token") user = undefined;
      return;
    }
    list.removeAttribute("aria-busy");
    // Only one computer on the account: no choice to make (once; 取消 comes back to the list).
    if (computers.length === 1 && auto) {
      auto = false;
      return void enroll(computers[0] as ComputerListing, u);
    }
    auto = false;
    computers.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen.localeCompare(a.lastSeen));
    list.replaceChildren(
      ...computers.map((c) =>
        h(
          "button",
          {
            class: "row pc-item",
            type: "button",
            role: "listitem",
            "data-online": c.online ? "true" : "false",
            onclick: () => void enroll(c, u),
          },
          h("span", { class: "row-icon pc-icon", "aria-hidden": "true" }, icon("laptop", 20)),
          h(
            "span",
            { class: "row-text" },
            h("span", { class: "row-title" }, c.name),
            h(
              "span",
              { class: "row-sub pc-state" },
              c.online ? t("common.online") : t("phone.account.offlineOnline", { lastSeen: ago(c.lastSeen) }),
            ),
          ),
          h("span", { class: "row-chev", "aria-hidden": "true" }, icon("chevron", 16)),
        ),
      ),
    );
    note.replaceChildren(
      computers.length
        ? t("phone.account.dontSeeYourComputer")
        : t("phone.account.noComputersRegisteredUnderThis"),
      t("phone.account.openPhonesAndDevicesIn"),
    );
  };

  const enroll = async (c: ComputerListing, u: GoogleUser) => {
    const code = newEnrollCode();
    const expires = Date.now() + ENROLL_TTL_MS;
    const num = h(
      "p",
      { class: "sas-num", "aria-label": t("phone.account.code", { p0: code.split("").join(" ") }) },
      formatEnrollCode(code),
    );
    const status = h("p", { class: "sas-status", "aria-live": "polite" });
    const left = h("p", { class: "sas-left" });
    let cancelled = false;
    let over = false;
    const tick = () => {
      const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
      left.textContent =
        s > 0
          ? t("phone.account.validFor", { p0: Math.floor(s / 60), p1: String(s % 60).padStart(2, "0") })
          : t("common.expired");
      if (s > 0 && !over && !cancelled) setTimeout(tick, 1000);
    };
    // Waiting: a spinner and a plain line; a problem: red text with an icon, never a shake.
    const say = (text: string, bad = false) =>
      status.replaceChildren(
        ...(bad
          ? [h("span", { class: "inline-error sas-fail" }, icon("alert", 16), h("span", {}, text))]
          : [h("i", { class: "spin", "aria-hidden": "true" }), h("span", {}, text)]),
      );
    say(t("phone.account.connectingToTheComputer"));
    const again = h(
      "button",
      { class: "btn big primary sas-again", type: "button", hidden: true, onclick: () => void enroll(c, u) },
      t("phone.account.generateANewCode"),
    );
    // §3.13 step 3: 取消 in the bar, the computer's name as a line (not a pill), the code 34/600.
    screen.replaceChildren(
      h(
        "header",
        { class: "pc-top sas-top" },
        h(
          "button",
          {
            class: "text-btn sas-cancel",
            type: "button",
            onclick: () => {
              cancelled = true;
              void pick();
            },
          },
          t("common.cancel"),
        ),
      ),
      h(
        "div",
        { class: "sas" },
        h("h1", { class: "ob-title sas-title" }, t("phone.account.enterThisCodeOnThe")),
        h("p", { class: "ob-sub sas-kicker" }, c.name),
        h("div", { class: "sas-frame" }, num, left),
        status,
        h("p", { class: "ob-sub sas-sub" }, t("phone.account.alcaOnTheComputerWill")),
      ),
      h("div", { class: "ob-actions ob-bottom" }, again),
    );
    tick();
    try {
      const identity = o.identity ?? (await generateIdentity(false));
      if (!o.identity) await kv.set("identity", identity);
      setTimeout(() => !over && !cancelled && say(t("phone.account.waitingForYouToEnter")), 900);
      const creds = await enrollDevice({
        relayUrl: o.config.relayUrl,
        computer: c,
        idToken: u.idToken,
        identity,
        device: { name: deviceName(), kind: "phone", platform: browserLabel() },
        code,
        onWrong: (a) => {
          // G1: the rejected code is spent; show the new one.
          haptic("warn");
          num.textContent = formatEnrollCode(a.code);
          num.setAttribute("aria-label", t("phone.account.code", { p0: a.code.split("").join(" ") }));
          say(t("phone.account.theCodeEnteredOnThe", { left: a.left }), true);
        },
      });
      over = true;
      if (cancelled) return;
      await kv.set("credentials", creds);
      haptic("success");
      screen.replaceChildren(
        pairedScreen(
          t("common.connectedTo", { coreName: creds.coreName }),
          t("phone.account.thisPhoneConnectsAutomaticallyFrom"),
          () => o.onEnrolled(creds, identity),
        ),
      );
    } catch (e) {
      over = true;
      if (cancelled) return;
      haptic("warn");
      say(why(e), true);
      num.classList.add("sas-dim");
      again.hidden = false;
    }
  };

  if (tokenFresh(user)) void pick();
  else signIn();
  return screen;
}
