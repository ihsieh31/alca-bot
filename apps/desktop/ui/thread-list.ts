// The sidebar's conversation list (P13 A6): pages of 50 (載入更多), archive /
// bring back, delete behind a confirm dialog, and the archived list behind a
// toggle at the bottom. Search filters the conversations already loaded.
import type { Api, Thread } from "./api.ts";
import { exportForm } from "./data-transfer.ts";
import { dayGroup, h, relativeTime } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { type IconName, icon, spinner } from "./icons.ts";

const PAGE = 50;

export interface ThreadListOptions {
  api: Api;
  el: HTMLElement;
  search: HTMLInputElement;
  current: () => string | null;
  open: (id: string) => void;
  /** A conversation left the list (archived or deleted). */
  removed: (id: string) => void;
  toast: (err: unknown) => void;
}

const cursor = (t: Thread) => `${t.updatedAt}~${t.id}`;

export class ThreadList {
  /** Loaded conversations, newest activity first (the app updates busy / waiting in place). */
  items: Thread[] = [];
  private more = false;
  private archived = false;
  private readonly o: ThreadListOptions;
  private readonly dialog: HTMLDialogElement;

  constructor(o: ThreadListOptions) {
    this.o = o;
    this.dialog = h("dialog", { class: "undo-dialog", "aria-labelledby": "thread-del-title" });
    document.body.append(this.dialog);
    o.search.addEventListener("input", () => this.render());
  }

