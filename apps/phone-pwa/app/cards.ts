// The sheets that wait for the person (§3.5): an approval — the action as the
// title, the facts in plain rows, the lock line, a primary button that repeats
// the verb (disabled for 500 ms after the sheet settles, against tap-through)
// and 「不要」 — and a question. After a decision the sheet goes away and the
// chat keeps a one-line receipt (timeline.ts). Raw ids, addresses and tool
// names only appear under 技術細節.
import { approvalView } from "./approval-view.ts";
import { parseAppAction } from "./connect-view.ts";
import { h, haptic, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";
import type { Session } from "./session.ts";
import { Sheet } from "./sheet.ts";
import type { ApprovalCard, Card, QuestionCard } from "./timeline.ts";
import { group, row, techDetails } from "./ui.ts";

/** Tap-through guard: the primary waits this long after the sheet has settled. */
export const ARM_MS = 500;

function errorLine(): HTMLElement {
  return h("p", { class: "inline-error", role: "alert", hidden: true });
}

function fail(el: HTMLElement, msg: string) {
  el.replaceChildren(icon("alert", 16), h("span", {}, msg));
  el.hidden = false;
  haptic("warn");
}

function decide(
  b: HTMLButtonElement,
  all: HTMLButtonElement[],
  work: () => Promise<unknown>,
  error: HTMLElement,
): void {
  b.addEventListener("click", async () => {
    if (b.disabled) return;
    for (const x of all) x.disabled = true;
    b.dataset.busy = "true";
    try {
      await work();
    } catch (e) {
      for (const x of all) x.disabled = false;
      delete b.dataset.busy;
      fail(error, e instanceof Error ? e.message : t("common.notSentPleaseTryAgain"));
    }
  });
}

function approvalBody(s: Session, c: ApprovalCard, sheet: () => Sheet, others: number): HTMLElement {
  const app = parseAppAction(c.summary, c.args);
  const v = approvalView(c, app);
  const worker = c.workerId ? s.workers.find((w) => w.workerId === c.workerId) : undefined;
  const bot = s.botOf(c.botId);
  const who = [bot?.name ?? s.coreName, worker?.title].filter(Boolean).join(" › ");
  const error = errorLine();
  const can = s.can("approve");
  const allow = h(
    "button",
    {
      class: "btn big primary",
      type: "button",
      "data-tone": v.tier === "danger" ? "danger" : undefined,
      "data-role": "approve",
      disabled: true,
    },
    h("span", { class: "btn-label" }, v.primary),
  );
  const deny = h(
    "button",
    { class: "btn big secondary", type: "button", "data-role": "deny", ...(can ? {} : { disabled: true }) },
    t("phone.approval.dont"),
  );
  // Armed once the sheet has slid in and settled (and only if this phone may decide).
  if (can)
    setTimeout(() => {
      allow.disabled = !s.can("approve");
    }, 420 + ARM_MS);
  // BUG-14: approve taken away while the sheet is open → its buttons stop offering a decision.
  const off = s.subscribe((w) => {
    if (w !== "scopes") return;
    if (!allow.isConnected && !deny.isConnected) return void off();
    if (!s.can("approve")) allow.disabled = deny.disabled = true;
  });
  decide(
    allow,
    [allow, deny],
    async () => {
      await s.approve(c.id, "approved");
      haptic("success");
      sheet().close();
    },
    error,
  );
  decide(
    deny,
    [allow, deny],
    async () => {
      await s.approve(c.id, "denied");
      haptic("tap");
      sheet().close();
    },
    error,
  );
  const facts = [
    row({ title: t("phone.approval.who"), value: who }),
    ...v.facts.map(([k, val]) => row({ title: k, value: val })),
  ];
  const tech = techDetails([
    [t("phone.approval.techAction"), c.args && app ? app.tool : undefined],
    [t("phone.approval.techSummary"), c.summary],
    [t("phone.approval.techDetail"), c.detail && c.detail !== c.summary ? c.detail : undefined],
    [t("phone.approval.techArgs"), c.args ? JSON.stringify(c.args, null, 2).slice(0, 2000) : undefined],
    [t("phone.approval.techClass"), c.actionClass],
    [t("phone.approval.techRules"), c.applied?.join("\n")],
    [t("phone.approval.techTask"), c.workerId],
    [t("phone.approval.techId"), c.id],
    [t("phone.approval.techExpires"), c.expiresAt],
  ]);
  return h(
    "article",
    { class: "approval", "data-tier": v.tier },
    h(
      "header",
      { class: "ap-head" },
      h("span", { class: "ap-icon", "aria-hidden": "true" }, icon(v.icon, 28)),
      h("h2", { class: "ap-title" }, v.title),
      v.subtitle ? h("p", { class: "ap-sub" }, v.subtitle) : null,
    ),
    group({ rows: facts, className: "ap-facts" }),
    v.preview ? h("p", { class: "ap-preview" }, v.preview) : null,
    v.tier !== "routine"
      ? h(
          "p",
          { class: "ap-lock" },
          icon("lock", 14),
          h("span", {}, t("common.paymentsSendingDeletingAndPublishing")),
        )
      : null,
    !can
      ? h("p", { class: "ap-lock" }, icon("info", 14), h("span", {}, t("common.thisPhoneDoesntHaveThe")))
      : null,
    error,
    h("div", { class: "ap-actions" }, allow, deny),
    others > 0 ? h("p", { class: "ap-more" }, t("phone.approval.moreNeedYou", { others })) : null,
    tech,
  );
}

function questionBody(s: Session, c: QuestionCard, sheet: () => Sheet): HTMLElement {
  const error = errorLine();
  const send = async (answer: string) => {
    try {
      await s.answer(c.id, answer);
      haptic("tap");
      sheet().close();
    } catch (e) {
      fail(error, e instanceof Error ? e.message : t("common.notSent"));
    }
  };
  const input = h("input", {
    class: "field-input",
    type: "text",
    placeholder: t("common.orTypeYourAnswer"),
    enterkeyhint: "send",
    "aria-label": t("common.yourAnswer"),
  });
  const submit = h(
    "button",
    { class: "q-send", type: "button", "aria-label": t("common.sendAnswer") },
    icon("send", 18),
  );
  submit.addEventListener("click", () => input.value.trim() && void send(input.value.trim()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) void send(input.value.trim());
  });
  return h(
    "article",
    { class: "approval question" },
    h(
      "header",
      { class: "ap-head" },
      h("span", { class: "ap-icon", "aria-hidden": "true" }, icon("chats", 26)),
      h("p", { class: "ap-eyebrow" }, t("common.alcaHasAQuestion")),
      h("h2", { class: "ap-title" }, c.prompt),
    ),
    c.choices.length
      ? group({
          rows: c.choices.map((choice) =>
            row({ title: choice, tone: "accent", onclick: () => void send(choice) }),
          ),
          className: "q-choices",
        })
      : null,
    h("div", { class: "q-field" }, input, submit),
    error,
  );
}

