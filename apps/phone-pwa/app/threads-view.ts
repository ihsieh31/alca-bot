// 對話 tab (§3.2): the conversations as a plain list, Messages-style — title,
// one status line when there is something to say, trailing time (or 「等你」 in orange). Swipe a row
// left for 封存 / 刪除, or press and hold it for the same choices. The list
// pages in as it scrolls (no 「載入更多」 button). Replaces the old drawer.
import { pendingOffers } from "./addons.ts";
import { h, haptic, icon } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import type { Session, ThreadSummary } from "./session.ts";
import { actionSheet } from "./sheet.ts";
import { emptyState, largeTitleScreen, switchEl, switchRow } from "./ui.ts";

/** 21:40 today, 昨天, a weekday this week, else 11/2 — never 「剛剛」 on every row. */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const lang = document.documentElement.lang || undefined;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (days === 1) return tx("phone.ui.yesterday");
  if (days < 7) return d.toLocaleDateString(lang, { weekday: "short" });
  return d.toLocaleDateString(lang, { month: "numeric", day: "numeric" });
}

/** A bot's avatar: a monochrome glyph on the neutral fill (no colour per bot, §2.3). */
export function avatar(glyph: string, size = 40): HTMLElement {
  const el = h("span", { class: "row-av", "aria-hidden": "true" }, (glyph || "A").slice(0, 2));
  el.dataset.size = String(size);
  return el;
}

