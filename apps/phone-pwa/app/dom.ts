// Small DOM helpers for the phone app (no framework).
import { t } from "./i18n/index.ts";

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | undefined | null | ((ev: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v as EventListener);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children)
    if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// Stroke icons drawn for Alca (24×24 grid, 1.5 stroke, round caps; §2.8). A `|` splits a
// path into the shape and its inner detail: filled (selected tab), the detail is cut out.
const PATHS: Record<string, string> = {
  chats:
    "M12 4c4.97 0 9 3.36 9 7.5S16.97 19 12 19c-1.1 0-2.15-.16-3.12-.46L4 20l1.4-3.6C4.5 15.1 3 13.4 3 11.5 3 7.36 7.03 4 12 4z",
  activity: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M12 7.5V12l3 2",
  library: "M4 4.5h4v15H4zM10 4.5h4v15h-4zM16.2 5.3l3.8-1 3 14.4-3.8 1z",
  settings:
    "M18.86 10.61L21.13 10.9V13.1L18.86 13.39L17.83 15.87L19.24 17.68L17.68 19.24L15.87 17.83L13.39 18.86L13.1 21.13H10.9L10.61 18.86L8.13 17.83L6.32 19.24L4.76 17.68L6.17 15.87L5.14 13.39L2.87 13.1V10.9L5.14 10.61L6.17 8.13L4.76 6.32L6.32 4.76L8.13 6.17L10.61 5.14L10.9 2.87H13.1L13.39 5.14L15.87 6.17L17.68 4.76L19.24 6.32L17.83 8.13Z|M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0z",
  compose:
    "M12 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-6M17.5 3.5l3 3-8 8H9.5v-3z",
  lock: "M6.5 10.5h11v9h-11zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5",
  card: "M3.5 6h17v12h-17zM3.5 10h17M7 14.5h4",
  mail: "M3.5 6h17v12h-17zM4 6.5l8 6.5 8-6.5",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6",
  doc: "M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12h6M9 15.5h6",
  cursor: "M6 3.5l12 7-5.5 1.5L10 17.5z|M12.5 12l4 6",
  pencil: "M15.5 4.5l4 4L9 19H5v-4z|M13.5 6.5l4 4",
  person: "M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5z",
  wifiOff:
    "M2.5 8.5a14 14 0 0 1 6-3M12 5a14 14 0 0 1 9.5 3.5M5.5 12a9.5 9.5 0 0 1 4-2.2M15 10a9.5 9.5 0 0 1 3.5 2M8.5 15.5a5 5 0 0 1 7 0M12 19h.01M4 4l16 16",
  alert: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M12 7.5v5.5M12 16.5h.01",
  xmark: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M9 9l6 6M15 9l-6 6",
  checkCircle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M8 12.5l2.7 2.7L16 9.8",
  stopCircle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M9.5 9.5h5v5h-5z",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M12 11v5.5M12 7.8h.01",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  archive: "M3.5 5h17v4h-17zM5 9v10.5h14V9M10 13h4",
  down: "M6 9l6 6 6-6",
  mic: "M12 3.5a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0V6A2.5 2.5 0 0 1 12 3.5zM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5v3.5",
  laptop: "M5 5.5h14v10H5zM3 18.5h18",
  copy: "M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4",
  share: "M12 3.5v11M8 7.5l4-4 4 4M6 11H4.5v9.5h15V11H18",
  menu: "M4 7h16M4 12h11M4 17h16",
  team: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5M16 11a2.5 2.5 0 1 0 0-5M16.5 14.5c2.2.2 3.7 1.7 4.2 4.5",
  plus: "M12 5v14M5 12h14",
  send: "M12 19V6M6.5 11.5 12 6l5.5 5.5",
  stop: "M8 8h8v8H8z",
  close: "M6 6l12 12M18 6 6 18",
  back: "M15 5l-7 7 7 7",
  workers: "M12 3.5 20.5 8 12 12.5 3.5 8zM3.5 12 12 16.5 20.5 12M3.5 16 12 20.5 20.5 16",
  globe:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
  phone:
    "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2",
  terminal: "M4 5h16v14H4zM7.5 9.5 10 12l-2.5 2.5M12 15h4",
  devices: "M3 6h12v9H3zM6 18h6M17 9h4v10h-4z",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2",
  check: "M5 12.5l4.5 4.5L19 7.5",
  hand: "M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14c0 3.9-2.6 7-6.5 7S5 18.5 4.2 15.6L3.5 13a1.4 1.4 0 0 1 2.6-1L8 15",
  keyboard: "M3 7h18v10H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  enter: "M19 6v5a3 3 0 0 1-3 3H6M9.5 10.5 6 14l3.5 3.5",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  chevron: "M9 6l6 6-6 6",
  refresh: "M19 11.5A7 7 0 1 1 17 6.6M19 4.5v4h-4",
  plug: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20",
  export: "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14",
  memory: "M6 4.5h9.5L19 8v11.5H6zM15 4.5V8h4M9 12h7M9 15.5h5",
  spark:
    "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9zM18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
  bell: "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5a2.2 2.2 0 0 0 4 0",
  pulse: "M3 12h4l2.5-6 4 12 2.5-6h5",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
};

