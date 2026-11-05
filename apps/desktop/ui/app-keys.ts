// The window's keyboard shortcuts (split out of app.ts, review L9; same keys, same order).
// `?` help, Esc closes the help / an open pane / interrupts a run, ⌘/Ctrl+J new thread,
// +B browser, +I workers, +Shift+M memory, +K search, +Enter / +Shift+Backspace answer
// the card, Alt+↑/↓ switch thread, / composer, 1–9 a question's choice.
import { mod, typing } from "./app-chrome.ts";

interface Pane {
  isOpen: boolean;
  close(): void;
}

export interface ShortcutHost {
  help: HTMLElement;
  /** Library, 連接, 團隊 — Esc closes the first that is open (in this order). */
  panes(): Array<Pane | undefined>;
  current(): string | null;
  busy(): boolean;
  interrupt(threadId: string): void;
  newThread(): void;
  /** Each returns false when that panel is not available (the key then does nothing). */
  togglePanel(): boolean;
  toggleWorkers(): boolean;
  toggleLibrary(): boolean;
  focusSearch(): void;
  focusInput(): void;
  timeline: {
    pendingApproval: string | null | undefined;
    pendingQuestion: { id: string; choices: string[] } | null | undefined;
  };
  decide(approvalId: string, decision: "approved" | "denied"): void;
  answer(questionId: string, choice: string): void;
  /** Alt+↑ (-1) / Alt+↓ (+1). */
  step(by: number): void;
  /** 素 Plain: ⌘\\ hides the sidebar, ⌘, opens 設定. */
  toggleSidebar?(): void;
  openSettings?(): void;
}

export function installShortcuts(k: ShortcutHost): void {
  const { help, timeline } = k;
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (!help.hidden) {
        help.hidden = true;
        return;
      }
      if (!typing()) {
        const pane = k.panes().find((p) => p?.isOpen);
        if (pane) {
          pane.close();
          return;
        }
      }
      const current = k.current();
      if (current && k.busy()) {
        ev.preventDefault();
        k.interrupt(current);
      }
      return;
    }
    const key = ev.key.toLowerCase();
    if (mod(ev) && key === "j") {
      ev.preventDefault();
      return k.newThread();
    }
    // A shortcut whose panel is missing falls through, as before (the browser behind its flag).
    if (mod(ev) && key === "b" && k.togglePanel()) return ev.preventDefault();
    if (mod(ev) && key === "i" && k.toggleWorkers()) return ev.preventDefault();
    if (mod(ev) && ev.shiftKey && key === "m" && k.toggleLibrary()) return ev.preventDefault();
    if (mod(ev) && ev.key === "\\" && k.toggleSidebar) {
      ev.preventDefault();
      return k.toggleSidebar();
    }
    if (mod(ev) && ev.key === "," && k.openSettings) {
      ev.preventDefault();
      return k.openSettings();
    }
    if (mod(ev) && ev.key === "/") {
      ev.preventDefault();
      help.hidden = !help.hidden;
      return;
    }
    if (mod(ev) && key === "k") {
      ev.preventDefault();
      return k.focusSearch();
    }
    if (mod(ev) && ev.key === "Enter" && timeline.pendingApproval) {
      ev.preventDefault();
      return k.decide(timeline.pendingApproval, "approved");
    }
    if (mod(ev) && ev.shiftKey && ev.key === "Backspace" && timeline.pendingApproval) {
      ev.preventDefault();
      return k.decide(timeline.pendingApproval, "denied");
    }
    if (ev.altKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
      ev.preventDefault();
      return k.step(ev.key === "ArrowDown" ? 1 : -1);
    }
    if (typing()) return;
    if (ev.key === "/") {
      ev.preventDefault();
      return k.focusInput();
    }
    if (ev.key === "?") {
      help.hidden = false;
      return;
    }
    const q = timeline.pendingQuestion;
    if (q && /^[1-9]$/.test(ev.key)) {
      const choice = q.choices[Number(ev.key) - 1];
      if (choice) k.answer(q.id, choice);
    }
  });
}
