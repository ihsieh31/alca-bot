// 素 Plain icon set (§2.8): one outline family, 16×16 viewBox, 1.5 stroke,
// round caps, currentColor. Built as DOM (no innerHTML; CSP-safe).

const PATHS = {
  globe: [
    "M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5z",
    "M2.25 8h11.5M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25z",
  ],
  doc: [
    "M4.5 2.25h4.75L12 5v8.25a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5z",
    "M9 2.5V5.25h2.75M6 8.25h4M6 10.75h3",
  ],
  search: ["M7 2.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5z", "m10.25 10.25 3 3"],
  pencil: ["m10.5 2.75 2.75 2.75-7.5 7.5-3.25.5.5-3.25z", "M9.25 4 12 6.75"],
  mail: ["M2.75 4h10.5v8H2.75z", "m2.75 4.5 5.25 4 5.25-4"],
  person: ["M8 2.75a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z", "M3 13.5c.5-2.4 2.5-4 5-4s4.5 1.6 5 4"],
  pointer: ["M4 2.75 12 7.5l-3.5 1-2 3.75z"],
  terminal: ["M2.75 3.5h10.5v9H2.75z", "m5 6.5 2 1.5-2 1.5M8.5 10h2.5"],
  card: ["M2.25 4.25h11.5v7.5H2.25z", "M2.25 6.75h11.5M4.5 9.5h2"],
  send: ["M13.5 2.5 2.5 7l4.5 1.75L8.75 13.5z", "M7 8.75 13.5 2.5"],
  trash: ["M3 4.5h10M6.25 4.5V3h3.5v1.5M4.5 4.5l.5 9h6l.5-9", "M6.75 7v4.25M9.25 7v4.25"],
  megaphone: ["M2.75 6.5v3h2L10 12.5v-9L4.75 6.5z", "M12 6.25c.6.5.9 1.1.9 1.75s-.3 1.25-.9 1.75"],
  gear: [
    "M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    "M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.06 1.06M4.66 11.34 3.6 12.4M12.4 12.4l-1.06-1.06M4.66 4.66 3.6 3.6",
  ],
  check: ["m3.5 8.25 3 3 6-6.5"],
  cross: ["m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5"],
  alert: ["M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5z", "M8 5v3.5M8 10.75v.25"],
  hand: [
    "M5.5 8.5V3.75a1 1 0 0 1 2 0V7.5M7.5 7V2.75a1 1 0 0 1 2 0V7M9.5 7.25V3.75a1 1 0 0 1 2 0v5.5c0 2.6-1.7 4.5-4.25 4.5-1.6 0-2.6-.7-3.4-1.9L2.6 9.8a1 1 0 0 1 1.6-1.2L5.5 10",
  ],
  stop: ["M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5z", "M6 6h4v4H6z"],
  lock: ["M4 7.25h8v6H4z", "M5.75 7.25V5.5a2.25 2.25 0 0 1 4.5 0v1.75"],
  clock: ["M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5z", "M8 5v3l2 1.25"],
  archive: ["M2.5 3.5h11v2.75h-11z", "M3.5 6.25v6.25h9V6.25M6.5 8.75h3"],
  export: ["M8 2.5v7.5M5 5.25 8 2.5l3 2.75", "M3.5 9v4h9V9"],
  chevron: ["m6 3.75 4.25 4.25L6 12.25"],
  more: ["M3.5 8h.01M8 8h.01M12.5 8h.01"],
  plus: ["M8 3v10M3 8h10"],
  sparkle: ["M8 2.75v10.5M2.75 8h10.5"],
  copy: ["M5.5 5.5h7v7.5h-7z", "M3.5 10.5V3h7"],
  retry: ["M3 8a5 5 0 1 0 1.5-3.55M3 2.75v2.5h2.5"],
  calendar: ["M2.75 3.75h10.5v9.5H2.75z", "M2.75 6.5h10.5M5.5 2.25v2.5M10.5 2.25v2.5"],
  server: ["M2.75 3h10.5v4H2.75zM2.75 9h10.5v4H2.75z", "M5 5h.01M5 11h.01"],
  link: [
    "M6.75 9.25a2.5 2.5 0 0 0 3.54 0l2-2a2.5 2.5 0 0 0-3.54-3.54l-.5.5",
    "M9.25 6.75a2.5 2.5 0 0 0-3.54 0l-2 2a2.5 2.5 0 0 0 3.54 3.54l.5-.5",
  ],
  bell: ["M4.25 11V7.5a3.75 3.75 0 0 1 7.5 0V11l1 1.25h-9.5z", "M6.75 13.75a1.4 1.4 0 0 0 2.5 0"],
  cpu: [
    "M4.5 4.5h7v7h-7z",
    "M6.5 6.5h3v3h-3zM6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2",
  ],
  phone: [
    "M5 2.25h6a.75.75 0 0 1 .75.75v10a.75.75 0 0 1-.75.75H5a.75.75 0 0 1-.75-.75V3A.75.75 0 0 1 5 2.25z",
    "M7.25 11.75h1.5",
  ],
  info: ["M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5z", "M8 7.25v3.75M8 5v.25"],
  book: ["M4.5 2.5h7a1 1 0 0 1 1 1v10l-4.5-2.75L3.5 13.5v-10a1 1 0 0 1 1-1z"],
} as const;

export type IconName = keyof typeof PATHS;

const NS = "http://www.w3.org/2000/svg";

/** An outline icon; `cls` adds classes after `ico`. */
export function icon(name: IconName, cls = ""): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls ? `ico ${cls}` : "ico");
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** The running state (§2.7): a 12px system-style spinner. */
export function spinner(): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "spinner";
  s.setAttribute("aria-hidden", "true");
  return s;
}
