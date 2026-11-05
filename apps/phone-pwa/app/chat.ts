// The conversation screen (§3.1, §3.3): pushed over the tabs. Nav bar with
// back, the thread's name (and the connection only when it is not healthy),
// the transcript, and the capsule composer. A waiting approval is a compact
// 「需要你」 row at the end of the transcript; a decided one stays as a receipt.

import { approvalView } from "./approval-view.ts";
import { activityGroup, assistantBody, receiptRow, reportRow, shownTool } from "./chat-items.ts";
import { parseAppAction } from "./connect-view.ts";
import { h, haptic, icon } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { confirmClasses } from "./learn-view.ts";
import { addresseeChip, MentionBox } from "./mention.ts";
import { fillQueued, queuedSig, staleLine } from "./outbox-view.ts";
import { ReconnectBanner } from "./reconnect.ts";
import type { Session } from "./session.ts";
import { actionSheet } from "./sheet.ts";
import type { Item } from "./timeline.ts";
import { toast as showToast } from "./toast.ts";
import { onViewport } from "./viewport.ts";

export interface ChatActions {
  /** Back to the 對話 list. */
  back(): void;
  openWorkers(workerId?: string): void;
  openBrowser(): void;
  openCards(): void;
  openProposal(skillId: string): void;
  /** A bot-to-bot request or report row (P7). */
  openPeer(requestId: string): void;
}

// [icon, what the row says, the message it sends]
const SUGGESTIONS: Array<[string, string, string]> = [
  ["card", tx("phone.chat.demoStoreCheckout"), tx("common.checkOutAtTheDemo")],
  ["activity", tx("phone.chat.twoThingsAtOnce"), tx("common.doTwoThingsForMe")],
  ["doc", tx("phone.chat.aLongerAnswer"), tx("phone.chat.giveMeASomewhatLonger")],
];

const CONN_TEXT: Record<string, string> = {
  connecting: tx("phone.chat.connecting"),
  offline: tx("phone.chat.macOffline"),
  revoked: tx("common.thisPhoneHasBeenRevoked"),
  idle: tx("common.notConnectedYet"),
};

type Node1 = { el: HTMLElement; sig: string };

export class ChatView {
  readonly el: HTMLElement;
  private readonly s: Session;
  private readonly act: ChatActions;
  private readonly list: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly rc: ReconnectBanner;
  private readonly workersBtn: HTMLButtonElement;
  private readonly workersBadge: HTMLElement;
  private readonly browserBtn: HTMLButtonElement;
  private readonly pending: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly learned: HTMLElement;
  private readonly mention: MentionBox;
  private readonly chipSlot: HTMLElement;
  private nodes = new Map<string, Node1>();
  private openGroups = new Set<string>();
  private stick = true;
  /** P13: reading the phone's saved copy while offline. */
  private readonly staleNote = h("p", { class: "chat-note", role: "status", hidden: true });
  private readonly queueActs = {
    retry: (key: string) => void this.s.offline.retry(key),
    remove: (key: string) => void this.s.offline.remove(key),
    current: (key: string) => this.s.offline.queued().find((x) => x.key === key),
  };

