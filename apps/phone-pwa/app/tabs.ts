// The phone's stable navigation (§2.1): a tab bar with 對話 / 進行中 / 資料庫 /
// 設定 and one root screen each; a conversation is pushed over them (and hides
// the tab bar), Library and Settings screens push as pages (sheet.ts). The
// orange count on 進行中 is the one global "waiting on you" mark.
import { h, haptic, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";
import type { Session } from "./session.ts";

export type TabId = "chats" | "activity" | "library" | "settings";

const TABS: Array<[TabId, string, string]> = [
  ["chats", "chats", t("phone.ui.tabChats")],
  ["activity", "activity", t("phone.ui.tabActivity")],
  ["library", "library", t("phone.ui.tabLibrary")],
  ["settings", "settings", t("phone.ui.tabSettings")],
];

/** How many things wait on the person: this thread's cards plus every other waiting thread. */
export function waitingCount(s: Session): number {
  const others = s.threads.filter((x) => x.waiting && x.id !== s.threadId).length;
  const here = s.cards.length || (s.threads.find((x) => x.id === s.threadId)?.waiting ? 1 : 0);
  return others + here;
}

export class Shell {
  readonly el: HTMLElement;
  private readonly screens = new Map<TabId, HTMLElement>();
  private readonly buttons = new Map<TabId, HTMLButtonElement>();
  private readonly badge = h("span", { class: "count", "data-tone": "waiting", hidden: true });
  private readonly chatLayer: HTMLElement;
  private readonly holder: HTMLElement;
  private readonly bar: HTMLElement;
  private current: TabId = "chats";
  private readonly s: Session;
  private readonly onChat: (open: boolean) => void;

  constructor(
    s: Session,
    o: { screens: Record<TabId, HTMLElement>; chat: HTMLElement; onChat(open: boolean): void },
  ) {
    this.s = s;
    this.onChat = o.onChat;
    document.documentElement.dataset.pages ??= "0";
    const holder = h("div", { class: "tab-screens" });
    for (const [id] of TABS) {
      const el = o.screens[id];
      el.dataset.tab = id;
      el.id = `tab-${id}`;
      el.setAttribute("role", "tabpanel");
      el.hidden = id !== this.current;
      this.screens.set(id, el);
      holder.append(el);
    }
    const bar = h("nav", { class: "tabbar", role: "tablist", "aria-label": t("phone.ui.tabs") });
    for (const [id, ic, label] of TABS) {
      const b = h(
        "button",
        {
          class: "tab",
          type: "button",
          role: "tab",
          "data-tab": id,
          "aria-controls": `tab-${id}`,
          "aria-selected": String(id === this.current),
          onclick: () => this.select(id, true),
        },
        icon(ic, 26, id === this.current),
        h("span", { class: "tab-label" }, label),
        id === "activity" ? this.badge : null,
      );
      this.buttons.set(id, b);
      bar.append(b);
    }
    this.chatLayer = h("div", { class: "chat-layer", "aria-hidden": "true" }, o.chat);
    this.chatLayer.inert = true;
    this.holder = holder;
    this.bar = bar;
    this.el = h("section", { class: "app-shell", "data-chat": "false" }, holder, bar, this.chatLayer);
    s.subscribe((w) => {
      if (w === "threads" || w === "cards" || w === "thread") this.paintBadge();
    });
    this.paintBadge();
  }

  get tab(): TabId {
    return this.current;
  }

  get chatOpen(): boolean {
    return this.el.dataset.chat === "true";
  }

  select(id: TabId, tapped = false): void {
    if (tapped) haptic("tap");
    if (this.chatOpen) this.closeChat();
    if (id === this.current) {
      // A second tap on the current tab scrolls its list back to the top (iOS).
      if (tapped)
        this.screens.get(id)?.querySelector(".root-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const was = this.current;
    this.current = id;
    for (const [k, el] of this.screens) el.hidden = k !== id;
    for (const [k, b] of this.buttons) {
      b.setAttribute("aria-selected", String(k === id));
      const ic = TABS.find((x) => x[0] === k)?.[1] ?? "";
      b.querySelector("svg")?.replaceWith(icon(ic, 26, k === id));
    }
    if (was !== id) this.screens.get(id)?.dispatchEvent(new CustomEvent("tabshow"));
  }

  openChat(): void {
    if (this.chatOpen) return;
    this.el.dataset.chat = "true";
    this.chatLayer.removeAttribute("aria-hidden");
    for (const el of this.screens.values()) el.setAttribute("aria-hidden", "true");
    this.setUnder(true);
    this.onChat(true);
  }

  closeChat(): void {
    if (!this.chatOpen) return;
    this.el.dataset.chat = "false";
    this.chatLayer.setAttribute("aria-hidden", "true");
    for (const el of this.screens.values()) el.removeAttribute("aria-hidden");
    this.setUnder(false);
    this.onChat(false);
  }

  /**
   * The conversation covers the tabs: the tab screens and the tab bar (still painted, slid
   * under the chat layer) are inert, so VoiceOver and the keyboard cannot reach them; the
   * chat layer is inert while closed. (Pages over everything: sheet.ts makes #app inert.)
   */
  private setUnder(chat: boolean) {
    this.holder.inert = chat;
    this.bar.inert = chat;
    this.chatLayer.inert = !chat;
  }

  private paintBadge() {
    const n = waitingCount(this.s);
    this.badge.hidden = n === 0;
    this.badge.textContent = String(n);
    this.buttons
      .get("activity")
      ?.setAttribute("aria-label", n ? t("phone.ui.tabActivityWaiting", { n }) : t("phone.ui.tabActivity"));
  }
}
