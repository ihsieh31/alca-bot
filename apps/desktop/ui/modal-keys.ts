// Keyboard rules for overlay dialogs (mac test 2026-11-04b A7), kept free of the DOM so
// they can be tested in node. dom.ts's trapDialog() feeds them the live document.

/** Open overlay dialogs, newest last. Esc closes only the top one. */
export class ModalStack<T> {
  private readonly items: T[] = [];
  push(item: T): () => boolean {
    this.items.push(item);
    return () => {
      const i = this.items.indexOf(item);
      if (i < 0) return false;
      this.items.splice(i, 1);
      return true;
    };
  }
  top(): T | undefined {
    return this.items.at(-1);
  }
  get size(): number {
    return this.items.length;
  }
}

export interface ModalKeyState {
  /** An overlay dialog is open. */
  open: boolean;
  /** A native modal <dialog> is on top; it handles its own keys. */
  nativeDialog: boolean;
  /** Focusable, visible controls inside the top sheet. */
  count: number;
  /** Index of the focused control among them, -1 when it is none of them. */
  active: number;
  /** Focus is somewhere inside the top sheet. */
  inside: boolean;
}

export type ModalKeyAction =
  | { kind: "close" }
  | { kind: "focus"; target: "first" | "last" | "sheet" }
  | { kind: "none" };

/** What a keydown should do while overlay dialogs are open. */
export function modalKey(key: string, shift: boolean, s: ModalKeyState): ModalKeyAction {
  if (!s.open || s.nativeDialog) return { kind: "none" };
  if (key === "Escape") return { kind: "close" };
  if (key !== "Tab") return { kind: "none" };
  if (s.count === 0) return { kind: "focus", target: "sheet" };
  if (shift && (s.active === 0 || !s.inside)) return { kind: "focus", target: "last" };
  if (!shift && (s.active === s.count - 1 || !s.inside)) return { kind: "focus", target: "first" };
  return { kind: "none" };
}

/**
 * What the address asks the window to open: `#token=…&open=settings:advanced`.
 * Read before takeToken() clears the fragment (B0: `#token=…&open=settings` did nothing).
 */
export function hashIntents(hash: string): { pair: boolean; providers: boolean; settings: string | null } {
  const settings = /(?:^|[#&])open=settings(?::([a-z]+))?(?:&|$)/.exec(hash);
  return {
    pair: /(?:^|[#&])open=pair(?:&|$)/.test(hash),
    providers: /(?:^|[#&])open=providers(?:&|$)/.test(hash),
    settings: settings ? (settings[1] ?? "") : null,
  };
}
