// Shared pieces of the 設定 dialog (P13 B3): a titled section, a label / value
// row, a block that loads itself and can be reloaded, and a two-tap confirm.
import { h } from "./dom.ts";
import { locale, t } from "./i18n/index.ts";

export const errText = (e: unknown): string => String((e as Error)?.message ?? e);

export function section(id: string, title: string, ...kids: Array<Node | null>): HTMLElement {
  return h(
    "section",
    { class: "st-section", id: `st-${id}`, "aria-labelledby": `st-${id}-h` },
    h("h3", { class: "st-h", id: `st-${id}-h` }, title),
    ...kids,
  );
}

export function kv(label: string, ...value: Array<Node | string | null>): HTMLElement {
  return h(
    "div",
    { class: "st-kv" },
    h("span", { class: "st-k" }, label),
    h("span", { class: "st-v" }, ...value),
  );
}

export function tag(text: string, tone: "ok" | "warn" | "calm" = "calm"): HTMLElement {
  return h("span", { class: "st-tag", "data-tone": tone }, text);
}

export function note(text: string, tone?: "ok" | "bad"): HTMLElement {
  return h("p", { class: "lc-msg", role: "status", ...(tone ? { "data-tone": tone } : {}) }, text);
}

export function button(label: string, onclick: () => void, o: { danger?: boolean; id?: string } = {}) {
  return h(
    "button",
    {
      class: "btn btn-quiet lc-btn",
      type: "button",
      ...(o.danger ? { "data-tone": "danger" } : {}),
      ...(o.id ? { "data-act": o.id } : {}),
      onclick,
    },
    label,
  );
}

/**
 * A block that fetches its data and draws it; `draw` gets `reload` for after
 * an action. A failed load shows the reason in place.
 */
export function live<T>(
  cls: string,
  load: () => Promise<T>,
  draw: (v: T, reload: (msg?: { text: string; tone: "ok" | "bad" }) => void) => Array<Node | null>,
): HTMLElement {
  const el = h("div", { class: `st-live ${cls}` }, h("p", { class: "lk-note" }, t("common.loading")));
  const reload = (msg?: { text: string; tone: "ok" | "bad" }) => {
    void load().then(
      (v) =>
        el.replaceChildren(
          ...draw(v, reload).filter((x): x is Node => !!x),
          ...(msg ? [note(msg.text, msg.tone)] : []),
        ),
      (e) => el.replaceChildren(note(t("desktop.settingsParts.cantRead", { e: errText(e) }), "bad")),
    );
  };
  reload();
  return el;
}

/** A button that asks for a second tap (「確定…？」) before it acts. */
export function confirmButton(label: string, confirm: string, act: () => void): HTMLElement {
  let armed = false;
  const b = button(
    label,
    () => {
      if (armed) return act();
      armed = true;
      b.textContent = confirm;
      b.setAttribute("data-armed", "true");
    },
    { danger: true },
  );
  return b;
}

export const bytes = (n: number): string =>
  n < 1024 * 1024 ? `${Math.max(1, Math.ceil(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export const when = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleString(locale(), {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
