// Talking to a teammate (P7): the sidebar roster (who is on the team and who
// is busy; one click addresses the next message to that bot), the composer's
// "對 X 說" chip, and @mention completion in the composer.
import type { Team, TeamBot } from "./api-team.ts";
import { h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { icon as plainIcon } from "./icons.ts";
import { botAvatar } from "./team.ts";

const stateOf = (b: TeamBot) =>
  b.activity.waiting ? "waiting" : b.activity.workers || b.activity.peersOpen ? "busy" : undefined;

export class Roster {
  private readonly root: HTMLElement;
  private readonly pick: (botId: string | null) => void;
  private readonly openTeam: () => void;
  constructor(root: HTMLElement, pick: (botId: string | null) => void, openTeam: () => void) {
    this.root = root;
    this.pick = pick;
    this.openTeam = openTeam;
  }

  render(team: Team, target: string | null): void {
    if (team.bots.length < 2) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.root.replaceChildren(
      h(
        "div",
        { class: "roster-head" },
        h("span", {}, tx("common.team")),
        h(
          "button",
          { class: "roster-all", type: "button", onclick: () => this.openTeam() },
          tx("desktop.mention.members", { botsCount: team.bots.length }),
        ),
      ),
      h(
        "div",
        { class: "roster-row", role: "group", "aria-label": tx("desktop.mention.whoToTalkTo") },
        ...team.bots.map((b) => {
          const st = stateOf(b);
          return h(
            "button",
            {
              class: "roster-bot",
              type: "button",
              "aria-pressed": target === b.id ? "true" : "false",
              title: `${b.name}${b.role ? `${tx("common.joinComma")}${b.role}` : ""}${st === "waiting" ? tx("desktop.mention.waitingOnYou") : st === "busy" ? tx("desktop.mention.working") : ""}`,
              "aria-label": tx("desktop.mention.talkTo", { name: b.name }),
              onclick: () => this.pick(target === b.id ? null : b.id),
            },
            botAvatar(b, "md"),
            st ? h("i", { class: "roster-dot", "data-state": st }) : null,
          );
        }),
      ),
    );
  }
}

/** The composer chip that says who the next message goes to. */
export function targetChip(el: HTMLElement, bot: TeamBot | undefined, clear: () => void): void {
  el.hidden = !bot;
  if (!bot) {
    el.replaceChildren();
    return;
  }
  el.replaceChildren(
    botAvatar(bot, "sm"),
    h("span", {}, tx("desktop.mention.talkTo", { name: bot.name })),
    h(
      "button",
      {
        class: "target-x",
        type: "button",
        "aria-label": tx("desktop.mention.switchBackToThisChats"),
        onclick: clear,
      },
      plainIcon("cross"),
    ),
  );
}

/** @mention completion on the composer textarea. */
export class MentionBox {
  private readonly input: HTMLTextAreaElement;
  private readonly box: HTMLElement;
  private bots: TeamBot[] = [];
  private items: TeamBot[] = [];
  private index = 0;
  private start = -1;

  constructor(input: HTMLTextAreaElement, host: HTMLElement) {
    this.input = input;
    this.box = h("div", {
      class: "mention-box",
      role: "listbox",
      "aria-label": tx("desktop.mention.mentionATeammate"),
      hidden: true,
    });
    host.append(this.box);
    input.addEventListener("input", () => this.update());
    input.addEventListener("blur", () => setTimeout(() => this.hide(), 120));
    // Capture: the composer's own Enter-to-send must not see a key we used.
    input.addEventListener(
      "keydown",
      (e) => {
        if (this.box.hidden) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.index =
            (this.index + (e.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
          this.render();
        } else if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
          const b = this.items[this.index];
          if (!b) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          this.choose(b);
        } else if (e.key === "Escape") {
          e.stopImmediatePropagation();
          this.hide();
        }
      },
      true,
    );
  }

  setBots(bots: TeamBot[]): void {
    this.bots = bots;
  }

  get isOpen(): boolean {
    return !this.box.hidden;
  }

  private update(): void {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, caret);
    const m = /(^|\s)[@＠]([^\s@＠]{0,20})$/.exec(before);
    if (!m || this.bots.length < 2) {
      this.hide();
      return;
    }
    const q = (m[2] ?? "").toLowerCase();
    this.start = caret - (m[2]?.length ?? 0) - 1;
    this.items = this.bots
      .filter((b) => b.name.toLowerCase().startsWith(q) || b.name.toLowerCase().includes(q))
      .slice(0, 6);
    if (!this.items.length) {
      this.hide();
      return;
    }
    this.index = Math.min(this.index, this.items.length - 1);
    this.box.hidden = false;
    this.render();
  }

  private render(): void {
    this.box.replaceChildren(
      h("div", { class: "mention-head" }, tx("common.handToWhom")),
      ...this.items.map((b, i) =>
        h(
          "button",
          {
            class: "mention-item",
            type: "button",
            role: "option",
            "aria-selected": i === this.index ? "true" : "false",
            onmousedown: (e: Event) => {
              e.preventDefault();
              this.choose(b);
            },
          },
          botAvatar(b, "sm"),
          h("span", { class: "mention-name" }, b.name),
          h("span", { class: "mention-role" }, b.role ?? ""),
        ),
      ),
    );
  }

  private choose(b: TeamBot): void {
    const v = this.input.value;
    const caret = this.input.selectionStart ?? v.length;
    const insert = `@${b.name} `;
    this.input.value = v.slice(0, this.start) + insert + v.slice(caret);
    const pos = this.start + insert.length;
    this.input.setSelectionRange(pos, pos);
    this.input.dispatchEvent(new Event("input"));
    this.hide();
    this.input.focus();
  }

  hide(): void {
    this.box.hidden = true;
    this.index = 0;
  }

  /** Show the list as if the person typed "@" (screenshots, the 提到 button). */
  openFor(text: string): void {
    this.input.value = text;
    this.input.setSelectionRange(text.length, text.length);
    this.update();
  }
}

/** Which bot an @mention at the start of a message names (mirrors the server). */
export function mentionOf(text: string, bots: readonly TeamBot[]): TeamBot | undefined {
  const t = text.trimStart();
  if (!t.startsWith("@") && !t.startsWith("＠")) return undefined;
  const rest = t.slice(1).toLowerCase();
  return bots
    .filter((b) => {
      const n = b.name.toLowerCase();
      const next = rest.charAt(n.length);
      return rest.startsWith(n) && (next === "" || /[\s,，:：、!！?？。.]/.test(next));
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
}