export function threadsScreen(s: Session, o: { open(id: string): void; compose(): void }): HTMLElement {
  const list = h("div", { class: "thread-list", role: "list", "aria-label": tx("common.chatList") });
  const note = h("p", { class: "inline-error", role: "alert", hidden: true });
  const sentinel = h("div", { class: "list-sentinel", "aria-hidden": "true" });
  const offers = pendingOffers(s, (id) => o.open(id));
  let swiped: HTMLElement | null = null;

  const fail = (e: unknown) => {
    note.textContent = tx("phone.drawer.notFinished", { message: String((e as Error)?.message ?? e) });
    note.hidden = false;
  };
  const remove = (id: string, how: "archive" | "delete", opts: { memories: boolean; backups: boolean }) =>
    s.removeThread(id, how, how === "delete" ? opts : {});

  const askDelete = (th: ThreadSummary) => {
    const opts = { memories: false, backups: true };
    const extra = h(
      "div",
      { class: "cells as-cells" },
      switchRow({
        title: tx("common.includeMemoriesLearnedFromThis"),
        sw: switchEl(false, tx("common.includeMemoriesLearnedFromThis"), (on) => (opts.memories = on)),
      }),
      switchRow({
        title: tx("phone.ui.alsoFromBackups"),
        sw: switchEl(true, tx("phone.ui.alsoFromBackups"), (on) => (opts.backups = on)),
      }),
    );
    actionSheet({
      label: tx("phone.ui.deleteChat"),
      title: tx("phone.ui.deleteChatTitle", { title: th.title || tx("common.chat") }),
      message: tx("phone.drawer.theAuditLogIsKept"),
      extra,
      actions: [{ label: tx("common.delete"), tone: "danger", run: () => remove(th.id, "delete", opts) }],
    });
  };

  const actions = (th: ThreadSummary) => {
    haptic("tap");
    actionSheet({
      label: tx("phone.drawer.sActions", { p0: th.title || tx("common.chat") }),
      title: th.title || tx("common.chat"),
      actions: [
        {
          label: tx("common.archive"),
          run: () => remove(th.id, "archive", { memories: false, backups: true }),
        },
        ...(s.can("approve")
          ? [{ label: tx("common.delete"), tone: "danger" as const, run: () => void askDelete(th) }]
          : []),
      ],
    });
  };

  const status = (th: ThreadSummary): [string, "waiting" | undefined] | null => {
    if (th.waiting) return [tx("phone.ui.needsYouLine"), "waiting"];
    if (th.busy) return [tx("phone.ui.working"), undefined];
    if (th.workers) return [tx("phone.ui.tasksCount", { n: th.workers }), undefined];
    // Another teammate's conversation says whose it is; the lead's needs no name.
    const bot = th.botId ? s.botOf(th.botId) : undefined;
    return bot && !bot.isDefault ? [bot.name, undefined] : null;
  };

  const rowFor = (th: ThreadSummary) => {
    const st = status(th);
    const main = h(
      "button",
      {
        class: "thread-row",
        type: "button",
        "data-id": th.id,
        "aria-current": th.id === s.threadId ? "true" : undefined,
        onclick: () => {
          if (wrap.dataset.swiped === "true") return close(wrap);
          haptic("tap");
          o.open(th.id);
        },
      },
      h(
        "span",
        { class: "tr-text" },
        h(
          "span",
          { class: "tr-top" },
          h("span", { class: "tr-title" }, th.title || tx("common.chat")),
          th.waiting
            ? h("span", { class: "tr-time", "data-tone": "waiting" }, tx("phone.ui.waitingShort"))
            : h("span", { class: "tr-time" }, shortTime(th.updatedAt)),
        ),
        st
          ? h(
              "span",
              { class: "tr-sub", "data-tone": st[1] },
              th.busy && !th.waiting ? h("i", { class: "spin" }) : null,
              st[0],
            )
          : null,
      ),
    );
    const acts = h(
      "div",
      { class: "tr-actions", "aria-hidden": "true" },
      h(
        "button",
        {
          class: "tr-act",
          type: "button",
          tabindex: "-1",
          onclick: () => void remove(th.id, "archive", { memories: false, backups: true }).catch(fail),
        },
        icon("archive", 22),
        tx("common.archive"),
      ),
      s.can("approve")
        ? h(
            "button",
            {
              class: "tr-act",
              "data-tone": "danger",
              type: "button",
              tabindex: "-1",
              onclick: () => askDelete(th),
            },
            icon("trash", 22),
            tx("common.delete"),
          )
        : null,
    );
    // Archive / delete sit under the row for swipe and long-press only; VoiceOver gets them
    // as a quiet second button after the row (not drawn), which opens the same action sheet.
    const more = h(
      "button",
      {
        class: "sr-only",
        type: "button",
        onclick: () => actions(th),
      },
      tx("phone.drawer.sActions", { p0: th.title || tx("common.chat") }),
    );
    // The row keeps its button semantics; the list item is the wrapper (review #11).
    const wrap = h("div", { class: "tr-wrap", role: "listitem" }, acts, main, ...(th.busy ? [] : [more]));
    if (!th.busy) swipe(wrap, main, () => actions(th));
    return wrap;
  };

  const close = (w: HTMLElement | null) => {
    if (!w) return;
    w.dataset.swiped = "false";
    (w.querySelector(".thread-row") as HTMLElement).style.transform = "";
    if (swiped === w) swiped = null;
  };

  /** Drag left to show the actions; hold for the action sheet. */
  const swipe = (wrap: HTMLElement, main: HTMLElement, hold: () => void) => {
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let base = 0;
    let dragging = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const width = () => (wrap.firstElementChild as HTMLElement).offsetWidth;
    main.addEventListener("pointerdown", (e) => {
      x0 = e.clientX;
      y0 = e.clientY;
      dx = 0;
      dragging = false;
      base = wrap.dataset.swiped === "true" ? -width() : 0;
      if (swiped && swiped !== wrap) close(swiped);
      timer = setTimeout(() => {
        timer = undefined;
        if (!dragging) {
          main.dataset.held = "true";
          hold();
        }
      }, 520);
    });
    main.addEventListener("pointermove", (e) => {
      const mx = e.clientX - x0;
      if (!dragging && Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(e.clientY - y0)) {
        dragging = true;
        clearTimeout(timer);
        main.setPointerCapture(e.pointerId);
        main.dataset.dragging = "true";
      }
      if (Math.abs(e.clientY - y0) > 10) clearTimeout(timer);
      if (!dragging) return;
      dx = Math.min(0, Math.max(-width() - 40, base + mx));
      main.style.transform = `translateX(${dx}px)`;
    });
    const end = () => {
      clearTimeout(timer);
      if (main.dataset.held === "true") {
        delete main.dataset.held;
        wrap.dataset.swiped = "true"; // swallow the click that follows a hold
        setTimeout(() => (wrap.dataset.swiped = "false"), 0);
        return;
      }
      if (!dragging) return;
      delete main.dataset.dragging;
      const open = dx < -width() / 2;
      wrap.dataset.swiped = String(open);
      main.style.transform = open ? `translateX(${-width()}px)` : "";
      if (open) swiped = wrap;
      setTimeout(() => (dragging = false), 0);
    };
    main.addEventListener("pointerup", end);
    main.addEventListener("pointercancel", end);
    main.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      clearTimeout(timer);
      hold();
    });
  };

  const paint = () => {
    swiped = null;
    list.replaceChildren(...s.threads.map(rowFor));
    empty.hidden = s.threads.length > 0;
    sentinel.hidden = !s.threadsMore;
  };
  const empty = emptyState(tx("common.noChatsYet"), tx("phone.ui.noChatsText"), {
    label: tx("common.newChat"),
    run: () => o.compose(),
  });
  const compose = h(
    "button",
    {
      class: "icon-btn",
      type: "button",
      "aria-label": tx("common.newChat"),
      onclick: () => {
        haptic("tap");
        o.compose();
      },
    },
    icon("compose", 24),
  );
  const screen = largeTitleScreen({
    title: tx("phone.ui.tabChats"),
    trailing: [compose],
    content: h("div", { class: "threads-body" }, offers, note, list, empty, sentinel),
    className: "threads-screen",
  });
  screen.el.dataset.plain = "true";
  // Infinite scroll: the next page loads as the end comes into view.
  let loading = false;
  new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting) || loading || !s.threadsMore) return;
      loading = true;
      void s
        .loadMoreThreads()
        .catch(() => undefined)
        .finally(() => (loading = false));
    },
    { root: screen.scroller, rootMargin: "200px" },
  ).observe(sentinel);
  s.subscribe((w) => {
    if (w === "threads" || w === "thread" || w === "scopes" || w === "team") paint();
  });
  screen.el.addEventListener("tabshow", () => void s.refreshThreads().catch(() => undefined));
  paint();
  return screen.el;
}