  private page(before?: Thread, limit = PAGE) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set("before", cursor(before));
    if (this.archived) q.set("archived", "1");
    return this.o.api.call<Thread[]>("GET", `/api/threads?${q}`);
  }

  /** Reload what is shown (at least one page, as many as were loaded). */
  async refresh(): Promise<void> {
    const want = Math.min(Math.max(PAGE, this.items.length), 200);
    const got = await this.page(undefined, want);
    this.items = got;
    this.more = got.length === want;
    this.render();
  }

  async loadMore(): Promise<void> {
    const last = this.items.at(-1);
    if (!last) return this.refresh();
    const got = await this.page(last);
    const seen = new Set(this.items.map((t) => t.id));
    this.items.push(...got.filter((t) => !seen.has(t.id)));
    this.more = got.length === PAGE;
    this.render();
  }

  private async setArchived(t: Thread, archived: boolean): Promise<void> {
    try {
      await this.o.api.call("POST", `/api/threads/${encodeURIComponent(t.id)}/archive`, { archived });
      this.items = this.items.filter((x) => x.id !== t.id);
      this.render();
      this.o.removed(t.id);
    } catch (e) {
      this.o.toast(e);
    }
  }

  /** R5.4: content for good; 連同記憶 off and 也從備份裡清除 on unless the person changes them. */
  private confirmDelete(t: Thread): void {
    const err = h("p", { class: "undo-error", role: "alert", hidden: true });
    const memories = h("input", { type: "checkbox", "data-field": "delete-memories" });
    const backups = h("input", { type: "checkbox", "data-field": "delete-backups", checked: true });
    const check = (box: HTMLInputElement, title: string, help: string) =>
      h("label", { class: "st-check st-line" }, box, h("span", {}, h("b", {}, title), h("small", {}, help)));
    const go = h("button", { class: "btn btn-danger", type: "button" }, tx("common.delete"));
    go.addEventListener("click", async () => {
      go.setAttribute("disabled", "");
      const q = new URLSearchParams({
        memories: memories.checked ? "1" : "0",
        backups: backups.checked ? "1" : "0",
      });
      try {
        await this.o.api.call("DELETE", `/api/threads/${encodeURIComponent(t.id)}?${q}`);
        this.dialog.close();
        this.items = this.items.filter((x) => x.id !== t.id);
        this.render();
        this.o.removed(t.id);
      } catch (e) {
        go.removeAttribute("disabled");
        err.textContent = tx("desktop.threadList.notDeleted", {
          message: String((e as Error)?.message ?? e),
        });
        err.hidden = false;
      }
    });
    this.dialog.replaceChildren(
      h(
        "h2",
        { class: "undo-title", id: "thread-del-title" },
        tx("desktop.threadList.delete", { title: t.title ?? tx("common.newChat") }),
      ),
      h("p", { class: "undo-lead" }, tx("desktop.threadList.theChatsMessagesDraftsRun")),
      check(
        memories,
        tx("common.includeMemoriesLearnedFromThis"),
        tx("desktop.threadList.untickedMemoriesAreKeptTheyre"),
      ),
      check(
        backups,
        tx("desktop.threadList.alsoRemoveFromBackups"),
        tx("desktop.threadList.untickedDailyBackupsMayKeep"),
      ),
      h("p", { class: "lc-help" }, tx("desktop.threadList.whatCantBeDeletedThe")),
      err,
      h(
        "div",
        { class: "undo-actions" },
        h(
          "button",
          { class: "btn btn-quiet", type: "button", onclick: () => this.dialog.close() },
          tx("common.cancel"),
        ),
        go,
      ),
    );
    this.dialog.showModal();
  }

  private exportDialog(t: Thread): void {
    const msg = h("p", { class: "lc-msg", role: "status", hidden: true });
    const done = (m: { text: string; tone: "ok" | "bad" }) => {
      msg.textContent = m.text;
      msg.setAttribute("data-tone", m.tone);
      msg.hidden = false;
    };
    this.dialog.replaceChildren(
      h(
        "h2",
        { class: "undo-title", id: "thread-del-title" },
        tx("desktop.threadList.export", { title: t.title ?? tx("common.newChat") }),
      ),
      exportForm(this.o.api, () => t.id, done),
      msg,
      h(
        "div",
        { class: "undo-actions" },
        h(
          "button",
          { class: "btn btn-quiet", type: "button", onclick: () => this.dialog.close() },
          tx("common.close"),
        ),
      ),
    );
    this.dialog.showModal();
  }

  render(): void {
    const { el, search } = this.o;
    const q = search.value.trim().toLowerCase();
    const shown = this.items.filter((t) => !q || (t.title ?? "").toLowerCase().includes(q));
    el.replaceChildren();
    if (this.archived) el.append(h("div", { class: "thread-group" }, tx("common.archived")));
    if (shown.length === 0)
      el.append(
        h(
          "div",
          { class: "thread-empty" },
          q
            ? tx("desktop.threadList.noMatchingChats")
            : this.archived
              ? tx("desktop.threadList.noArchivedChats")
              : tx("desktop.threadList.noChatsYetPressJ"),
        ),
      );
    let group = "";
    for (const t of shown) {
      const g = dayGroup(t.updatedAt);
      if (!this.archived && g !== group) {
        group = g;
        el.append(h("div", { class: "thread-group" }, g));
      }
      el.append(this.row(t));
    }
    if (this.more)
      el.append(
        h(
          "button",
          {
            class: "thread-more",
            type: "button",
            onclick: () => void this.loadMore().catch(this.o.toast),
          },
          q ? tx("desktop.threadList.loadMoreSearchOnlyCovers") : tx("common.loadMore"),
        ),
      );
    el.append(
      h(
        "button",
        {
          class: "thread-more thread-archived-toggle",
          type: "button",
          onclick: () => {
            this.archived = !this.archived;
            this.items = [];
            void this.refresh().catch(this.o.toast);
          },
        },
        this.archived ? tx("desktop.threadList.backToChats") : tx("desktop.threadList.archivedChats"),
      ),
    );
  }

  private row(t: Thread): HTMLElement {
    const state = t.waiting ? "waiting" : t.busy ? "busy" : undefined;
    const name = t.title ?? tx("common.newChat");
    const act = (label: string, ic: IconName, fn: () => void) =>
      h(
        "button",
        {
          class: "thread-act",
          type: "button",
          title: label,
          "aria-label": tx("desktop.threadList.text", { label, name }),
          onclick: (ev: Event) => {
            ev.stopPropagation();
            fn();
          },
        },
        icon(ic),
      );
    // §3.2: title only; the time is a tooltip, the state a trailing glyph (no dots).
    return h(
      "div",
      { class: "thread-row" },
      h(
        "button",
        {
          class: "thread-item",
          type: "button",
          title: `${name} — ${relativeTime(t.updatedAt)}`,
          "aria-current": t.id === this.o.current() ? "true" : "false",
          onclick: () => this.o.open(t.id),
        },
        h("span", { class: "thread-name" }, name),
        state
          ? h(
              "span",
              {
                class: "thread-state",
                "data-state": state,
                title: state === "waiting" ? tx("common.waitingOnYou") : tx("desktop.threadList.running"),
              },
              state === "waiting" ? icon("hand") : spinner(),
            )
          : null,
      ),
      state
        ? null
        : h(
            "span",
            { class: "thread-acts" },
            this.archived
              ? act(tx("desktop.threadList.moveBackToChats"), "retry", () => void this.setArchived(t, false))
              : act(tx("common.archive"), "archive", () => void this.setArchived(t, true)),
            act(tx("common.export"), "export", () => this.exportDialog(t)),
            act(tx("common.delete"), "trash", () => this.confirmDelete(t)),
          ),
    );
  }
}
