// The phone's visible area (BUG-9 / BUG-11): one place that keeps the app
// inside what the person can actually see — above the on-screen keyboard,
// and right again after a rotation.
//
// Two browsers, two behaviours:
// - The layout viewport is resized for the keyboard (Android Chrome with
//   `interactive-widget=resizes-content`): body (pinned with inset: 0)
//   already shrinks, so the keyboard height here must be 0.
// - It is not (iOS Safari and the Home Screen app): the visual viewport
//   shrinks and may be panned (`offsetTop`), so `#app` (and the sheet
//   layers) take the visual viewport's height and top from `--vvh` / `--vvt`.
//
// The keyboard only counts while an editable element has focus: a stale
// height left after the keyboard closed (or after a rotation) is what pushed
// the dock to the top of the screen before. The layout height is read from
// the pinned body, not `innerHeight` (iOS reports the visual height there
// while the keyboard is up, which made the old `innerHeight − vv.height`
// come out near 0).

import {
  isEditable,
  NO_KEYBOARD,
  sameState,
  type ViewportInput,
  type ViewportState,
  viewportState,
} from "./viewport-calc.ts";

type Listener = (v: ViewportState) => void;
const listeners = new Set<Listener>();
let current: ViewportState = NO_KEYBOARD;
let installed = false;

/** The last applied state. */
export const viewport = (): ViewportState => current;

/** Called after every change (the chat keeps its newest line in view while the keyboard opens). */
export function onViewport(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function read(): ViewportInput {
  const vv = window.visualViewport;
  const body = document.body?.getBoundingClientRect().height ?? 0;
  return {
    layoutHeight: body > 0 ? body : document.documentElement.clientHeight || window.innerHeight,
    vvHeight: vv ? vv.height : undefined,
    vvOffsetTop: vv ? vv.offsetTop : 0,
    vvScale: vv ? vv.scale : 1,
    editing: isEditable(document.activeElement as HTMLInputElement | null),
  };
}

function apply(v: ViewportState): void {
  const root = document.documentElement;
  if (v.height === undefined) {
    root.style.removeProperty("--vvh");
    root.style.removeProperty("--vvt");
    delete root.dataset.keyboard;
  } else {
    root.style.setProperty("--vvh", `${v.height}px`);
    root.style.setProperty("--vvt", `${v.top}px`);
    root.dataset.keyboard = "open";
  }
}

/** Start following the viewport (once). rAF-throttled, with a re-check after iOS's animations settle. */
export function watchViewport(): void {
  if (installed) return;
  installed = true;
  let frame = 0;
  let later: ReturnType<typeof setTimeout> | undefined;
  const sync = () => {
    frame = 0;
    // The page itself never scrolls (base.css); undo the scroll iOS adds to reveal a field.
    const se = document.scrollingElement;
    if (se && se.scrollTop !== 0) se.scrollTop = 0;
    const next = viewportState(read());
    if (sameState(next, current)) return;
    current = next;
    apply(next);
    for (const l of listeners) l(next);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(sync);
    // The keyboard and rotation animate: look once more after they settle.
    clearTimeout(later);
    later = setTimeout(() => {
      if (!frame) frame = requestAnimationFrame(sync);
    }, 300);
  };
  const vv = window.visualViewport;
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);
  addEventListener("resize", schedule);
  addEventListener("orientationchange", () => {
    schedule();
    setTimeout(schedule, 600);
  });
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  document.addEventListener("visibilitychange", schedule);
  apply(current);
  schedule();
}
