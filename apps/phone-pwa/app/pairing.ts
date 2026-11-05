// Pairing: type the code the computer shows (or open its QR link), prove it
// with SPAKE2, pin the computer's key. The code is single use.
import {
  fromB64u,
  generateIdentity,
  type Identity,
  type LinkCredentials,
  LinkError,
  pairDevice,
  safetyNumber,
} from "@alca/link/browser";
import { h, haptic, icon } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { kv } from "./keystore.ts";
import { Sheet } from "./sheet.ts";

const ERRORS: Record<string, string> = {
  wrong_code: tx("phone.pairing.wrongPairingCodeThisCode"),
  no_such_code: tx("phone.pairing.thisPairingCodeWasntFound"),
  rate_limited: tx("common.tooManyAttemptsWaitA"),
  offline: tx("phone.pairing.cantReachTheRendezvousServer"),
  timeout: tx("common.theRendezvousServerDidntRespond"),
  fingerprint_mismatch: tx("phone.pairing.theComputersKeyDoesntMatch"),
  refused: tx("phone.pairing.theComputerRefusedThisPairing"),
  malformed: tx("phone.pairing.thePairingCodeIs9"),
  upgrade_required: tx("phone.pairing.thisPagesPairingProtocolIs"),
  downgrade: tx("phone.pairing.theComputerAnsweredWithThe"),
};

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return tx("phone.pairing.androidPhone");
  return tx("common.phone");
}

const groups = (digits: string) => digits.replace(/(\d{3})(?=\d)/g, "$1 ").trim();

export interface PairingParams {
  code?: string;
  fingerprint?: string;
  relay?: string;
}

export function paramsFromHash(hash = location.hash): PairingParams {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    ...(p.get("pair") ? { code: (p.get("pair") as string).replace(/\D/g, "") } : {}),
    ...(p.get("fp") ? { fingerprint: p.get("fp") as string } : {}),
    ...(p.get("r") ? { relay: p.get("r") as string } : {}),
  };
}

