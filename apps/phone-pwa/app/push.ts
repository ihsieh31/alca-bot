// Web Push on the phone (P8): turning notifications on and off, the prompt
// that explains them, and the iOS "add to Home Screen first" guidance.
//
// The push itself carries only a type and an opaque id; the service worker
// shows a fixed sentence and the app fetches the details over Link when it
// is opened (see sw.ts and main.ts).
import { h, haptic, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { kv } from "./keystore.ts";
import type { Session } from "./session.ts";
import { Sheet } from "./sheet.ts";

export type PushState =
  /** No Push API here (older browser, in-app browser, plain http). */
  | "unsupported"
  /** iOS / iPadOS Safari tab: Web Push exists only for a Home Screen app. */
  | "needs-install"
  | "default"
  | "denied"
  /** Allowed, but this phone has no subscription at the core. */
  | "off"
  | "on";

export const isIos = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

export const isStandalone = (): boolean =>
  // Preview hook (screenshots, desktop browsers): `?display=standalone` stands in for a Home Screen app.
  new URLSearchParams(location.search).get("display") === "standalone" ||
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const hasPush = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && isSecureContext;

const keyBytes = (b64u: string): Uint8Array<ArrayBuffer> => {
  const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64u.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

const sameKey = (a: ArrayBuffer | null, b: Uint8Array) => {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
};

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined;
  return (await navigator.serviceWorker.getRegistration()) ?? undefined;
}

export async function pushState(): Promise<PushState> {
  if (isIos() && !isStandalone()) return "needs-install";
  if (!hasPush()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";
  const sub = await (await registration())?.pushManager.getSubscription();
  return sub && (await kv.get<boolean>("pushOn")) ? "on" : "off";
}

/** Ask for permission (must run inside a tap), subscribe with the core's key, register at the core. */
export async function enablePush(s: Session): Promise<PushState> {
  if (!hasPush()) return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "default";
  const cfg = await s.client.request<{ enabled: boolean; vapidPublicKey: string | null }>("push.config");
  if (!cfg.enabled || !cfg.vapidPublicKey) throw new Error(t("phone.push.theComputerHasntTurnedOn"));
  const reg = await navigator.serviceWorker.ready;
  const key = keyBytes(cfg.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  // Made for another core (re-installed, or another computer): start over.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  await s.client.request("push.subscribe", {
    endpoint: json.endpoint,
    keys: json.keys,
    userAgent: navigator.userAgent.slice(0, 200),
  });
  await kv.set("pushOn", true);
  return "on";
}

export async function disablePush(s: Session): Promise<PushState> {
  const sub = await (await registration())?.pushManager.getSubscription();
  await kv.set("pushOn", false);
  if (sub) {
    await s.client.request("push.unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return pushState();
}

/**
 * On every (re)connection: if this phone has notifications on, hand the core
 * the current subscription again (the browser may have rotated it, or the
 * core forgot a failing one).
 */
export async function resyncPush(s: Session): Promise<void> {
  if ((await pushState()) !== "on") return;
  await enablePush(s).catch(() => undefined);
}

/** A preview of what a notification looks like: the fixed words, never any content. */
function preview(): HTMLElement {
  return h(
    "div",
    { class: "np-preview", "aria-hidden": "true" },
    h("span", { class: "np-app" }, h("img", { src: "./icons/icon-192.png", alt: "" })),
    h(
      "div",
      { class: "np-text" },
      h("p", { class: "np-head" }, h("b", {}, "Alca"), h("span", {}, t("phone.push.now"))),
      h("p", { class: "np-title" }, t("common.waitingOnYou")),
      h("p", { class: "np-body" }, t("common.somethingNeedsYourOkOpen")),
    ),
  );
}

const STEP = (n: string, text: Node | string, extra?: Node) =>
  h("li", { class: "np-step" }, h("span", { class: "np-num" }, n), h("p", {}, text, extra ?? ""));

/** iOS Safari tab: explain the Home Screen requirement (Apple allows Web Push only there). */
function installBody(close: () => void): HTMLElement {
  return h(
    "div",
    { class: "np-sheet" },
    h("div", { class: "np-hero" }, h("span", { class: "np-bell" }, icon("phone", 26))),
    h("h2", { class: "np-title-big" }, t("phone.push.addAlcaToTheHome")),
    h("p", { class: "np-lead" }, t("phone.push.iphoneOnlyLetsWebApps")),
    h(
      "ol",
      { class: "np-steps" },
      STEP("1", t("phone.push.tapShareAtTheBottom"), h("span", { class: "np-glyph" }, icon("export", 16))),
      STEP("2", t("phone.push.scrollDownAndChooseAdd")),
      STEP("3", t("phone.push.openAlcaFromTheHome")),
    ),
    h("p", { class: "fine" }, t("phone.push.pairedDataStaysOnThis")),
    h("button", { class: "btn big secondary", type: "button", onclick: close }, t("common.gotIt")),
  );
}

function deniedBody(close: () => void): HTMLElement {
  return h(
    "div",
    { class: "np-sheet" },
    h("div", { class: "np-hero muted" }, h("span", { class: "np-bell" }, icon("bell", 26))),
    h("h2", { class: "np-title-big" }, t("phone.push.notificationsAreTurnedOff")),
    h(
      "p",
      { class: "np-lead" },
      isIos() ? t("phone.push.goToIphoneSettingsNotifications") : t("phone.push.inTheBrowsersSiteSettings"),
    ),
    h("button", { class: "btn big secondary", type: "button", onclick: close }, t("common.gotIt")),
  );
}

/** The iPhone "add to Home Screen first" sheet on its own (the pairing screen's hint). */
export function openInstallGuide(): Sheet {
  let sheet!: Sheet;
  sheet = new Sheet(
    installBody(() => sheet.close()),
    { label: t("phone.push.addToHomeScreen") },
  );
  return sheet;
}

/**
 * The prompt. Shown once by itself after pairing (when nothing waits for the
 * person), and from 裝置 / 診斷 any time. `onChange` gets the new state.
 */
export async function openPushPrompt(s: Session, onChange?: (st: PushState) => void): Promise<Sheet> {
  const st = await pushState();
  let sheet!: Sheet;
  const close = () => sheet.close();
  if (st === "needs-install") {
    sheet = new Sheet(installBody(close), { label: t("phone.push.addToHomeScreen") });
    return sheet;
  }
  if (st === "denied") {
    sheet = new Sheet(deniedBody(close), { label: t("phone.push.notificationsAreTurnedOff") });
    return sheet;
  }
  const err = h("p", { class: "np-error", role: "alert", hidden: true });
  const on = h(
    "button",
    {
      class: "btn big primary",
      type: "button",
      onclick: async () => {
        on.setAttribute("disabled", "");
        err.hidden = true;
        try {
          const next = await enablePush(s);
          onChange?.(next);
          if (next === "on") {
            haptic("success");
            close();
          } else if (next === "denied") {
            close();
            new Sheet(
              deniedBody(() => undefined),
              { label: t("phone.push.notificationsAreTurnedOff") },
            );
          } else on.removeAttribute("disabled");
        } catch (e) {
          err.textContent = t("phone.push.couldntTurnOn", { message: (e as Error).message });
          err.hidden = false;
          on.removeAttribute("disabled");
        }
      },
    },
    t("phone.push.turnOnNotifications"),
  );
  const body = h(
    "div",
    { class: "np-sheet" },
    preview(),
    h("h2", { class: "np-title-big" }, t("phone.push.remindMeWhenSomethingWaits")),
    h("p", { class: "np-lead" }, t("phone.push.alcaAsksYouBeforePaying")),
    h(
      "ul",
      { class: "np-facts" },
      h("li", {}, icon("check", 16), t("phone.push.notificationsOnlySayWaitingOn")),
      h("li", {}, icon("check", 16), t("phone.push.detailsAreFetchedFromYour")),
      h("li", {}, icon("check", 16), t("phone.push.sentDirectlyByYourComputer")),
    ),
    err,
    h(
      "div",
      { class: "np-actions" },
      on,
      h("button", { class: "btn big ghost", type: "button", onclick: close }, t("phone.push.maybeLater")),
    ),
  );
  void kv.set("pushAsked", true);
  sheet = new Sheet(body, { label: t("phone.push.turnOnNotifications") });
  return sheet;
}

/** Once, after pairing: offer notifications if they are not decided yet. */
export async function maybeOfferPush(s: Session): Promise<void> {
  // Automated browsers (tests, screenshots) get no unsolicited prompt.
  if (navigator.webdriver || (await kv.get<boolean>("pushAsked"))) return;
  const st = await pushState();
  if (st !== "default" && st !== "needs-install") return;
  if (s.cards.length) return; // a card is more important; ask another time
  await openPushPrompt(s);
}

export const PUSH_STATE_TEXT: Record<PushState, string> = {
  unsupported: t("phone.push.thisBrowserDoesntSupportIt"),
  "needs-install": t("phone.push.addToTheHomeScreen"),
  default: t("phone.push.notOnYet"),
  denied: t("phone.push.turnedOff"),
  off: t("common.off"),
  on: t("common.on"),
};
