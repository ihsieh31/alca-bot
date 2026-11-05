// 素 Plain §3.8: many actions on an item live in one `…` menu (a level-2 popover
// list), not in a row of buttons. One menu at a time; Esc, a click outside or a
// pick closes it. Positioned through CSSOM (the page's CSP has no inline styles).
import { h } from "./dom.ts";
import { icon as plainIcon } from "./icons.ts";

export interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
  /** A checkmark in front (a popup-button's current value). */
  checked?: boolean;
}

let open: { el: HTMLElement; close: () => void } | undefined;

export function closeMenu(): void {
  open?.close();
}

/** Opens a menu under `anchor` (right-aligned to it when `align` is "end"). */
export function popMenu(
  anchor: HTMLElement,
  items: readonly MenuItem[],
  align: "start" | "end" = "end",
): void {
  const wasSame = open?.el.dataset.anchor === anchor.dataset.menuId && anchor.dataset.menuId !== undefined;
  closeMenu();
  if (wasSame) return;
  anchor.dataset.menuId ??= String(Math.random()).slice(2);
  const hasCheck = items.some((i) => i.checked !== undefined);
  const el = h(
    "div",
    { class: "menu", role: "menu", "data-anchor": anchor.dataset.menuId },
    ...items.map((i) =>
      h(
        "button",
        {
          class: "menu-item",
          type: "button",
          role: hasCheck ? "menuitemradio" : "menuitem",
          "data-tone": i.danger ? "danger" : undefined,
          "aria-checked": hasCheck ? String(Boolean(i.checked)) : undefined,
          onclick: () => {
            closeMenu();
            i.run();
          },
        },
        hasCheck ? h("span", { class: "menu-check" }, i.checked ? plainIcon("check") : null) : null,
        h("span", {}, i.label),
      ),
    ),
  );
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = align === "end" ? r.right - w : r.left;
  el.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
  const below = r.bottom + 4;
  el.style.top = `${below + el.offsetHeight > innerHeight - 8 ? r.top - el.offsetHeight - 4 : below}px`;
  anchor.setAttribute("aria-expanded", "true");
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
  };
  // WAI-ARIA menu keys: ↑/↓ (wrapping), Home/End, Esc back to the button, Tab leaves and closes.
  const onKey = (e: KeyboardEvent) => {
    const list = [...el.querySelectorAll<HTMLElement>(".menu-item")];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
      anchor.focus();
    } else if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Tab") closeMenu();
  };
  // A menu floats on <body>: when the page under it scrolls or resizes it would drift
  // away from its button (or outlive a re-rendered one), so it closes instead.
  const onMove = (e: Event) => {
    if (!(e.target instanceof Node && el.contains(e.target))) closeMenu();
  };
  const close = () => {
    el.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", onMove, true);
    window.removeEventListener("resize", onMove);
    open = undefined;
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onMove, true);
  window.addEventListener("resize", onMove);
  open = { el, close };
  (el.querySelector(".menu-item") as HTMLElement | null)?.focus();
}

/** The `…` button that opens `items()` (built when pressed, so it reads current state). */
export function moreButton(label: string, items: () => readonly MenuItem[]): HTMLElement {
  const b = h(
    "button",
    {
      class: "tool-btn more-btn",
      type: "button",
      "aria-label": label,
      title: label,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    },
    plainIcon("more"),
  );
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    popMenu(b, items());
  });
  return b;
}
