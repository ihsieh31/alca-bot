// The phone's native building blocks (§3.7–§3.12 of docs/design/DESIGN-SYSTEM.md):
// inset grouped sections and rows, a switch, a disclosure for 技術細節, the
// empty state and the large-title screen. Every screen is made of these, so
// rows line up the same way everywhere.
import { h, haptic, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";

type Kid = Node | string | null | undefined | false;
export type Tone = "accent" | "waiting" | "danger" | "success" | "muted";

/** An inset grouped section: header 13 (sentence case), cells, footer 13. */
export function group(o: {
  header?: string | null;
  footer?: string | Node | null;
  rows: Kid[];
  className?: string;
  plain?: boolean;
}): HTMLElement {
  const rows = o.rows.filter(Boolean) as Array<Node | string>;
  return h(
    "section",
    { class: `group${o.className ? ` ${o.className}` : ""}`, "data-plain": o.plain ? "true" : undefined },
    o.header ? h("h3", { class: "group-h" }, o.header) : null,
    rows.length ? h("div", { class: "cells" }, ...rows) : null,
    o.footer ? h("p", { class: "group-f" }, o.footer) : null,
  );
}

export interface RowOptions {
  /** A 20px icon in a 28px tinted square, or a bare icon (`bare`). */
  icon?: string | undefined;
  iconTone?: Tone | undefined;
  bare?: boolean | undefined;
  /** Any leading node instead of an icon (an avatar, a spinner). */
  lead?: Node | null | undefined;
  title: string | Node;
  sub?: string | Node | null | undefined;
  subTone?: Tone | undefined;
  /** Trailing value (secondary text), or any node. */
  value?: string | Node | null | undefined;
  valueTone?: Tone | undefined;
  chevron?: boolean | undefined;
  /** Red or blue centred text (忘記這台電腦 / 新增). */
  tone?: "danger" | "accent" | undefined;
  center?: boolean | undefined;
  onclick?: ((ev: Event) => unknown) | undefined;
  label?: string | undefined;
  attrs?: Record<string, string | undefined>;
}

/** One list row: [icon] title / subtitle · trailing value · chevron. A button when tappable. */
export function row(o: RowOptions): HTMLElement {
  const lead =
    o.lead ??
    (o.icon
      ? h(
          "span",
          { class: o.bare ? "row-icon bare" : "row-icon", "data-tone": o.iconTone, "aria-hidden": "true" },
          icon(o.icon, 20),
        )
      : null);
  const text = h(
    "span",
    { class: "row-text" },
    h("span", { class: "row-title" }, o.title),
    o.sub ? h("span", { class: "row-sub", "data-tone": o.subTone }, o.sub) : null,
  );
  const kids: Kid[] = [
    lead,
    text,
    o.value !== undefined && o.value !== null && o.value !== ""
      ? h("span", { class: "row-value", "data-tone": o.valueTone }, o.value)
      : null,
    o.chevron ? h("span", { class: "row-chev", "aria-hidden": "true" }, icon("chevron", 16)) : null,
  ];
  const attrs = {
    class: "row",
    "data-tone": o.tone,
    "data-center": o.center ? "true" : undefined,
    "aria-label": o.label,
    ...(o.attrs ?? {}),
  };
  if (!o.onclick) return h("div", attrs, ...kids);
  const click = o.onclick;
  return h(
    "button",
    {
      ...attrs,
      type: "button",
      onclick: (e: Event) => {
        haptic("tap");
        click(e);
      },
    },
    ...kids,
  );
}

/**
 * A switch: the native `<input type=checkbox switch>` (Safari draws the system switch
 * with its haptic); other engines get the styled fallback from base.css.
 */
export function switchEl(
  on: boolean,
  label: string,
  onchange: (on: boolean, el: HTMLInputElement) => unknown,
): HTMLInputElement {
  const el = h("input", {
    class: "switch-input",
    type: "checkbox",
    switch: true,
    role: "switch",
    "aria-label": label,
    ...(on ? { checked: true } : {}),
  });
  el.addEventListener("change", () => void onchange(el.checked, el));
  return el;
}

/** A row whose trailing element is a switch. */
export function switchRow(o: Omit<RowOptions, "value" | "onclick"> & { sw: HTMLInputElement }): HTMLElement {
  const r = row({ ...o, value: o.sw });
  r.classList.add("row-switch");
  return r;
}

/** 技術細節 (§5.3): a disclosure at the end of an object; mono values, copy each or all. */
export function techDetails(
  entries: Array<[string, string | undefined | null]>,
  label?: string,
): HTMLElement {
  const list = entries.filter((e): e is [string, string] => !!e[1]);
  const copy = (text: string, b: HTMLButtonElement) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        b.dataset.done = "true";
        setTimeout(() => delete b.dataset.done, 1200);
      },
      () => undefined,
    );
  };
  const all = h("button", { class: "td-all text-btn", type: "button" }, t("phone.ui.copyAll"));
  all.addEventListener("click", () => copy(list.map(([k, v]) => `${k}: ${v}`).join("\n"), all));
  return h(
    "details",
    { class: "tech" },
    h(
      "summary",
      { class: "tech-sum" },
      h("span", {}, label ?? t("phone.ui.technicalDetails")),
      icon("chevron", 14),
    ),
    h(
      "dl",
      { class: "tech-list" },
      ...list.map(([k, v]) => {
        const b = h(
          "button",
          { class: "td-copy", type: "button", "aria-label": t("phone.ui.copyValue", { name: k }) },
          icon("copy", 16),
        );
        b.addEventListener("click", () => copy(v, b));
        return h("div", { class: "td-row" }, h("dt", {}, k), h("dd", {}, h("code", {}, v), b));
      }),
    ),
    list.length > 1 ? all : null,
  );
}