export function pairingScreen(o: {
  params: PairingParams;
  identity: Identity | undefined;
  onPaired(c: LinkCredentials, id: Identity): void;
  /** 診斷 (P8): opened from the advanced section. */
  onDiag?: () => void;
  /** iPhone in a Safari tab: how to install first (notifications need a Home Screen app). */
  installHint?: (() => void) | undefined;
  /** The site's relay (config.json); default: this page's origin. */
  relayDefault?: string;
  /** P10: back to 用 Google 登入 when the site has it. */
  onGoogle?: (() => void) | undefined;
}): HTMLElement {
  let fingerprint = o.params.fingerprint;
  const code = h("input", {
    class: "code-input",
    type: "text",
    inputmode: "numeric",
    autocomplete: "one-time-code",
    placeholder: "000 000 000",
    "aria-label": tx("common.pairingCode"),
    maxlength: "13",
    "data-autofocus": "true",
  });
  code.value = groups(o.params.code ?? "");
  const relay = h("input", {
    class: "field-input field-end",
    type: "url",
    inputmode: "url",
    autocapitalize: "off",
    spellcheck: "false",
    "aria-label": tx("phone.pairing.rendezvousServerAddress"),
  });
  relay.value = o.params.relay ?? o.relayDefault ?? location.origin;
  const error = h("p", { class: "inline-error pair-error", role: "alert", hidden: true });
  const submit = h(
    "button",
    { class: "btn big primary", type: "submit", disabled: true },
    h("span", { class: "btn-label" }, tx("common.pair")),
  );
  const valid = () => code.value.replace(/\D/g, "").length >= 9;
  code.addEventListener("input", () => {
    const d = code.value.replace(/\D/g, "").slice(0, 10);
    code.value = groups(d);
    submit.disabled = !valid();
    error.hidden = true;
  });
  submit.disabled = !valid();
  const scan = h("button", { class: "text-btn ob-alt", type: "button" }, tx("phone.pairing.scanQrCode"));
  scan.addEventListener("click", () =>
    scanQr((p) => {
      if (p.code) code.value = groups(p.code);
      if (p.relay) relay.value = p.relay;
      if (p.fingerprint) fingerprint = p.fingerprint;
      submit.disabled = !valid();
    }),
  );

  // §3.13 step 2: the code, 配對, 掃描 QR code; the server address lives under 進階.
  const form = h(
    "form",
    { class: "pair-form", novalidate: true },
    h("label", { class: "code-label" }, h("span", { class: "code-caption" }, tx("common.pairingCode")), code),
    error,
    h("div", { class: "ob-actions" }, submit, scan),
  );
  const advanced = h(
    "details",
    { class: "pair-advanced" },
    h("summary", {}, h("span", {}, tx("phone.pairing.advanced")), icon("chevron", 14)),
    h(
      "div",
      { class: "group" },
      h(
        "div",
        { class: "cells" },
        h(
          "label",
          { class: "row field-pair" },
          h("span", { class: "field-label" }, tx("phone.pairing.rendezvousServer")),
          relay,
        ),
        o.onDiag
          ? h(
              "button",
              { class: "row", type: "button", onclick: () => o.onDiag?.() },
              h("span", { class: "row-text" }, h("span", { class: "row-title" }, tx("common.diagnostics"))),
              h("span", { class: "row-chev", "aria-hidden": "true" }, icon("chevron", 16)),
            )
          : "",
      ),
      h("p", { class: "group-f" }, tx("phone.pairing.defaultsToTheServerThis")),
    ),
  );
  const screen = h(
    "section",
    { class: "screen ob pairing", "aria-label": tx("common.pair") },
    h(
      "div",
      { class: "ob-head" },
      h("h1", { class: "ob-title pair-title" }, tx("common.connectToYourComputer")),
      h("p", { class: "ob-sub pair-sub" }, tx("phone.pairing.pressPhoneInAlcaOn")),
    ),
    form,
    o.onGoogle
      ? h(
          "button",
          { class: "text-btn ob-alt pair-google", type: "button", onclick: () => o.onGoogle?.() },
          tx("phone.pairing.signInWithAGoogle"),
        )
      : "",
    // iPhone in a Safari tab: one footnote, not a card (notifications need a Home Screen app).
    o.installHint
      ? h(
          "p",
          { class: "pair-note" },
          tx("phone.pairing.wantNotificationsOnIphoneAdd"),
          " ",
          h(
            "button",
            { class: "pair-note-link", type: "button", onclick: () => o.installHint?.() },
            tx("phone.pairing.showMeHow"),
          ),
        )
      : "",
    advanced,
    h("p", { class: "ob-foot pair-foot" }, icon("lock", 14), tx("common.endToEndEncryptedThe")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!valid() || submit.disabled) return;
    submit.disabled = true;
    submit.dataset.busy = "true";
    error.hidden = true;
    try {
      const identity = o.identity ?? (await generateIdentity(false));
      if (!o.identity) await kv.set("identity", identity);
      const creds = await pairDevice({
        relayUrl: relay.value.trim() || o.relayDefault || location.origin,
        code: code.value,
        identity,
        device: { name: deviceName(), kind: "phone", platform: navigator.platform || "web" },
        ...(fingerprint ? { expectFingerprint: fingerprint } : {}),
      });
      await kv.set("credentials", creds);
      haptic("success");
      history.replaceState(null, "", location.pathname);
      screen.replaceChildren(await pairedView(creds, () => o.onPaired(creds, identity)));
    } catch (err) {
      const c = err instanceof LinkError ? err.code : "offline";
      error.replaceChildren(
        icon("alert", 16),
        h("span", {}, ERRORS[c] ?? tx("phone.pairing.pairingFailed", { c })),
      );
      error.hidden = false;
      haptic("warn");
      submit.disabled = false;
      delete submit.dataset.busy;
    }
  });
  return screen;
}

