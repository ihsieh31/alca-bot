// Tiny DOM helpers. Text always goes in as text nodes: no innerHTML anywhere.

import { t as tx } from "./i18n/index.ts";
import { ModalStack, modalKey } from "./modal-keys.ts";

/** Label of the platform's command modifier, for keyboard hints. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | undefined | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

/**
 * A deliberately small Markdown subset, built as DOM nodes:
 * paragraphs, line breaks, ``` fenced code ```, `inline code`, **bold**.
 */
export function renderProse(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      frag.append(h("pre", {}, h("code", {}, part.replace(/\n$/, ""))));
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = h("p");
      para.split("\n").forEach((line, j) => {
        if (j > 0) p.append(h("br"));
        inline(p, line);
      });
      frag.append(p);
    }
  });
  return frag;
}

function inline(parent: HTMLElement, line: string): void {
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) parent.append(line.slice(last, idx));
    const tok = m[0];
    parent.append(tok.startsWith("`") ? h("code", {}, tok.slice(1, -1)) : h("strong", {}, tok.slice(2, -2)));
    last = idx + tok.length;
  }
  if (last < line.length) parent.append(line.slice(last));
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(diff / 60_000);
  if (min < 1) return tx("common.justNow");
  if (min < 60) return tx("desktop.dom.min", { min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return tx("desktop.dom.hr", { hr });
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** "剛剛" or "3 分鐘前" / "2 小時前" / "11/3", for a phrase like 「…連接」. */
export function ago(iso: string, now = Date.now()): string {
  const t = relativeTime(iso, now);
  return t === "剛剛" || t.includes("/") ? t : tx("desktop.dom.ago", { t });
}

export function dayGroup(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return tx("desktop.dom.today");
  if (d.getTime() >= start - 86_400_000) return tx("desktop.dom.yesterday");
  if (d.getTime() >= start - 6 * 86_400_000) return tx("desktop.dom.thisWeek");
  return tx("desktop.dom.earlier");
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const modals = new ModalStack<{ sheet: HTMLElement; close: () => void }>();

document.addEventListener(
  "keydown",
  (e) => {
    const top = modals.top();
    const items = top
      ? [...top.sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      : [];
    const active = document.activeElement;
    const act = modalKey(e.key, e.shiftKey, {
      open: top !== undefined,
      nativeDialog: document.querySelector("dialog[open]") !== null,
      count: items.length,
      active: items.indexOf(active as HTMLElement),
      inside: top?.sheet.contains(active) ?? false,
    });
    if (act.kind === "none" || !top) return;
    e.preventDefault();
    if (act.kind === "close") {
      e.stopImmediatePropagation();
      top.close();
      return;
    }
    const target = act.target === "first" ? items[0] : act.target === "last" ? items.at(-1) : top.sheet;
    (target ?? top.sheet).focus();
  },
  true,
);

/**
 * Mac test 2026-11-04b A7: 「模型與供應商」 did not close on Esc — its key handler
 * sat on the overlay while focus stayed on the sidebar button. An overlay
 * dialog (not a native <dialog>, which does all this itself) goes through
 * here: focus moves into the sheet (`focus` or its first control), Tab stays
 * inside, Esc anywhere closes the top dialog, and focus returns to where it was.
 * Call the returned function from the dialog's own close().
 */
export function trapDialog(sheet: HTMLElement, close: () => void, focus?: HTMLElement): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!sheet.hasAttribute("tabindex")) sheet.tabIndex = -1;
  const pop = modals.push({ sheet, close });
  const target = focus ?? sheet.querySelector<HTMLElement>(FOCUSABLE) ?? sheet;
  target.focus();
  return () => {
    if (pop() && opener?.isConnected) opener.focus();
  };
}

/**
 * A library-style page (團隊, 記憶與技能, 連接, 例行工作): toolbar + `.lb-scroll`.
 * Re-rendering keeps the scroll position while the same page/tab is up (a popup
 * change at the bottom of 連接 used to jump back to the top), and the toolbar
 * title fades in only once the large page title has scrolled away (macOS §3.1:
 * one title on screen at a time).
 */
export function renderPage(root: HTMLElement, key: string, head: HTMLElement, ...content: Node[]): void {
  const old = root.querySelector<HTMLElement>(":scope > .lb-scroll");
  const keep = old && root.dataset.page === key ? old.scrollTop : 0;
  const scroll = h("div", { class: "lb-scroll" }, ...content);
  root.dataset.page = key;
  root.replaceChildren(head, scroll);
  scroll.scrollTop = keep;
  const sync = () => root.toggleAttribute("data-scrolled", scroll.scrollTop > 44);
  scroll.addEventListener("scroll", sync, { passive: true });
  sync();
}
