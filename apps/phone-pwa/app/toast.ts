// A short note at the bottom of the screen, over everything (BUG-7/8, C5):
// what a tapped notification led to, a reconnect's result. It lives in its own
// layer above every sheet (the old chat toast sat under an open sheet, and the
// 診斷 toast at the end of the sheet's scrolling content, off screen).
//
// The layer is the one live region (role=status), made empty at boot: a region
// that appears with its first message already inside is usually not announced.
import { h } from "./dom.ts";

let layer: HTMLElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The empty live region; main.ts makes it at boot. Returns whether it was just made. */
export function toastLayer(): { el: HTMLElement; fresh: boolean } {
  if (layer?.isConnected) return { el: layer, fresh: false };
  layer = h("div", { class: "toast-layer", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  document.body.append(layer);
  return { el: layer, fresh: true };
}

export function toast(msg: string, ms = 2600): HTMLElement {
  const { el, fresh } = toastLayer();
  const t = h("p", { class: "app-toast" }, msg);
  // A region made just now: let it exist empty for a moment before it speaks.
  if (fresh) setTimeout(() => el.replaceChildren(t), 100);
  else el.replaceChildren(t);
  clearTimeout(timer);
  timer = setTimeout(() => t.remove(), ms);
  return t;
}