/** Empty list (§3.10): 17/600 title, one sentence, one text button; centred. */
export function emptyState(
  title: string,
  text?: string,
  action?: { label: string; run(): void },
): HTMLElement {
  return h(
    "div",
    { class: "empty-state" },
    h("p", { class: "es-title" }, title),
    text ? h("p", { class: "es-text" }, text) : null,
    action
      ? h("button", { class: "text-btn", type: "button", onclick: () => action.run() }, action.label)
      : null,
  );
}

/** A status mark for a row: spinner (running), hand (waiting), check, stop, alert. */
export function statusIcon(
  kind: "running" | "waiting" | "done" | "stopped" | "failed" | "queued",
): HTMLElement {
  if (kind === "running" || kind === "queued")
    return h(
      "span",
      { class: "row-icon bare status", "data-kind": kind, "aria-hidden": "true" },
      h("i", { class: "spin" }),
    );
  const name = { waiting: "hand", done: "checkCircle", stopped: "stopCircle", failed: "alert" }[kind];
  const tone: Tone =
    kind === "waiting" ? "waiting" : kind === "done" ? "success" : kind === "failed" ? "danger" : "muted";
  return h(
    "span",
    { class: "row-icon bare status", "data-tone": tone, "data-kind": kind, "aria-hidden": "true" },
    icon(name, 22),
  );
}

/**
 * A root tab screen: a 44px bar whose centred title fades in as the 34/700 large
 * title scrolls away (§3.1). `content` scrolls; `trailing` holds ≤ 2 icon buttons.
 */
export function largeTitleScreen(o: {
  title: string;
  trailing?: Kid[];
  leading?: Kid;
  content: Node;
  className?: string;
}): { el: HTMLElement; scroller: HTMLElement } {
  const bar = h(
    "header",
    { class: "nav-bar root-bar" },
    h("div", { class: "nav-lead" }, o.leading ?? ""),
    h("h2", { class: "nav-title", "aria-hidden": "true" }, o.title),
    h("div", { class: "nav-trail" }, ...(o.trailing ?? [])),
  );
  const scroller = h("div", { class: "root-scroll" }, h("h1", { class: "large-title" }, o.title), o.content);
  scroller.addEventListener(
    "scroll",
    () => {
      const collapsed = scroller.scrollTop > 36;
      if ((bar.dataset.collapsed === "true") !== collapsed) bar.dataset.collapsed = String(collapsed);
    },
    { passive: true },
  );
  const el = h("section", { class: `root-screen${o.className ? ` ${o.className}` : ""}` }, bar, scroller);
  return { el, scroller };
}
