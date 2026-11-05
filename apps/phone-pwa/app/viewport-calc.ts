// The pure part of viewport.ts (BUG-9 / BUG-11): where the app should sit for
// a set of viewport readings. No DOM here, so tests and the node typecheck read it.
/** What the computation needs, read from the page (or made up in a test). */
export interface ViewportInput {
  /** The layout viewport's height: the pinned body's height. */
  layoutHeight: number;
  /** visualViewport height / offsetTop / scale (undefined height = no visualViewport). */
  vvHeight: number | undefined;
  vvOffsetTop: number;
  vvScale: number;
  /** An input, textarea or contenteditable has focus. */
  editing: boolean;
}

export interface ViewportState {
  /** Keyboard height in CSS px (0 = no keyboard, or the browser resized the layout for it). */
  kb: number;
  /** Height for `#app` in px, or undefined = fill the layout viewport. */
  height: number | undefined;
  /** Top offset for `#app` in px (the visual viewport's pan). */
  top: number;
}

/** Below this, a difference is a toolbar or rounding, not a keyboard. */
export const KB_MIN = 80;

export const NO_KEYBOARD: ViewportState = Object.freeze({ kb: 0, height: undefined, top: 0 });

/** The pure part: where the app should sit for these readings. */
export function viewportState(i: ViewportInput): ViewportState {
  if (!i.editing || i.vvHeight === undefined || !(i.layoutHeight > 0)) return NO_KEYBOARD;
  // Pinch-zoomed: the visual viewport is small because of the zoom, not a keyboard.
  if (i.vvScale > 1.01) return NO_KEYBOARD;
  const kb = Math.max(0, Math.round(i.layoutHeight - i.vvHeight));
  if (kb < KB_MIN) return NO_KEYBOARD;
  const top = Math.min(Math.max(0, Math.round(i.vvOffsetTop)), kb);
  return { kb, height: Math.round(i.vvHeight), top };
}

/** Elements that bring up the on-screen keyboard. */
const NO_KEYS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isEditable(
  el: { tagName?: string; type?: string; isContentEditable?: boolean; readOnly?: boolean } | null,
): boolean {
  if (!el?.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return !el.readOnly;
  if (tag === "input") return !el.readOnly && !NO_KEYS.has((el.type ?? "text").toLowerCase());
  return el.isContentEditable === true;
}

export const sameState = (a: ViewportState, b: ViewportState): boolean =>
  a.kb === b.kb && a.height === b.height && a.top === b.top;
