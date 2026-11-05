// Browser panel parts (split out of browser.ts, review L9; no behaviour change): icons, the
// action-class words, the keys passed through to the page, the address split and the approval
// card for a sensitive browser step.
import { approvalTitle, plainSummary } from "./approval-card.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { icon as plainIcon } from "./icons.ts";

const NS = "http://www.w3.org/2000/svg";
export function icon(paths: string[], size = 20): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
export const I = {
  chevron: ["m5.5 8 4.5 4.5L14.5 8"],
  lock: [
    "M6.5 9V7a3.5 3.5 0 0 1 7 0v2",
    "M5.5 9h9a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z",
  ],
  globe: [
    "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14z",
    "M3 10h14M10 3c2 2.2 2.8 4.5 2.8 7s-.8 4.8-2.8 7c-2-2.2-2.8-4.5-2.8-7S8 5.2 10 3z",
  ],
  shield: ["M10 2.8 4.5 5v4.6c0 3.6 2.4 6.3 5.5 7.6 3.1-1.3 5.5-4 5.5-7.6V5z"],
  close: ["m6 6 8 8M14 6l-8 8"],
  hand: [
    "M7 10V4.8a1.2 1.2 0 0 1 2.4 0V9",
    "M9.4 9V3.8a1.2 1.2 0 0 1 2.4 0V9",
    "M11.8 9V4.8a1.2 1.2 0 0 1 2.4 0v6.4c0 3-2 5.3-5 5.3-2.1 0-3.4-1-4.4-2.6L3.3 11a1.2 1.2 0 0 1 2-1.3L7 12",
  ],
};

export const KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

export interface Pending {
  approvalId: string;
  actionClass: string;
  summary: string;
  threadId: string;
  workerId?: string;
}

export interface BrowserPanelHooks {
  approve(id: string, decision: "approved" | "denied"): void;
  error(err: unknown): void;
  /** Open state changed (to update the top-bar toggle). */
  changed(open: boolean, count: number, attention: boolean): void;
  /** Which bot / worker a worker id is (for the card's origin line). */
  workerLabel?(workerId: string): { title: string; bot?: string } | undefined;
}

export function hostOf(url: string): { host: string; rest: string } {
  try {
    const u = new URL(url);
    if (u.protocol === "about:") return { host: url, rest: "" };
    return { host: u.host, rest: `${u.pathname === "/" ? "" : u.pathname}${u.search}` };
  } catch {
    return { host: url, rest: "" };
  }
}

/** §3.5: the decision lives in the chat; the browser shows one 「需要你」 line for it. */
export function approvalCard(p: Pending): HTMLElement {
  const title = approvalTitle(p.actionClass, plainSummary(p.summary));
  return h(
    "p",
    { class: "bp-approval receipt", "data-tone": "waiting", "aria-label": t("common.approvalCard") },
    h("span", { class: "receipt-icon" }, plainIcon("hand")),
    h("span", { class: "receipt-text" }, t("desktop.approval.pending", { title })),
  );
}
