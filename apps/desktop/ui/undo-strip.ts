// 復原 (P13): a strip above the composer naming the newest turn of this
// conversation that changed files, with 復原 behind a confirm dialog. The
// list comes from GET /api/undo/:thread; POST /api/undo/:thread/:turn puts
// that turn's files back (409 with the reason when it cannot, e.g. a later
// turn changed the same files, the backup was pruned, or the turn still runs).
import type { Api } from "./api.ts";
import { ago, h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { icon as plainIcon } from "./icons.ts";

export interface EditedTurnView {
  turnRunId: string;
  threadId: string;
  botId: string;
  files: number;
  skipped: number;
  undone: boolean;
  pruned: boolean;
  canUndo: boolean;
  firstAt: string;
  lastAt: string;
  paths: Array<{ path: string; created: boolean; skipped?: string; tool?: string; shell?: boolean }>;
}

interface UndoDone {
  ok: true;
  restored: string[];
  removed: string[];
  skipped: string[];
}

type Client = Pick<Api, "call">;

/** The turn the strip offers: the newest one that changed files, if it can still be undone. */
export function newestUndoable(turns: readonly EditedTurnView[]): EditedTurnView | undefined {
  const t = turns[0];
  return t?.canUndo ? t : undefined;
}

/** What the strip says after a successful undo. */
export function undoneText(r: UndoDone): string {
  const n = r.restored.length + r.removed.length;
  const skipped = r.skipped.length
    ? tx("desktop.undoStrip.hadNoBackupAndWere", { skippedCount: r.skipped.length })
    : "";
  return tx("desktop.undoStrip.restoredFiles", { n, skipped });
}

export class UndoStrip {
  readonly el: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private thread: string | null = null;
  private turn: EditedTurnView | undefined;
  private busy = false;
  private note: { text: string; tone: "ok" | "danger" } | undefined;
  private seq = 0;

  private readonly api: Client;

  constructor(api: Client) {
    this.api = api;
    this.el = h("div", { class: "undo-strip", role: "status", "aria-live": "polite", hidden: true });
    this.dialog = h("dialog", { class: "undo-dialog", "aria-labelledby": "undo-title" });
    document.body.append(this.dialog);
  }

  /** A conversation was opened (or none is). */
  setThread(id: string | null): void {
    this.thread = id;
    this.turn = undefined;
    this.note = undefined;
    this.render();
    void this.refresh();
  }

  /** The conversation's run started / finished: undo waits until it is done. */
  setBusy(busy: boolean): void {
    const was = this.busy;
    this.busy = busy;
    if (was && !busy) void this.refresh();
    else this.render();
  }

  async refresh(): Promise<void> {
    const id = this.thread;
    const mine = ++this.seq;
    if (!id) return this.render();
    try {
      const turns = await this.api.call<EditedTurnView[]>("GET", `/api/undo/${encodeURIComponent(id)}`);
      if (mine !== this.seq || id !== this.thread) return;
      this.turn = newestUndoable(Array.isArray(turns) ? turns : []);
    } catch {
      // No undo here (no folder tools, an older desktop): show nothing rather than an error.
      if (mine !== this.seq) return;
      this.turn = undefined;
    }
    this.render();
  }

  private render(): void {
    const t = this.turn;
    const note = this.note;
    if (!t && !note) {
      this.el.hidden = true;
      this.el.replaceChildren();
      return;
    }
    this.el.hidden = false;
    this.el.dataset.tone = note?.tone ?? "";
    const parts: Array<Node | null> = [
      h("span", { class: "undo-dot", "aria-hidden": "true" }),
      h(
        "span",
        { class: "undo-text" },
        note && !t
          ? note.text
          : t
            ? tx("desktop.undoStrip.theLastRoundChangedFiles", {
                p0: note ? tx("desktop.undoStrip.text", { text: note.text }) : "",
                files: t.files,
                lastAt: ago(t.lastAt),
              })
            : "",
      ),
      t
        ? h(
            "button",
            {
              class: "btn btn-quiet undo-btn",
              type: "button",
              ...(this.busy
                ? { disabled: true, title: tx("desktop.undoStrip.thisRoundIsStillRunning") }
                : {}),
              onclick: () => this.confirm(t),
            },
            tx("desktop.undoStrip.undo"),
          )
        : null,
      note
        ? h(
            "button",
            {
              class: "icon-btn undo-close",
              type: "button",
              "aria-label": tx("desktop.undoStrip.dismiss"),
              onclick: () => {
                this.note = undefined;
                this.render();
              },
            },
            plainIcon("cross"),
          )
        : null,
    ];
    this.el.replaceChildren(...parts.filter((x): x is Node => x !== null));
  }

  private confirm(t: EditedTurnView): void {
    const err = h("p", { class: "undo-error", role: "alert", hidden: true });
    const go = h(
      "button",
      { class: "btn btn-primary", type: "button" },
      tx("desktop.undoStrip.undoTheseFiles"),
    );
    const cancel = h(
      "button",
      { class: "btn btn-quiet", type: "button", onclick: () => this.dialog.close() },
      tx("common.cancel"),
    );
    go.addEventListener("click", async () => {
      go.setAttribute("disabled", "");
      err.hidden = true;
      try {
        const r = await this.api.call<UndoDone>(
          "POST",
          `/api/undo/${encodeURIComponent(t.threadId)}/${encodeURIComponent(t.turnRunId)}`,
        );
        this.dialog.close();
        this.note = { text: undoneText(r), tone: "ok" };
        await this.refresh();
      } catch (e) {
        go.removeAttribute("disabled");
        err.textContent = tx("desktop.undoStrip.notUndone", { message: String((e as Error)?.message ?? e) });
        err.hidden = false;
        this.note = { text: tx("desktop.undoStrip.theLastUndoDidntSucceed"), tone: "danger" };
        void this.refresh();
      }
    });
    const shown = t.paths.slice(0, 12);
    this.dialog.replaceChildren(
      h("h2", { class: "undo-title", id: "undo-title" }, tx("desktop.undoStrip.undoTheLastRoundsFile")),
      h("p", { class: "undo-lead" }, tx("desktop.undoStrip.theseFilesGoBackTo")),
      t.paths.some((p) => p.shell)
        ? h("p", { class: "undo-lead", "data-tone": "warn" }, tx("desktop.undoStrip.someFilesWereChangedBy"))
        : "",
      h(
        "ul",
        { class: "undo-files" },
        ...shown.map((p) =>
          h(
            "li",
            {},
            h("code", {}, p.path),
            p.created ? h("span", { class: "undo-tag" }, tx("desktop.undoStrip.newFileWillBeDeleted")) : null,
            p.skipped
              ? h(
                  "span",
                  { class: "undo-tag", "data-tone": "warn" },
                  tx("desktop.undoStrip.noBackup", { skipped: p.skipped }),
                )
              : null,
          ),
        ),
        t.paths.length > shown.length
          ? h(
              "li",
              { class: "undo-more" },
              tx("desktop.undoStrip.more", { p0: t.paths.length - shown.length }),
            )
          : null,
      ),
      err,
      h("div", { class: "undo-actions" }, cancel, go),
    );
    this.dialog.showModal();
    go.focus();
  }
}
