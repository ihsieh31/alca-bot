// 新增手機 sheet (素 Plain §3.13 desktop): a single-use pairing code + QR on the
// left, the steps on the right; Google sign-in above; paired devices below with
// 撤銷. Everything goes through the loopback API; the code is shown here only.
// Addresses and the safety number sit behind disclosures (§1.6).
import type { Api } from "./api.ts";
import { setupConnectionDialog } from "./connection.ts";
import { $, h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { icon } from "./icons.ts";
import { type PakeStatusView, pakeNote } from "./link-pake-note.ts";
import { remoteSection, watchEnrollments } from "./remote.ts";
import { setupTelegramDialog } from "./telegram.ts";

interface DeviceView {
  id: string;
  name: string;
  kind: "phone" | "hands";
  scopes: string[];
  online: boolean;
  lastSeenAt: string | null;
  safetyNumber: string;
}

interface LinkStatus {
  enabled: boolean;
  status?: string;
  relayUrl?: string;
  safetyNumber?: string;
  devices?: DeviceView[];
  /** G1: recent pairings with the PAKE version they ran (0 = an old v1 phone page, refused). */
  pake?: PakeStatusView;
}

/** G1: say so when the last pairing / enrollment was refused for the removed v1 protocol. */
function legacyNote(st: LinkStatus): HTMLElement | string {
  const text = pakeNote(st.pake);
  return text ? h("p", { class: "lk-note lk-legacy", role: "status" }, text) : "";
}

interface PairingView {
  display: string;
  url: string;
  qrSvg: string;
  expiresAt: string;
  nameplate: string;
}

const SCOPE: Record<string, string> = {
  chat: t("common.chat2"),
  approve: t("common.approve"),
  view_screen: t("common.viewScreen"),
  control_computer: t("common.controlTheComputer"),
  hands: t("common.runCommands"),
};

export function setupLinkDialog(api: Api): { connection: { open(): void }; telegram: { open(): void } } {
  const connection = setupConnectionDialog(api);
  const telegram = setupTelegramDialog(api);
  watchEnrollments(api);
  const body = h("div", { class: "lk-body" });
  const dialog = h(
    "dialog",
    { class: "lk-dialog lk-sheet", "aria-label": t("desktop.link.addPhone") },
    h(
      "header",
      { class: "lk-head" },
      h("h2", { tabindex: "-1", autofocus: true }, t("desktop.link.addPhone")),
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
  let timer: ReturnType<typeof setInterval> | undefined;
  let open: PairingView | undefined;
  dialog.addEventListener("close", () => {
    clearInterval(timer);
    if (open) void api.call("DELETE", `/api/link/pairings/${open.nameplate}`).catch(() => undefined);
    open = undefined;
  });

  const render = async () => {
    const st = await api.call<LinkStatus>("GET", "/api/link").catch(() => ({ enabled: false }) as LinkStatus);
    if (!st.enabled) {
      body.replaceChildren(
        h("p", { class: "lk-note" }, t("desktop.link.alcaLinkIsntOnYet")),
        h(
          "details",
          { class: "tech" },
          h("summary", {}, t("common.technicalDetails")),
          h("pre", { class: "lk-cmd" }, t("desktop.link.pnpmDesktopRendezvousHttpsYour")),
        ),
      );
      return;
    }
    const code = h(
      "div",
      { class: "lk-code", "data-empty": "true" },
      h("div", { class: "lk-qr lk-qr-empty", "aria-hidden": "true" }, icon("phone")),
    );
    // §2.9: an option is a switch row, never a bare checkbox.
    let control = false;
    const controlSwitch = h(
      "button",
      {
        class: "lb-switch",
        type: "button",
        role: "switch",
        "aria-checked": "false",
        "aria-labelledby": "lk-control-label",
        onclick: () => {
          control = !control;
          controlSwitch.setAttribute("aria-checked", String(control));
        },
      },
      h("i"),
    );
    const scopes = h(
      "div",
      { class: "lk-switch-row" },
      h("span", { id: "lk-control-label" }, t("desktop.link.letThisPhoneTakeOver")),
      controlSwitch,
    );
    const make = h(
      "button",
      { class: "btn btn-primary", type: "button" },
      t("desktop.link.generateAPairingCode"),
    );
    make.addEventListener("click", async () => {
      make.setAttribute("disabled", "");
      try {
        const p = await api.call<PairingView>("POST", "/api/link/pairings", {
          scopes: ["chat", "approve", "view_screen", ...(control ? ["control_computer"] : [])],
        });
        open = p;
        const left = h("p", { class: "lk-left" });
        const tick = () => {
          const s = Math.max(0, Math.round((Date.parse(p.expiresAt) - Date.now()) / 1000));
          left.textContent =
            s > 0 ? t("desktop.link.validForSSingleUse", { s }) : t("desktop.link.expiredGenerateANewOne");
          if (s === 0) clearInterval(timer);
        };
        clearInterval(timer);
        timer = setInterval(tick, 1000);
        tick();
        code.removeAttribute("data-empty");
        code.replaceChildren(
          h("img", {
            class: "lk-qr",
            alt: t("desktop.link.pairingQrCode"),
            src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.qrSvg)}`,
          }),
          h(
            "div",
            { class: "lk-digits" },
            h("span", {}, t("common.pairingCode")),
            h("strong", {}, p.display),
            left,
          ),
        );
      } catch (e) {
        code.replaceChildren(
          h(
            "p",
            { class: "lk-error" },
            e instanceof Error ? e.message : t("desktop.link.couldntGenerateAPairingCode"),
          ),
        );
      } finally {
        make.removeAttribute("disabled");
      }
    });
    const list = h(
      "ul",
      { class: "lk-devices" },
      ...(st.devices ?? []).map((d) =>
        h(
          "li",
          {},
          h(
            "div",
            { class: "lk-dev" },
            h("b", {}, d.name),
            h(
              "span",
              { title: `${t("desktop.link.safetyNumber")} ${d.safetyNumber}` },
              [
                d.kind === "hands" ? t("desktop.link.hands") : "",
                d.online ? t("common.online") : t("desktop.link.offline"),
                d.scopes.map((s) => SCOPE[s] ?? s).join(t("common.text")),
              ]
                .filter(Boolean)
                .join(t("common.joinComma")),
            ),
          ),
          h(
            "button",
            {
              class: "lk-revoke",
              type: "button",
              onclick: async () => {
                if (!confirm(t("desktop.link.revokeItDisconnectsRightAway", { name: d.name }))) return;
                await api.call("POST", `/api/link/devices/${d.id}/revoke`).catch(() => undefined);
                void render();
              },
            },
            t("common.revoke"),
          ),
        ),
      ),
    );
    const steps = h(
      "ol",
      { class: "lk-steps" },
      h("li", {}, t("desktop.link.step1")),
      h("li", {}, t("desktop.link.step2")),
      h("li", {}, t("desktop.link.step3")),
    );
    // Without a built-in site the Google block is hidden and pairing is the one way in.
    const pairHead = h("h3", { class: "lk-sub" }, t("desktop.link.useAPairingCode"));
    body.replaceChildren(
      remoteSection(
        api,
        () => void render(),
        (available) => {
          pairHead.textContent = available
            ? t("desktop.link.orUseAPairingCode")
            : t("desktop.link.useAPairingCode");
        },
      ),
      pairHead,
      h(
        "div",
        { class: "lk-pair-grid" },
        code,
        h("div", { class: "lk-pair-side" }, steps, scopes, h("div", { class: "lk-pair" }, make)),
      ),
      legacyNote(st),
      h("h3", { class: "lk-sub" }, t("desktop.link.pairedDevicesHeading")),
      (st.devices ?? []).length ? list : h("p", { class: "lk-note" }, t("common.noPairedDevicesYet")),
      h(
        "div",
        { class: "lk-status" },
        h(
          "p",
          { class: "lk-note", title: st.relayUrl ?? "" },
          st.status === "online" ? t("desktop.link.phonesCanReach") : t("common.connecting"),
        ),
        h(
          "button",
          {
            class: "lb-act",
            type: "button",
            onclick: () => {
              dialog.close();
              connection.open();
            },
          },
          t("desktop.link.connectionSettings"),
        ),
        h(
          "button",
          {
            class: "lb-act",
            type: "button",
            onclick: () => {
              dialog.close();
              telegram.open();
            },
          },
          t("desktop.link.telegramEllipsis"),
        ),
      ),
      h(
        "details",
        { class: "tech" },
        h("summary", {}, t("desktop.link.safetyNumber")),
        h(
          "p",
          { class: "lk-note" },
          t("desktop.link.thisComputersKey"),
          h("code", { class: "lk-key" }, st.safetyNumber ?? ""),
        ),
      ),
    );
  };

  $("phone-toggle").addEventListener("click", () => {
    dialog.showModal();
    void render();
  });
  // P13: 設定 → 連線 / Telegram open these too.
  return { connection, telegram };
}
