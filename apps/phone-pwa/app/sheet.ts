// Sheets and pages (§3.1, §3.5, §3.14 of docs/design/DESIGN-SYSTEM.md).
//
// - A sheet slides up from the thumb (approval, question, a form): drag the
//   grabber down, tap the scrim or press Esc to dismiss.
// - A page (`size: "page"`) is a pushed screen: it slides in from the right
//   over everything below, with a nav bar (‹ back, centred title, one trailing
//   action). Swipe from the left edge or tap back to pop it. Library and
//   Settings screens are pages, so nothing stacks sheet-on-sheet any more.
// - `actionSheet()` is the iOS action sheet: a short choice (忘記 / 取消).
import { h, icon, reducedMotion } from "./dom.ts";
import { t } from "./i18n/index.ts";

export interface SheetOptions {
  label: string;
  /** auto = fit content; tall = up to 92%; full = edge to edge; page = a pushed screen. */
  size?: "auto" | "tall" | "full" | "page";
  tone?: "danger" | "attention";
  /** Dismissable by drag / scrim / Esc (default true). */
  dismissable?: boolean;
  onClose?: () => void;
  className?: string;
  /** A nav bar: pages always have one (title defaults to `label`); a form sheet passes its own. */
  nav?: { title?: string; leading?: Node | null; trailing?: Node | null; back?: string };
}

let depth = 0;
const stack: Sheet[] = [];
// Esc closes the top sheet wherever focus is (it can fall back to <body> when a control re-renders).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const top = stack.at(-1);
  if (top?.dismissable) {
    e.stopPropagation();
    top.close();
  }
});

/** How many pages are pushed (the tab bar's screens dim behind the first one). */
export const openPages = (): number => stack.filter((x) => x.isPage).length;

/**
 * Only the top sheet takes input: the app under it (#app) and every lower sheet are inert,
 * so VoiceOver and the keyboard stay in what is in front (review #14).
 */
function syncInert(): void {
  const top = stack.at(-1);
  document.getElementById("app")?.toggleAttribute("inert", stack.length > 0);
  for (const x of stack) x.layer.inert = x !== top;
}

/** Close every sheet and page (forget this computer, revoked). */
export function closeAll(): void {
  for (const x of [...stack].reverse()) x.close();
}

export class Sheet {
  readonly layer: HTMLDivElement;
  readonly panel: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly isPage: boolean;
  private closed = false;
  private readonly o: SheetOptions;
  private readonly returnFocus: Element | null;
  private readonly titleEl: HTMLElement | undefined;

  constructor(content: Node, o: SheetOptions) {
    this.o = o;
    this.isPage = o.size === "page";
    this.returnFocus = document.activeElement;
    depth++;
    this.body = h("div", { class: "sheet-body" }, content);
    const grab = h("div", { class: "sheet-grab", "aria-hidden": "true" }, h("i"));
    let bar: HTMLElement | null = null;
    if (this.isPage || o.nav) {
      const n = o.nav ?? {};
      this.titleEl = h("h2", { class: "nav-title" }, n.title ?? o.label);
      const leading =
        n.leading !== undefined
          ? n.leading
          : this.isPage
            ? h(
                "button",
                {
                  class: "nav-back",
                  type: "button",
                  // Named by its visible label (「裝置」…), never overridden (WCAG 2.5.3).
                  onclick: () => this.close(),
                },
                icon("back", 24),
                h("span", { class: "nav-back-label" }, n.back ?? t("phone.ui.back")),
              )
            : null;
      bar = h(
        "header",
        { class: "nav-bar" },
        h("div", { class: "nav-lead" }, leading ?? ""),
        this.titleEl,
        h("div", { class: "nav-trail" }, n.trailing ?? ""),
      );
      // The bar's hairline shows only once content scrolls under it.
      this.body.addEventListener(
        "scroll",
        () => {
          const under = this.body.scrollTop > 2;
          if (bar && (bar.dataset.under === "true") !== under) bar.dataset.under = String(under);
        },
        { passive: true },
      );
    }
    this.panel = h(
      "div",
      {
        class: `sheet ${this.isPage ? "page" : ""} ${o.className ?? ""}`,
        role: "dialog",
        "aria-modal": "true",
        "aria-label": o.label,
        "data-size": o.size ?? "auto",
        "data-tone": o.tone,
        tabindex: "-1",
      },
      this.isPage ? null : grab,
      bar,
      this.body,
    );
    const scrim = h("div", { class: "sheet-scrim", "aria-hidden": "true" });
    this.layer = h("div", { class: `sheet-layer${this.isPage ? " page-layer" : ""}` }, scrim, this.panel);
    // CSSOM, not a style attribute: the CSP has no unsafe-inline.
    this.layer.style.zIndex = String(100 + depth);
    if (o.dismissable !== false) {
      scrim.addEventListener("click", () => this.close());
      if (this.isPage) this.edgeSwipe();
      else this.drag(grab);
    }
    stack.push(this);
    document.body.append(this.layer);
    document.documentElement.dataset.pages = String(openPages());
    syncInert();
    requestAnimationFrame(() => {
      this.layer.dataset.open = "true";
      const first = this.panel.querySelector<HTMLElement>("[data-autofocus]") ?? this.panel;
      first.focus({ preventScroll: true });
    });
  }