  constructor(s: Session, act: ChatActions) {
    this.s = s;
    this.act = act;
    this.title = h("h1", { class: "nav-title chat-title" }, tx("common.newChat"));
    this.sub = h("p", { class: "chat-sub", hidden: true });
    this.workersBadge = h("span", { class: "count nav-count", hidden: true });
    this.workersBtn = h(
      "button",
      {
        class: "icon-btn",
        type: "button",
        "aria-label": tx("phone.ui.tasks"),
        hidden: true,
        onclick: () => act.openWorkers(),
      },
      icon("activity", 24),
      this.workersBadge,
    );
    this.browserBtn = h(
      "button",
      {
        class: "icon-btn",
        type: "button",
        "aria-label": tx("phone.chat.browserView"),
        hidden: true,
        onclick: () => act.openBrowser(),
      },
      icon("globe", 24),
    );
    this.bar = h(
      "header",
      { class: "nav-bar chat-bar" },
      h(
        "div",
        { class: "nav-lead" },
        h(
          "button",
          {
            class: "nav-back",
            type: "button",
            "aria-label": tx("phone.ui.backToChats"),
            onclick: () => act.back(),
          },
          icon("back", 24),
          h("span", { class: "nav-back-label" }, tx("phone.ui.tabChats")),
        ),
      ),
      h("div", { class: "chat-head" }, this.title, this.sub),
      h("div", { class: "nav-trail" }, this.browserBtn, this.workersBtn),
    );
    this.rc = new ReconnectBanner(s);
    this.list = h("div", { class: "thread", role: "log", "aria-live": "polite" });
    this.empty = this.emptyState();
    this.learned = h("div", { class: "learned", hidden: true });
    this.pending = h("div", { class: "pending-slot" });
    this.scroller = h(
      "main",
      { class: "scroller" },
      this.staleNote,
      this.empty,
      this.list,
      this.learned,
      this.pending,
    );
    this.scroller.addEventListener(
      "scroll",
      () => {
        const sc = this.scroller;
        this.stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
        const under = sc.scrollTop > 2;
        if ((this.bar.dataset.under === "true") !== under) this.bar.dataset.under = String(under);
      },
      { passive: true },
    );
    this.input = h("textarea", {
      class: "composer-input",
      rows: 1,
      placeholder: tx("phone.chat.messageAlca"),
      "aria-label": tx("phone.chat.message"),
      // No enterkeyhint="send": on iPhone Return inserts a newline (only a hardware keyboard's
      // Enter sends, see keydown), so the key must not be labelled 傳送.
      autocomplete: "off",
    });
    this.sendBtn = h(
      "button",
      { class: "send-btn", type: "button", "aria-label": tx("phone.chat.send"), disabled: true },
      icon("send", 20),
    );
    this.input.addEventListener("input", () => this.autosize());
    this.input.addEventListener("keydown", (e) => {
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.isComposing &&
        !this.mention.open &&
        matchMedia("(hover: hover)").matches
      ) {
        e.preventDefault();
        void this.submit();
      }
    });
    this.sendBtn.addEventListener("click", () => void this.submit());
    this.mention = new MentionBox(s, this.input, () => this.autosize());
    this.chipSlot = h("div", { class: "to-slot" });
    const dock = h(
      "footer",
      { class: "dock" },
      this.mention.el,
      this.chipSlot,
      h("div", { class: "composer" }, this.input, this.sendBtn),
    );
    this.el = h(
      "section",
      { class: "screen chat", "aria-label": tx("common.chat") },
      this.bar,
      this.rc.el,
      this.scroller,
      dock,
    );
    // The keyboard opening shrinks the app (viewport.ts): keep the newest line in view.
    onViewport((v) => v.kb > 0 && this.stick && this.scrollEnd());
    s.subscribe((what) => this.update(what));
    this.update("conn");
    this.update("thread");
  }

  focusComposer(): void {
    this.input.focus();
  }

  /** A short note at the bottom of the screen (P8: what a tapped notification led to). */
  toast(msg: string): void {
    showToast(msg);
  }

  /** A tappable notice under the nav bar: another conversation has a card waiting (P8). */
  banner(text: string, onTap: () => void): void {
    this.el.querySelector(".notify-banner")?.remove();
    const b = h(
      "button",
      {
        class: "notify-banner",
        type: "button",
        onclick: () => {
          b.remove();
          onTap();
        },
      },
      icon("hand", 18),
      h("span", {}, text),
      h("b", {}, tx("common.view")),
    );
    this.rc.el.after(b);
    setTimeout(() => b.remove(), 12_000);
  }

  private emptyState(): HTMLElement {
    return h(
      "div",
      { class: "empty" },
      h("p", { class: "empty-line" }, tx("phone.chat.whatToHandOff")),
      h(
        "div",
        { class: "cells suggestions" },
        ...SUGGESTIONS.map(([ic, title, text]) =>
          h(
            "button",
            {
              class: "row suggestion",
              type: "button",
              onclick: () => {
                this.input.value = text;
                this.autosize();
                void this.submit();
              },
            },
            h("span", { class: "row-icon bare", "aria-hidden": "true" }, icon(ic, 22)),
            h("span", { class: "row-text" }, h("span", { class: "row-title" }, title)),
          ),
        ),
      ),
    );
  }

  private autosize() {
    const t = this.input;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 132)}px`;
    this.el.dataset.multiline = String(t.scrollHeight > 44);
    this.paintSend();
  }

  private paintSend() {
    const busy = !!this.s.timeline.busyRunId;
    const has = this.input.value.trim().length > 0;
    const mode = has ? "send" : busy ? "stop" : "idle";
    if (this.sendBtn.dataset.mode !== mode) {
      this.sendBtn.dataset.mode = mode;
      this.sendBtn.replaceChildren(icon(mode === "stop" ? "stop" : "send", 20));
    }
    this.sendBtn.setAttribute("aria-label", mode === "stop" ? tx("common.stop") : tx("phone.chat.send"));
    // P13: offline, a message is queued (sent once the computer is back); stopping needs the connection.
    this.sendBtn.disabled = !(has || busy) || (!has && this.s.conn !== "online");
  }

  private async submit() {
    const text = this.input.value.trim();
    if (!text) {
      if (this.s.timeline.busyRunId) {
        haptic("tap");
        await this.s.interrupt().catch(() => undefined);
      }
      return;
    }
    if (this.s.timeline.busyRunId && this.s.conn === "online") return;
    haptic("tap");
    this.input.value = "";
    this.autosize();
    this.stick = true;
    try {
      await this.s.send(text);
    } catch (e) {
      this.input.value = text;
      this.autosize();
      showToast(e instanceof Error ? e.message : tx("common.notSent"));
    }
  }

  private update(what: string) {
    const s = this.s;
    if (what === "conn") {
      this.rc.update();
      const bad = s.conn !== "online";
      this.sub.hidden = !bad;
      this.sub.textContent = bad ? (CONN_TEXT[s.conn] ?? "") : "";
      this.sub.dataset.state = s.conn;
      this.paintSend();
    }
    if (what === "thread" || what === "threads" || what === "busy") {
      const t = s.threads.find((x) => x.id === s.threadId);
      this.title.textContent = t?.title || (s.threadId ? tx("common.chat") : tx("common.newChat"));
      this.renderItems();
      this.paintSend();
    }
    if (what === "thread" || what === "cards") this.paintPending();
    if (what === "workers" || what === "thread") {
      const live = s.liveWorkers.length;
      this.workersBadge.hidden = live === 0;
      this.workersBadge.textContent = String(live);
      this.workersBadge.dataset.tone = s.workers.some((w) => w.status === "waiting") ? "waiting" : "";
      this.workersBtn.hidden = s.workers.length === 0;
      this.renderItems();
    }
    if (what === "skills" || what === "thread") this.paintLearned();
    if (what === "team" || what === "thread" || what === "threads") this.paintAddressee();
    if (what === "team" || what === "outbox" || what === "stale") this.renderItems();
    if (what === "spaces" || what === "scopes")
      this.browserBtn.hidden = !s.can("view_screen") || s.spaces.length === 0;
  }

  /** Who the next message goes to (P7): the chip and the placeholder. */
  private paintAddressee() {
    const chip = addresseeChip(this.s, () => {
      haptic("tap");
      this.s.pendingBot = null;
      this.paintAddressee();
    });
    this.chipSlot.replaceChildren(...(chip ? [chip] : []));
    const b = this.s.threadBot;
    this.input.placeholder =
      b && !b.isDefault ? tx("phone.chat.messageBot", { name: b.name }) : tx("phone.chat.messageAlca");
  }

  /** A proposal from this thread: a quiet row after the conversation (it never interrupts). */
  private paintLearned() {
    const ps = this.s.proposals.filter((p) => p.pending);
    this.learned.hidden = ps.length === 0;
    this.learned.replaceChildren(
      ...ps.map((p) => {
        const v = p.pending;
        const lock = !!v && confirmClasses(v).length > 0;
        return h(
          "button",
          { class: "inline-row", type: "button", onclick: () => this.act.openProposal(p.id) },
          h("span", { class: "act-icon", "aria-hidden": "true" }, icon(lock ? "lock" : "checkCircle", 18)),
          h(
            "span",
            { class: "act-label" },
            p.version > 0
              ? tx("phone.chat.canUpdateSkill", { name: v?.name ?? "" })
              : tx("phone.chat.learnedSkill", { name: v?.name ?? "" }),
          ),
          h("span", { class: "inline-cta" }, tx("common.view")),
          icon("chevron", 14),
        );
      }),
    );
    if (ps.length && this.stick) this.scrollEnd();
  }

  /** §3.5: the compact 「需要你：付款 NT$1,280 ›」 row (the sheet opens on its own the first time). */
  private paintPending() {
    const cards = this.s.cards;
    const first = cards[0];
    if (!first) {
      this.pending.replaceChildren();
      return;
    }
    const what =
      first.kind === "approval"
        ? approvalView(first, parseAppAction(first.summary, first.args)).title
        : first.prompt;
    this.pending.replaceChildren(
      h(
        "button",
        { class: "inline-row pending-row", type: "button", onclick: () => this.act.openCards() },
        h("span", { class: "act-icon", "aria-hidden": "true" }, icon("hand", 18)),
        h(
          "span",
          { class: "act-label" },
          cards.length > 1
            ? tx("phone.chat.needsYouMore", { what, n: cards.length - 1 })
            : tx("phone.chat.needsYou", { what }),
        ),
        icon("chevron", 14),
      ),
    );
    if (this.stick) this.scrollEnd();
  }

  private renderItems() {
    const items = this.s.timeline.items;
    this.bylines = this.nameTags(items);
    this.empty.hidden = items.length > 0 || !!this.s.threadId || this.s.offline.queued().length > 0;
    this.el.dataset.empty = String(!this.empty.hidden);
    const keep = new Set<string>();
    let prev: HTMLElement | null = null;
    const place = (id: string, sig: string, make: () => HTMLElement, fill?: (el: HTMLElement) => void) => {
      keep.add(id);
      let n = this.nodes.get(id);
      if (!n) {
        n = { el: make(), sig };
        n.el.dataset.enter = "true";
        this.nodes.set(id, n);
      } else if (n.sig !== sig) {
        if (fill) fill(n.el);
        else {
          const el = make();
          n.el.replaceWith(el);
          n.el = el;
        }
        n.sig = sig;
      }
      const at: ChildNode | null = prev ? prev.nextSibling : this.list.firstChild;
      if (at !== n.el) this.list.insertBefore(n.el, at);
      prev = n.el;
    };
    // A run of tool calls → one collapsed row (keyed by its first call).
    let run: Array<Item & { kind: "tool" }> = [];
    const flush = () => {
      if (!run.length) return;
      const tools = run;
      const key = `g:${tools[0]?.id}`;
      const open = this.openGroups.has(key);
      const sig = `${open}:${tools.map((x) => x.state).join(",")}`;
      const make = () =>
        activityGroup(tools, open, () => {
          haptic("tap");
          if (this.openGroups.has(key)) this.openGroups.delete(key);
          else this.openGroups.add(key);
          this.renderItems();
        });
      place(key, sig, make);
      run = [];
    };
    for (const it of items) {
      if (it.kind === "tool") {
        if (shownTool(it)) run.push(it);
        continue;
      }
      flush();
      place(
        it.id,
        this.sig(it),
        () => this.node(it),
        (el) => this.fill(el, it),
      );
    }
    flush();
    // P13: what waits in the outbox for this conversation, after what the computer has.
    for (const q of this.s.offline.queued()) {
      place(
        `q:${q.key}`,
        queuedSig(q),
        () => {
          const el = h("div", { class: "item user queued" });
          fillQueued(el, q, this.queueActs);
          return el;
        },
        (el) => fillQueued(el, q, this.queueActs),
      );
    }
    this.staleNote.hidden = !this.s.offline.stale;
    if (this.s.offline.stale) this.staleNote.textContent = staleLine(this.s.offline.savedAt);
    for (const [id, n] of this.nodes)
      if (!keep.has(id)) {
        n.el.remove();
        this.nodes.delete(id);
      }
    const busy = !!this.s.timeline.busyRunId;
    const last = items.at(-1);
    const lastIsStreaming = last?.kind === "assistant" && last.streaming;
    const lastIsTool = last?.kind === "tool";
    let thinking = this.list.querySelector<HTMLElement>(".thinking");
    if (busy && !lastIsStreaming && !lastIsTool && this.s.cards.length === 0) {
      thinking ??= h(
        "div",
        { class: "thinking", role: "status" },
        h("i", { class: "spin" }),
        h("span", {}, tx("phone.chat.alcaIsThinking")),
      );
      this.list.append(thinking);
    } else thinking?.remove();
    if (this.stick) this.scrollEnd();
  }

  private scrollEnd() {
    requestAnimationFrame(() => {
      this.scroller.scrollTop = this.scroller.scrollHeight;
    });
  }

  private sig(it: Item): string {
    if (it.kind === "assistant")
      return `${it.text.length}:${it.streaming}:${this.byline(it) ? 1 : 0}:${it.edited ? 1 : 0}:${it.text.slice(0, 16)}`;
    if (it.kind === "report") return `${it.status}:${it.title}`;
    return "";
  }

  private node(it: Item): HTMLElement {
    const el = h("div", { class: `item ${it.kind}` });
    this.fill(el, it);
    if (it.kind === "assistant" || it.kind === "user") this.holdToCopy(el, () => it.text);
    return el;
  }

  /** Press and hold a message: 拷貝 (§3.3). */
  private holdToCopy(el: HTMLElement, text: () => string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () =>
      actionSheet({
        label: tx("phone.chat.messageActions"),
        actions: [{ label: tx("phone.chat.copy"), run: () => navigator.clipboard?.writeText(text()) }],
      });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      open();
    });
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      timer = setTimeout(open, 550);
    });
    for (const ev of ["pointerup", "pointercancel", "pointermove"])
      el.addEventListener(ev, () => clearTimeout(timer), { passive: true });
  }

  private fill(el: HTMLElement, it: Item) {
    if (it.kind === "user") {
      el.replaceChildren(h("div", { class: "bubble" }, it.text));
    } else if (it.kind === "assistant") {
      el.dataset.streaming = String(it.streaming);
      el.replaceChildren(...assistantBody(it, this.byline(it)));
    } else if (it.kind === "receipt") {
      el.replaceChildren(receiptRow(it));
    } else if (it.kind === "report") {
      el.dataset.status = it.status;
      const wid = it.workerId;
      const pid = it.peerId;
      const open = wid ? () => this.act.openWorkers(wid) : pid ? () => this.act.openPeer(pid) : undefined;
      el.replaceChildren(reportRow(it, open));
    }
  }

  private bylines = new Set<string>();

  /** Messages-style name tags: only in a conversation where more than one bot
   *  speaks, and only on the first message of each bot's run (a 1:1 chat has none). */
  private nameTags(items: readonly Item[]): Set<string> {
    const def = this.s.team?.defaultBotId ?? "";
    const speakers = new Set<string>();
    for (const it of items) if (it.kind === "assistant") speakers.add(it.botId ?? def);
    const tags = new Set<string>();
    if (speakers.size < 2) return tags;
    let last: string | null = null;
    for (const it of items) {
      if (it.kind === "user") last = null;
      if (it.kind !== "assistant") continue;
      const who = it.botId ?? def;
      if (who !== last) tags.add(it.id);
      last = who;
    }
    return tags;
  }

  private byline(it: Item & { kind: "assistant" }) {
    return this.bylines.has(it.id) ? this.s.botOf(it.botId ?? this.s.team?.defaultBotId) : undefined;
  }
}
