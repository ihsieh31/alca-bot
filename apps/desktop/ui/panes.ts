// The full-width panes that take the chat's place (記憶與技能, 連接 / 例行工作, 團隊).
// One is open at a time. Mac test 2026-11-04: going 記憶與技能 → 例行工作 left the
// panel squeezed under the sidebar, because the opening pane hid the chat and then
// closed the other one, whose close showed the chat again. Here the others close
// first, and whether the chat shows is worked out from every pane afterwards, so
// the order the hooks run in does not matter.

export interface Pane {
  readonly isOpen: boolean;
  close(): void;
}

export class Panes {
  private readonly panes = new Map<string, Pane>();
  private readonly apply: (anyOpen: boolean) => void;

  /** `apply(true)`: a pane is open — hide the chat; `false`: show it. */
  constructor(apply: (anyOpen: boolean) => void) {
    this.apply = apply;
  }

  add(name: string, pane: Pane): void {
    this.panes.set(name, pane);
  }

  get anyOpen(): boolean {
    for (const p of this.panes.values()) if (p.isOpen) return true;
    return false;
  }

  /** Call from a pane's `changed` hook (after its own `isOpen` is set). */
  changed(name: string, isOpen: boolean): void {
    if (isOpen) for (const [n, p] of this.panes) if (n !== name && p.isOpen) p.close();
    this.apply(this.anyOpen);
  }
}
