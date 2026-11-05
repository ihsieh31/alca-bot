// @mention in the phone composer (P7): typing @ at the start lists the team
// right above the composer (thumb reach); a tap writes `@name ` so the core
// lets that bot answer here. The chip says who a new conversation goes to.
import { botAvatar, h, haptic, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";
import type { Session } from "./session.ts";
import { mentionQuery } from "./team-view.ts";

export class MentionBox {
  readonly el: HTMLElement;
  private readonly s: Session;
  private readonly input: HTMLTextAreaElement;
  private readonly changed: () => void;

  constructor(s: Session, input: HTMLTextAreaElement, changed: () => void) {
    this.s = s;
    this.input = input;
    this.changed = changed;
    this.el = h("div", {
      class: "mention",
      role: "listbox",
      "aria-label": t("phone.mention.handToWhom"),
      hidden: true,
    });
    input.addEventListener("input", () => this.update());
    input.addEventListener("blur", () => setTimeout(() => this.hide(), 150));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.el.hidden) {
        e.stopPropagation();
        this.hide();
      }
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  hide(): void {
    this.el.hidden = true;
  }

  update(): void {
    const bots = this.s.team?.bots ?? [];
    const q = mentionQuery(this.input.value, this.input.selectionStart ?? this.input.value.length);
    if (q === undefined || bots.length < 2) {
      this.hide();
      return;
    }
    const needle = q.toLowerCase();
    const hits = bots.filter((b) => b.name.toLowerCase().includes(needle));
    if (!hits.length) {
      this.hide();
      return;
    }
    this.el.replaceChildren(
      h("p", { class: "mention-head" }, t("common.handToWhom")),
      ...hits.map((b) =>
        h(
          "button",
          {
            class: "mention-row",
            type: "button",
            role: "option",
            // Keep the keyboard up: pick on pointerdown, before the textarea blurs.
            onpointerdown: (e: Event) => {
              e.preventDefault();
              this.pick(b.name);
            },
            onclick: () => this.pick(b.name),
          },
          botAvatar(b, "md"),
          h("span", { class: "mention-name" }, b.name),
          b.role ? h("span", { class: "mention-role" }, b.role) : null,
        ),
      ),
    );
    this.el.hidden = false;
  }

  private pick(name: string) {
    if (this.el.hidden) return;
    haptic("tap");
    const v = this.input.value;
    const caret = this.input.selectionStart ?? v.length;
    const rest = v.slice(caret).replace(/^\S*/, "").trimStart();
    this.input.value = `@${name} ${rest}`;
    const at = name.length + 2;
    this.input.setSelectionRange(at, at);
    this.hide();
    this.input.focus();
    this.changed();
  }
}

/** 對「X」說: shown when the conversation (or the new one) belongs to a teammate. */
export function addresseeChip(s: Session, onClear: () => void): HTMLElement | null {
  const b = s.threadBot;
  if (!b || b.isDefault) return null;
  return h(
    "div",
    { class: "to-chip" },
    botAvatar(b, "sm"),
    h(
      "span",
      {},
      s.threadId
        ? t("phone.mention.chatWith", { name: b.name })
        : t("phone.mention.talkTo", { name: b.name }),
    ),
    s.threadId
      ? null
      : h(
          "button",
          { class: "to-chip-x", type: "button", "aria-label": t("common.resetToDefault"), onclick: onClear },
          icon("close", 14),
        ),
  );
}
