// The Google sign-in button, drawn the way Google's branding guidelines
// describe it: the standard 18 px "G" mark, 12 px gap, "使用 Google 帳戶繼續",
// 40 px tall pill. Dark theme: #131314 fill, #8E918F border, #E3E3E3 text;
// light theme: white fill, #747775 border, #1F1F1F text. We draw it ourselves
// (rather than GIS renderButton) so its size never depends on Google's
// stylesheet loading inside our CSP.
import { t } from "./i18n/index.ts";

const NS = "http://www.w3.org/2000/svg";
const PATHS: Array<[string, string]> = [
  [
    "#EA4335",
    "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z",
  ],
  [
    "#4285F4",
    "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z",
  ],
  [
    "#FBBC05",
    "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z",
  ],
  [
    "#34A853",
    "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z",
  ],
];

export function googleMark(size = 18): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "g-mark");
  for (const [fill, d] of PATHS) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("fill", fill);
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** A Google-branded button (`<a>` when given an href, else `<button>`). */
export function googleButton(o: { label?: string; href?: string; onClick?: () => void }): HTMLElement {
  const el = o.href ? document.createElement("a") : document.createElement("button");
  el.className = "g-btn";
  if (o.href) (el as HTMLAnchorElement).href = o.href;
  else (el as HTMLButtonElement).type = "button";
  if (o.onClick) el.addEventListener("click", o.onClick);
  const label = document.createElement("span");
  label.className = "g-btn-label";
  label.textContent = o.label ?? t("phone.googleButton.continueWithGoogle");
  el.append(googleMark(18), label);
  return el;
}