export function icon(name: keyof typeof PATHS | string, size = 22, filled = false): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", filled ? "icon filled" : "icon");
  const [shape, detail] = (PATHS[name] ?? "").split("|");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", shape ?? "");
  svg.append(p);
  if (detail) {
    const d = document.createElementNS(ns, "path");
    d.setAttribute("d", detail);
    d.setAttribute("class", "icon-detail");
    svg.append(d);
  }
  return svg;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A short tap of the phone's haptics where the platform has them (Android); silent elsewhere. */
export function haptic(kind: "tap" | "success" | "warn" = "tap"): void {
  const nav = navigator as unknown as { vibrate?: (p: number[]) => boolean };
  if (typeof nav.vibrate !== "function") return;
  nav.vibrate(kind === "tap" ? [8] : kind === "success" ? [10, 40, 14] : [18, 60, 18]);
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return t("phone.dom.never");
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return t("common.justNow");
  if (s < 3600) return t("common.minAgo", { p0: Math.floor(s / 60) });
  if (s < 86_400) return t("common.hrAgo", { p0: Math.floor(s / 3600) });
  return t("common.daysAgo", { p0: Math.floor(s / 86_400) });
}

/** Plain text → paragraphs and lists (no HTML from the model ever reaches the DOM as markup). */
export function prose(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)) && lines.length > 0 && block.trim()) {
      const ordered = /^\s*\d/.test(lines[0] ?? "");
      const list = document.createElement(ordered ? "ol" : "ul");
      for (const l of lines) list.append(h("li", {}, l.replace(/^\s*([-*•]|\d+[.)])\s+/, "")));
      frag.append(list);
    } else if (/^```/.test(block)) {
      frag.append(h("pre", {}, block.replace(/^```\w*\n?|```$/g, "")));
    } else {
      const p = h("p");
      lines.forEach((l, i) => {
        if (i) p.append(h("br"));
        p.append(l);
      });
      frag.append(p);
    }
  }
  return frag;
}

export const CLASS_LABEL: Record<string, string> = {
  read: t("common.read"),
  write: t("common.write"),
  execute: t("common.runCommands"),
  network: t("common.network"),
  payment: t("common.pay"),
  send: t("common.send"),
  delete: t("common.delete"),
  publish: t("common.publish"),
};

export const CLASS_TITLE: Record<string, string> = {
  read: t("common.wantsToReadData"),
  write: t("common.wantsToChangeFilesOr"),
  execute: t("phone.dom.wantsToRunACommand"),
  network: t("common.wantsToGoOnline"),
  payment: t("common.wantsToPay"),
  send: t("common.wantsToSendOrDeliver"),
  delete: t("common.wantsToDeleteSomething"),
  publish: t("common.wantsToPublishContent"),
};

export const ALWAYS_CONFIRM = new Set(["payment", "send", "delete", "publish"]);

/** A bot's avatar tile (tone tokens shared with the desktop). */
export function botAvatar(
  b: { avatar: string; color: string | null },
  size: "sm" | "md" | "lg" = "md",
): HTMLElement {
  return h(
    "span",
    { class: "bot-av", "data-size": size, "data-tone": b.color ?? "ink", "aria-hidden": "true" },
    b.avatar || "?",
  );
}
