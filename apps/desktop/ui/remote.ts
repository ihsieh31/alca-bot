// 用 Google 登入 (P10, P12), desktop UI: the block in 手機與裝置 that signs
// this computer in with Google (one button; the browser opens the Alca site),
// and the sheet 「輸入手機上的驗證碼」 that appears wherever the person is
// when a phone on the same account picks this computer. A right code stores
// the phone; from then on it connects by itself.
import type { Api } from "./api.ts";
import { h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";

interface RemoteView {
  available: boolean;
  via?: "site" | "desktop";
  state: "off" | "signing_in" | "registering" | "on" | "error";
  email?: string;
  registeredAt?: string;
  authUrl?: string;
  opened?: boolean;
  error?: string;
}

interface Enrollment {
  id: string;
  left: number;
  wrong: boolean;
  state: "code" | "checking";
  expiresAt: string;
}

type Outcome =
  | { ok: true; label: string }
  | { ok: false; error: "wrong_code"; left: number }
  | { ok: false; error: "failed"; message: string };

const G_MARK = () => {
  // Google's four-colour "G" (brand guidelines: the mark is not recoloured).
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  for (const [fill, d] of [
    [
      "#EA4335",
      "M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z",
    ],
    [
      "#4285F4",
      "M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z",
    ],
    [
      "#FBBC05",
      "M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z",
    ],
    [
      "#34A853",
      "M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z",
    ],
  ] as const) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("fill", fill);
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
};

/** The 「用 Google 登入」 block of 手機與裝置. */
export function remoteSection(
  api: Api,
  rerender: () => void,
  onAvailable: (available: boolean) => void = () => undefined,
): HTMLElement {
  const box = h("section", { class: "rm-box", "aria-label": tx("common.signInWithGoogle") });
  let poll: ReturnType<typeof setTimeout> | undefined;
  const draw = (v: RemoteView) => {
    clearTimeout(poll);
    const head = h(
      "div",
      { class: "rm-head" },
      h("h3", {}, tx("common.signInWithGoogle")),
      v.state === "on" ? h("span", { class: "rm-on" }, tx("desktop.remote.on")) : null,
    );
    // No built-in site: say nothing here (self-hosting lives in 連線設定 and the docs).
    box.hidden = !v.available;
    onAvailable(v.available);
    if (!v.available) {
      box.replaceChildren();
      return;
    }
    if (v.state === "on") {
      box.replaceChildren(
        head,
        h(
          "p",
          { class: "lk-note" },
          tx("desktop.remote.signedInAsOpenThe", { email: v.email ?? tx("common.googleAccount") }),
        ),
        h(
          "div",
          { class: "rm-actions" },
          h(
            "button",
            {
              class: "btn btn-quiet",
              type: "button",
              onclick: async () => {
                if (!confirm(tx("desktop.remote.turnOffGoogleRemotePhones"))) return;
                draw((await api.call<RemoteView>("DELETE", "/api/link/remote")) ?? v);
                rerender();
              },
            },
            tx("common.disabled2"),
          ),
        ),
      );
      return;
    }
    const busy = v.state === "signing_in" || v.state === "registering";
    const go = h(
      "button",
      { class: "btn rm-google", type: "button", disabled: busy },
      G_MARK(),
      busy
        ? v.state === "registering"
          ? tx("desktop.remote.registeringThisComputer")
          : tx("desktop.remote.finishSigningInToGoogle")
        : tx("common.signInWithGoogle"),
    );
    go.addEventListener("click", async () => {
      go.setAttribute("disabled", "");
      try {
        const next = await api.call<RemoteView>("POST", "/api/link/remote");
        if (next.authUrl && !next.opened) window.open(next.authUrl, "_blank", "noopener");
        draw(next);
      } catch (e) {
        draw({
          ...v,
          state: "error",
          error: e instanceof Error ? e.message : tx("desktop.remote.couldntStartSignIn"),
        });
      }
    });
    box.replaceChildren(
      head,
      h("p", { class: "lk-note" }, tx("desktop.remote.signInWithGoogleOnce")),
      h("div", { class: "rm-actions" }, go),
      v.authUrl
        ? h(
            "a",
            { class: "rm-link", href: v.authUrl, target: "_blank", rel: "noopener" },
            tx("desktop.remote.noBrowserPoppedUpClick"),
          )
        : "",
      v.error ? h("p", { class: "lk-error", role: "alert" }, v.error) : "",
    );
    if (busy)
      poll = setTimeout(async () => {
        if (!box.isConnected) return;
        const now = await api.call<RemoteView>("GET", "/api/link/remote").catch(() => v);
        draw(now);
        if (now.state === "on") rerender();
      }, 1200);
  };
  void api
    .call<RemoteView>("GET", "/api/link/remote")
    .then(draw)
    .catch(() => {
      box.hidden = true;
      box.replaceChildren();
      onAvailable(false);
    });
  return box;
}

/** Watch for new phones and show 「輸入手機上的驗證碼」 over whatever is open. */
export function watchEnrollments(api: Api): void {
  const open = new Map<string, { dialog: HTMLDialogElement; update(e: Enrollment): void }>();
  let delay = 1500;
  const show = (e: Enrollment) => {
    let cur = e;
    let busy = false;
    const input = h("input", {
      class: "nd-code",
      type: "text",
      inputmode: "numeric",
      autocomplete: "one-time-code",
      maxlength: "7",
      pattern: "[0-9 ]*",
      placeholder: "000 000",
      "aria-label": tx("desktop.remote.n6DigitCodeFromThe"),
      autofocus: true,
    }) as HTMLInputElement;
    const msg = h("p", { class: "nd-msg", role: "status", "aria-live": "polite" });
    const left = h("p", { class: "nd-left" });
    const go = h(
      "button",
      { class: "btn btn-primary nd-allow", type: "submit", disabled: true },
      tx("common.connection"),
    ) as HTMLButtonElement;
    const cancel = h(
      "button",
      { class: "btn btn-quiet nd-deny", type: "button" },
      tx("common.cancel"),
    ) as HTMLButtonElement;
    const digits = () => input.value.replace(/\D/g, "").slice(0, 6);
    input.addEventListener("input", () => {
      const d = digits();
      input.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
      go.disabled = busy || d.length !== 6;
    });
    const form = h(
      "form",
      { class: "nd-form" },
      input,
      msg,
      left,
      h("div", { class: "nd-actions" }, cancel, go),
    ) as HTMLFormElement;
    const dialog = h(
      "dialog",
      { class: "nd-sheet", "aria-label": tx("desktop.remote.enterTheCodeFromThe"), "data-enrollment": e.id },
      h("div", { class: "nd-mark", "aria-hidden": "true" }, "ALCA"),
      h("p", { class: "nd-kicker" }, tx("desktop.remote.aNewPhoneWantsTo")),
      h("h2", { class: "nd-device" }, tx("desktop.remote.enterTheCodeFromThe")),
      h("p", { class: "nd-hint" }, tx("desktop.remote.thePhoneShows6Digits")),
      form,
    ) as HTMLDialogElement;
    const paintLeft = () => {
      const s = Math.max(0, Math.round((Date.parse(cur.expiresAt) - Date.now()) / 1000));
      const mm = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      left.textContent =
        s > 0
          ? tx("desktop.remote.validForTriesLeft", { mm, left: cur.left })
          : tx("desktop.remote.timedOut");
    };
    const say = (text: string, tone: "bad" | "ok" | "" = "") => {
      msg.textContent = text;
      if (tone) msg.dataset.tone = tone;
      else delete msg.dataset.tone;
    };
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (busy || digits().length !== 6) return;
      busy = true;
      go.disabled = true;
      input.disabled = true;
      say(tx("desktop.remote.confirmingWithThePhone"));
      const r = await api.call<Outcome>("POST", `/api/link/enrollments/${e.id}`, { code: digits() }).catch(
        (x: unknown) =>
          ({
            ok: false,
            error: "failed",
            message: x instanceof Error ? x.message : tx("common.notFinished"),
          }) as Outcome,
      );
      busy = false;
      if (r.ok) {
        dialog.dataset.done = "true";
        clearInterval(t);
        left.textContent = "";
        say(tx("desktop.remote.connectedToThisPhoneWill", { label: r.label }), "ok");
        form.querySelector(".nd-actions")?.replaceChildren();
        setTimeout(() => dialog.close(), 1800);
        return;
      }
      input.disabled = false;
      input.value = "";
      input.focus();
      if (r.error === "wrong_code" && r.left > 0) {
        cur = { ...cur, left: r.left };
        paintLeft();
        say(tx("desktop.remote.wrongCodeCheckThePhone", { left: r.left }), "bad");
      } else {
        say(r.error === "wrong_code" ? tx("desktop.remote.tooManyWrongTriesGenerate") : r.message, "bad");
        input.disabled = true;
        dialog.dataset.done = "true";
        setTimeout(() => dialog.close(), 3500);
      }
    });
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      await api.call("POST", `/api/link/enrollments/${e.id}`, { cancel: true }).catch(() => undefined);
      dialog.close();
    });
    // Esc is 取消 too, but never by accident while a code is being checked.
    dialog.addEventListener("cancel", (ev) => {
      ev.preventDefault();
      if (!busy) cancel.click();
    });
    paintLeft();
    const t = setInterval(paintLeft, 1000);
    dialog.addEventListener("close", () => {
      clearInterval(t);
      dialog.remove();
      open.delete(e.id);
    });
    document.body.append(dialog);
    open.set(e.id, { dialog, update: (n) => (cur = { ...cur, ...n }) });
    dialog.showModal();
    input.focus();
  };
  const loop = async () => {
    try {
      if (document.visibilityState === "visible" || open.size) {
        const r = await api.call<{ enrollments: Enrollment[] }>("GET", "/api/link/enrollments");
        const ids = new Set(r.enrollments.map((x) => x.id));
        for (const e of r.enrollments) {
          const o = open.get(e.id);
          if (o) o.update(e);
          else show(e);
        }
        // Gone on the core (the phone left, expired): take the sheet down unless it is showing an outcome.
        for (const [id, o] of open) if (!ids.has(id) && o.dialog.dataset.done !== "true") o.dialog.close();
        delay = 1500;
      }
    } catch {
      delay = Math.min(delay * 2, 15_000); // Link off (503) or the core restarting
    }
    setTimeout(() => void loop(), delay);
  };
  void loop();
}
