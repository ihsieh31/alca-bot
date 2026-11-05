// The person's keyboard shortcuts on the takeover view (mac test 2026-11-04b C3).
// No DOM imports: tested in node.

/** Editing shortcuts passed to the remote page. Paste is not here: the view's own `paste` event inserts the person's clipboard. */
export const REMOTE_SHORTCUTS = ["selectAll", "copy", "cut", "undo", "redo"] as const;
export type RemoteShortcut = (typeof REMOTE_SHORTCUTS)[number];

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * ⌘A / ⌘C / ⌘X / ⌘Z / ⇧⌘Z on a Mac, Ctrl+A / C / X / Z / Y / Shift+Z elsewhere.
 * Undefined for anything else (⌘V is left to the paste event; ⌘R, ⌘W… stay the
 * desktop's own). The other platform's modifier does not count: Ctrl+A on a
 * Mac is "start of line", not "select all".
 */
export function remoteShortcut(e: KeyLike, mac: boolean): RemoteShortcut | undefined {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return undefined;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "a" && !e.shiftKey) return "selectAll";
  if (k === "c" && !e.shiftKey) return "copy";
  if (k === "x" && !e.shiftKey) return "cut";
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !mac && !e.shiftKey) return "redo";
  return undefined;
}