/** Shows the first waiting card as a sheet; reopens for the next one. */
export class CardPresenter {
  private sheet: Sheet | undefined;
  private shownId: string | undefined;
  private dismissed = new Set<string>();
  private readonly s: Session;
  private readonly active: () => boolean;

  /** `active`: whether a new card may present itself now (its conversation is on screen). */
  constructor(s: Session, active: () => boolean = () => true) {
    this.s = s;
    this.active = active;
  }

  /** Called whenever the cards change. New cards pop up by themselves; dismissed ones wait in the chat row. */
  sync(auto = this.active()): void {
    const cards = this.s.cards;
    if (this.shownId && !cards.some((c) => c.id === this.shownId)) {
      this.sheet?.close();
      this.sheet = undefined;
      this.shownId = undefined;
    }
    if (this.sheet?.isOpen) return;
    const next = cards.find((c) => !this.dismissed.has(c.id));
    if (next && auto) this.show(next);
  }

  /** Open the first waiting card even if it was dismissed (the 需要你 row). */
  openFirst(): void {
    const c = this.s.cards[0];
    if (!c) return;
    this.dismissed.delete(c.id);
    this.show(c);
  }

  /**
   * Open one card by id (opened from a notification). Returns false when that
   * card is not waiting in this thread. No 「從通知打開」 chip or caption (素 Plain
   * §3.5): the sheet rising is itself the answer to the tap.
   */
  openById(id: string): boolean {
    const c = this.s.cards.find((x) => x.id === id);
    if (!c) return false;
    this.dismissed.delete(c.id);
    this.show(c);
    return true;
  }

  private show(c: Card) {
    if (this.sheet?.isOpen) this.sheet.close();
    this.shownId = c.id;
    haptic("warn");
    const others = this.s.cards.length - 1;
    let sheet!: Sheet;
    const body =
      c.kind === "approval"
        ? approvalBody(this.s, c, () => sheet, others)
        : questionBody(this.s, c, () => sheet);
    sheet = new Sheet(body, {
      label: c.kind === "approval" ? approvalView(c).title : t("common.questionCard"),
      className: "card-sheet-wrap",
      onClose: () => {
        if (this.s.cards.some((x) => x.id === c.id)) this.dismissed.add(c.id);
        if (this.sheet === sheet) {
          this.sheet = undefined;
          this.shownId = undefined;
          // The next one (if any) after a short beat.
          setTimeout(() => this.sync(), 360);
        }
      },
    });
    this.sheet = sheet;
  }
}