async function pairedView(c: LinkCredentials, go: () => void): Promise<HTMLElement> {
  const sn = await safetyNumber(fromB64u(c.corePublicKey));
  return pairedScreen(
    tx("common.connectedTo", { coreName: c.coreName }),
    tx("phone.pairing.theKeyShownOnThe"),
    go,
    sn,
  );
}

/**
 * §3.13 step 4: a check that draws itself, 「已連上 …」, the security code behind
 * a row (not on the main screen), 開始使用. Shared with the Google enroll.
 */
export function pairedScreen(title: string, sub: string, go: () => void, safety?: string): HTMLElement {
  const code = h("p", { class: "safety", hidden: true }, safety ?? "");
  const more = safety
    ? h(
        "div",
        { class: "group paired-safety" },
        h(
          "div",
          { class: "cells" },
          h(
            "button",
            {
              class: "row",
              type: "button",
              "aria-expanded": "false",
              onclick: (e: Event) => {
                const b = e.currentTarget as HTMLElement;
                code.hidden = !code.hidden;
                b.setAttribute("aria-expanded", String(!code.hidden));
              },
            },
            h(
              "span",
              { class: "row-text" },
              h("span", { class: "row-title" }, tx("phone.pairing.securityCode")),
            ),
            h("span", { class: "row-chev", "aria-hidden": "true" }, icon("chevron", 16)),
          ),
        ),
        code,
        h("p", { class: "group-f" }, sub),
      )
    : h("p", { class: "ob-sub" }, sub);
  return h(
    "div",
    { class: "paired" },
    h("div", { class: "paired-mark check-draw", "aria-hidden": "true" }, icon("check", 40)),
    h("h1", { class: "ob-title pair-title" }, title),
    more,
    h(
      "div",
      { class: "ob-actions" },
      h(
        "button",
        { class: "btn big primary", type: "button", "data-autofocus": "true", onclick: go },
        tx("common.getStarted"),
      ),
    ),
  );
}

type Detector = { detect(src: CanvasImageSource): Promise<Array<{ rawValue: string }>> };

/** Camera scan where the browser can decode QR (BarcodeDetector); otherwise explain the camera-app path. */
function scanQr(found: (p: PairingParams) => void) {
  const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  if (!BD || !navigator.mediaDevices?.getUserMedia) {
    new Sheet(
      h(
        "div",
        { class: "info-sheet" },
        h("h2", {}, tx("phone.pairing.scanWithTheCamera")),
        h("p", {}, tx("phone.pairing.openThePhonesCameraApp")),
        h("p", { class: "muted" }, tx("phone.pairing.alcaAddedToTheHome")),
      ),
      { label: tx("phone.pairing.scanningInstructions") },
    );
    return;
  }
  const video = h("video", { class: "scan-video", playsinline: true, muted: true, autoplay: true });
  const note = h("p", { class: "muted" }, tx("phone.pairing.pointAtTheQrCode"));
  let stream: MediaStream | undefined;
  let alive = true;
  const sheet = new Sheet(
    h("div", { class: "scan-sheet" }, h("h2", {}, tx("phone.pairing.scanQrCode")), video, note),
    {
      label: tx("phone.pairing.scanQrCode"),
      size: "tall",
      onClose: () => {
        alive = false;
        for (const t of stream?.getTracks() ?? []) t.stop();
      },
    },
  );
  const det = new BD({ formats: ["qr_code"] });
  void navigator.mediaDevices
    .getUserMedia({ video: { facingMode: "environment" } })
    .then(async (s) => {
      stream = s;
      video.srcObject = s;
      while (alive) {
        await new Promise((r) => setTimeout(r, 250));
        const codes = await det.detect(video).catch(() => []);
        const raw = codes[0]?.rawValue;
        if (!raw) continue;
        try {
          const u = new URL(raw);
          const p = paramsFromHash(u.hash);
          if (!p.code) continue;
          found({ ...p, relay: p.relay ?? u.origin });
          haptic("success");
          sheet.close();
          return;
        } catch {
          // not our link
        }
      }
    })
    .catch(() => {
      note.textContent = tx("phone.pairing.cantUseTheCameraEnter");
    });
}