  get dismissable(): boolean {
    return this.o.dismissable !== false;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Change the nav title (a page whose subject loads later). */
  setTitle(text: string): void {
    if (this.titleEl) this.titleEl.textContent = text;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    depth--;
    stack.splice(stack.indexOf(this), 1);
    document.documentElement.dataset.pages = String(openPages());
    syncInert();
    this.layer.dataset.open = "false";
    const done = () => {
      this.layer.remove();
      if (this.returnFocus instanceof HTMLElement && this.returnFocus.isConnected)
        this.returnFocus.focus({ preventScroll: true });
    };
    if (reducedMotion()) done();
    else setTimeout(done, this.isPage ? 300 : 320);
    this.o.onClose?.();
  }

  /** Drag the grabber (or the sheet's top 56 px) down to dismiss; flick or > 30% closes. */
  private drag(grab: HTMLElement) {
    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let v = 0;
    let active = false;
    const start = (e: PointerEvent) => {
      const top = this.panel.getBoundingClientRect().top;
      if (e.target !== grab && e.clientY - top > 56) return;
      if ((e.target as HTMLElement).closest("button, input, textarea, a, select")) return;
      active = true;
      startY = lastY = e.clientY;
      lastT = e.timeStamp;
      this.panel.dataset.dragging = "true";
      this.panel.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!active) return;
      const dy = Math.max(0, e.clientY - startY);
      v = (e.clientY - lastY) / Math.max(1, e.timeStamp - lastT);
      lastY = e.clientY;
      lastT = e.timeStamp;
      this.panel.style.transform = `translateY(${dy}px)`;
    };
    const end = () => {
      if (!active) return;
      active = false;
      delete this.panel.dataset.dragging;
      const dy = lastY - startY;
      this.panel.style.transform = "";
      if (dy > this.panel.offsetHeight * 0.3 || v > 0.6) this.close();
    };
    this.panel.addEventListener("pointerdown", start);
    this.panel.addEventListener("pointermove", move);
    this.panel.addEventListener("pointerup", end);
    this.panel.addEventListener("pointercancel", end);
  }

  /** A page pops with a swipe from the left edge, like iOS navigation. */
  private edgeSwipe() {
    let x0 = 0;
    let dx = 0;
    let active = false;
    this.panel.addEventListener("pointerdown", (e) => {
      const left = this.panel.getBoundingClientRect().left;
      if (e.clientX - left > 24 || e.pointerType === "mouse") return;
      active = true;
      x0 = e.clientX;
      dx = 0;
      this.panel.dataset.dragging = "true";
      this.panel.setPointerCapture(e.pointerId);
    });
    this.panel.addEventListener("pointermove", (e) => {
      if (!active) return;
      dx = Math.max(0, e.clientX - x0);
      this.panel.style.transform = `translateX(${dx}px)`;
    });
    const end = () => {
      if (!active) return;
      active = false;
      delete this.panel.dataset.dragging;
      this.panel.style.transform = "";
      if (dx > this.panel.offsetWidth * 0.35) this.close();
    };
    this.panel.addEventListener("pointerup", end);
    this.panel.addEventListener("pointercancel", end);
  }
}

export interface SheetAction {
  label: string;
  tone?: "danger" | "accent";
  /** Return a promise to keep the sheet open (with a spinner) until it settles; throw → the error line. */
  run(): unknown;
  checked?: boolean;
}

/**
 * iOS action sheet: an optional title and message, the actions, then 取消 on its own.
 * `extra` sits between the message and the actions (a switch row: 連同記憶).
 */
export function actionSheet(o: {
  label: string;
  title?: string | undefined;
  message?: string | undefined;
  actions: SheetAction[];
  extra?: Node | null;
  cancel?: string;
}): Sheet {
  let sheet!: Sheet;
  const error = h("p", { class: "as-error", role: "alert", hidden: true });
  const buttons = o.actions.map((a) => {
    const b = h(
      "button",
      // pick(): the current choice is said, not only drawn (the check is decoration).
      {
        class: "as-btn",
        type: "button",
        "data-tone": a.tone,
        "aria-current": a.checked ? "true" : undefined,
      },
      h("span", { class: "btn-label" }, a.label),
      a.checked ? icon("check", 20) : null,
    );
    b.addEventListener("click", async () => {
      if (b.disabled) return;
      for (const x of buttons) x.disabled = true;
      b.dataset.busy = "true";
      try {
        await a.run();
        sheet.close();
      } catch (e) {
        for (const x of buttons) x.disabled = false;
        delete b.dataset.busy;
        error.textContent = e instanceof Error ? e.message : String(e);
        error.hidden = false;
      }
    });
    return b;
  });
  const head =
    o.title || o.message
      ? h(
          "div",
          { class: "as-head" },
          o.title ? h("p", { class: "as-title" }, o.title) : null,
          o.message ? h("p", { class: "as-msg" }, o.message) : null,
        )
      : null;
  sheet = new Sheet(
    h(
      "div",
      { class: "as" },
      h("div", { class: "as-group" }, head, o.extra ?? null, error, ...buttons),
      h(
        "button",
        { class: "as-btn as-cancel", type: "button", "data-autofocus": "true", onclick: () => sheet.close() },
        o.cancel ?? t("common.cancel"),
      ),
    ),
    { label: o.label, className: "action-sheet" },
  );
  return sheet;
}

/** A value picker (外觀, 誰來做…): an action sheet whose current choice has a check. */
export function pick<K extends string>(o: {
  label: string;
  title?: string | undefined;
  options: Array<[K, string]>;
  current: K;
  onPick(k: K): unknown;
}): Sheet {
  return actionSheet({
    label: o.label,
    title: o.title,
    actions: o.options.map(([k, label]) => ({
      label,
      checked: k === o.current,
      run: () => (k === o.current ? undefined : o.onPick(k)),
    })),
  });
}
