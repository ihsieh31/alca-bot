import { ActivityGroup, HIDDEN_TOOLS } from "./activity.ts";
import type { AlcaEvent, Message } from "./api.ts";
import { type ApprovalCard, approvalCard } from "./approval-card.ts";
import { STALE_WORD, staleApprovals, workerEnded } from "./approval-stale.ts";
import { h, renderProse } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { type IconName, icon, spinner } from "./icons.ts";
import { reportLine, reportWord } from "./report-text.ts";

export interface TimelineActions {
  approve(approvalId: string, decision: "approved" | "denied"): void;
  answer(questionId: string, answer: string): void;
  suggest(text: string): void;
  /** Router mode: open a worker in the worker panel. */
  openWorker?(workerId: string): void;
  /** Router mode: who a worker is (for the card's origin line). */
  workerLabel?(workerId: string): { title: string; bot?: string } | undefined;
  /** P7: a bot's name and avatar, when the team has more than one (each reply says who spoke). */
  botOf?(botId: string): { name: string; avatar: string; color: string | null } | undefined;
  /** P7: open one bot-to-bot request in the team view. */
  openPeer?(requestId: string): void;
  /** A task's own stream: confirmations show as one 「需要你」 line (the card lives in the chat). */
  compactCards?: boolean;
}

/** The bot that emitted an event (router runs speak as their bot). */
const botOfEvent = (e: AlcaEvent) => (e.actor?.id?.startsWith("bot_") ? e.actor.id : undefined);

const attr = (head: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(head)?.[1];

export interface Suggestion {
  title: string;
  text: string;
}

/** A report row's leading status icon (§3.6): no dots. */
function statusIcon(tone: string | undefined): HTMLElement {
  const map: Record<string, IconName> = {
    succeeded: "check",
    failed: "alert",
    stopped: "stop",
    peer: "person",
    trigger: "clock",
  };
  const name = map[tone ?? ""];
  return h("span", { class: "report-icon", "aria-hidden": "true" }, name ? icon(name) : spinner());
}

interface CardRef {
  el: HTMLElement;
  actions: HTMLElement;
  card?: ApprovalCard;
  choices?: string[];
  /** B10: the worker that asked for this approval, if a worker did. */
  workerId?: string;
}

/** Renders one thread: history, live streaming text, tool chips and the human cards. */
export class Timeline {
  private readonly root: HTMLElement;
  private readonly act: TimelineActions;
  private readonly starters: HTMLElement | undefined;
  private seen = new Set<string>();
  private messages = new Map<string, { prose: HTMLElement; streaming: boolean; text: string }>();
  private tools = new Map<
    string,
    { group: ActivityGroup; i: number; tool: string; args: Record<string, unknown> }
  >();
  private group: ActivityGroup | undefined;
  private approvals = new Map<string, CardRef>();
  private questions = new Map<string, CardRef>();
  private pendingApprovalOrder: string[] = [];
  private pendingQuestionOrder: string[] = [];

  constructor(root: HTMLElement, actions: TimelineActions, starters?: HTMLElement) {
    this.root = root;
    this.act = actions;
    this.starters = starters;
  }

  private setEmpty(on: boolean): void {
    const main = this.root.parentElement;
    if (main) main.toggleAttribute("data-empty", on);
    if (this.starters && !on) {
      this.starters.hidden = true;
      this.starters.replaceChildren();
    }
  }

  reset(): void {
    this.setEmpty(false);
    this.root.replaceChildren();
    this.seen = new Set();
    this.messages = new Map();
    this.tools = new Map();
    this.group = undefined;
    this.approvals = new Map();
    this.questions = new Map();
    this.pendingApprovalOrder = [];
    this.pendingQuestionOrder = [];
  }

  showEmpty(suggestions: readonly Suggestion[]): void {
    this.reset();
    // §3.10: no logo, no wordmark — one line, then three plain suggestion rows.
    this.root.append(
      h(
        "div",
        { class: "empty" },
        h("h2", { class: "empty-title" }, tx("desktop.timeline.whatWouldYouLikeTo")),
      ),
    );
    if (this.starters) {
      this.starters.replaceChildren(
        h(
          "div",
          { class: "starter-row" },
          ...suggestions
            .slice(0, 3)
            .map((s) =>
              h(
                "button",
                { class: "starter", type: "button", title: s.text, onclick: () => this.act.suggest(s.text) },
                h("span", { class: "starter-title" }, s.title),
                h("span", { class: "starter-text" }, s.text),
                icon("chevron", "starter-chev"),
              ),
            ),
        ),
        h(
          "p",
          { class: "starter-note", title: tx("desktop.timeline.alcaWorksOnYourComputer") },
          icon("lock"),
          tx("common.paymentsSendingDeletingAndPublishing"),
        ),
      );
      this.starters.hidden = false;
    }
    this.setEmpty(true);
  }

  /** Something that is not a protocol event (e.g. a skill proposal card) at the end of the thread. */
  appendExtra(el: HTMLElement): HTMLElement {
    return this.add(el);
  }

  private add(el: HTMLElement): HTMLElement {
    if (this.root.querySelector(".empty")) {
      this.root.querySelector(".empty")?.remove();
      this.setEmpty(false);
    }
    if (!el.classList.contains("activity")) this.group = undefined;
    const stick = this.nearBottom();
    this.root.append(el);
    if (stick) this.scrollToEnd();
    return el;
  }

  private nearBottom(): boolean {
    const r = this.root;
    return r.scrollHeight - r.scrollTop - r.clientHeight < 160;
  }

  scrollToEnd(): void {
    this.root.scrollTop = this.root.scrollHeight;
  }

  loadHistory(messages: readonly Message[]): void {
    for (const m of messages) {
      if (m.role === "user") this.userMessage(m.id, m.content);
      else if (m.role === "assistant") this.assistantMessage(m.id, m.content, false, m.botId ?? undefined);
      else if (m.role === "system") this.systemNote(m.id, m.content);
    }
    this.scrollToEnd();
  }

  /**
   * A note the router received instead of a person's message: a worker's
   * report or a trigger. Shown as a compact row, not as something the person said.
   */
  private systemNote(id: string, text: string): void {
    if (this.messages.has(id)) return;
    const el = h("div", { class: "item report" });
    this.messages.set(id, { prose: el, streaming: false, text });
    const head = text.split("\n")[0] ?? "";
    const inner = text.replace(/^<alca:[a-z-]+[^>]*>\n?/, "").replace(/\n?<\/alca:[a-z-]+>[\s\S]*$/, "");
    const lines = inner.split("\n").filter((l) => l.trim() && !l.startsWith("相鄰："));
    if (head.startsWith("<alca:worker")) {
      const wid = attr(head, "id") ?? "";
      // ok="false" on a finished turn: a step failed, so it is not "done" (C2); B6: a harness
      // report that is not done says what it is (a question, blocked, …) in plain words.
      const said = reportWord(attr(head, "status") ?? "succeeded", attr(head, "ok"), attr(head, "report"));
      const spill = lines.find((l) => l.startsWith("全文："));
      const body = lines
        .filter((l) => l !== spill)
        .map(reportLine)
        .filter((l): l is string => !!l)
        .join(" ");
      el.dataset.status = said.tone;
      el.append(
        statusIcon(said.tone),
        h(
          "div",
          { class: "report-body" },
          h(
            "b",
            {},
            tx("desktop.timeline.worker", {
              p0: (attr(head, "title") ?? tx("common.task")).replace(/^[@＠]\S+\s*/, ""),
              word: said.word,
            }),
          ),
          h("span", { class: "report-text" }, body.length > 160 ? `${body.slice(0, 160)}…` : body),
          spill
            ? h(
                "span",
                { class: "report-meta" },
                tx("desktop.timeline.fullTextSavedSeparately", {
                  p0: spill.replace(/^全文：/, "").split("（")[0],
                }),
              )
            : null,
        ),
      );
      if (this.act.openWorker && wid)
        el.append(
          h(
            "button",
            { class: "report-open", type: "button", onclick: () => this.act.openWorker?.(wid) },
            tx("common.view"),
          ),
        );
    } else if (head.startsWith("<alca:peer-report") || head.startsWith("<alca:peer ")) {
      const report = head.startsWith("<alca:peer-report");
      const rid = attr(head, "id") ?? "";
      const status = attr(head, "status") ?? (report ? "done" : "running");
      const who = report
        ? (attr(head, "bot") ?? tx("common.teammate"))
        : (attr(head, "from") ?? tx("common.teammate"));
      const kind = attr(head, "kind") === "ask" ? tx("common.question") : tx("common.task");
      el.dataset.status = status === "done" ? "succeeded" : status === "running" ? "peer" : "failed";
      el.dataset.kind = "peer";
      const body = lines.filter((l) => !l.startsWith("原因：")).join(" ");
      el.append(
        statusIcon(el.dataset.status),
        h(
          "div",
          { class: "report-body" },
          h(
            "b",
            {},
            report
              ? tx("common.teammate2", {
                  who,
                  p1: status === "done" ? tx("common.replied") : tx("common.notFinished"),
                })
              : tx("desktop.timeline.handedOffBy", { who, kind }),
          ),
          h("span", { class: "report-text" }, body.length > 160 ? `${body.slice(0, 160)}…` : body),
        ),
      );
      if (this.act.openPeer && rid)
        el.append(
          h(
            "button",
            { class: "report-open", type: "button", onclick: () => this.act.openPeer?.(rid) },
            tx("common.view"),
          ),
        );
    } else if (head.startsWith("<alca:panel-answer")) {
      // B7: the person's own answer from a worker panel, as the router got it.
      el.dataset.status = "succeeded";
      const answers = lines.filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ""));
      el.append(
        statusIcon("succeeded"),
        h(
          "div",
          { class: "report-body" },
          h("b", {}, tx("desktop.timeline.youAnsweredInTheWorker")),
          h("span", { class: "report-text" }, answers.join(tx("common.text2")).slice(0, 160)),
        ),
      );
    } else if (head.startsWith("<alca:routine")) {
      // A routine's findings, as the router got them: its name and the summary, never the markup.
      el.dataset.status = "trigger";
      const summary = lines.find((l) => l.startsWith("摘要："))?.replace(/^摘要：/, "");
      const items = lines.filter((l) => l.startsWith("- ")).length;
      el.append(
        statusIcon("trigger"),
        h(
          "div",
          { class: "report-body" },
          h(
            "b",
            {},
            tx("desktop.timeline.routineReport", { name: attr(head, "name") ?? tx("common.routines") }),
          ),
          h(
            "span",
            { class: "report-text" },
            (summary ?? (items ? tx("desktop.timeline.routineItems", { items }) : "")).slice(0, 160),
          ),
        ),
      );
    } else if (head.startsWith("<alca:trigger")) {
      el.dataset.status = "trigger";
      el.append(
        statusIcon("trigger"),
        h(
          "div",
          { class: "report-body" },
          h("b", {}, tx("common.trigger", { head: attr(head, "name") ?? "" })),
          h("span", { class: "report-text" }, lines.join(" ").slice(0, 160)),
        ),
      );
    } else {
      // Never show the router's markup: an unknown note shows its text without the tags.
      el.append(
        h(
          "div",
          { class: "report-body" },
          h("span", { class: "report-text" }, lines.join(" ").slice(0, 200)),
        ),
      );
    }
    this.add(el);
  }

  /** A worker's task, at the top of its own stream. */
  private taskMessage(id: string, text: string): void {
    if (this.messages.has(id)) return;
    const resumed = text.includes("重新啟動過");
    const events = text.includes("<alca:stream-events>");
    const goal = events
      ? text
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .join("\n") || text
      : (text.split("</alca:task>").at(-1)?.trim() ?? text);
    const el = h(
      "div",
      { class: "item task" },
      h(
        "span",
        { class: "task-label" },
        events
          ? tx("desktop.timeline.newEventOnASubscribed")
          : resumed
            ? tx("desktop.timeline.handOffContinuesAfterRestart")
            : tx("desktop.timeline.handOff"),
      ),
      h("p", { class: "task-goal" }, goal),
    );
    this.messages.set(id, { prose: el, streaming: false, text });
    this.add(el);
  }

  private userMessage(id: string, text: string): void {
    if (this.messages.has(id)) return;
    const bubble = h("div", { class: "bubble" }, text);
    this.messages.set(id, { prose: bubble, streaming: false, text });
    this.add(h("div", { class: "item msg-user" }, bubble));
  }

  private assistantMessage(
    id: string,
    text: string,
    streaming: boolean,
    botId?: string,
  ): { prose: HTMLElement; streaming: boolean; text: string } {
    const existing = this.messages.get(id);
    if (existing) return existing;
    const prose = h("div", { class: streaming ? "prose streaming" : "prose" });
    if (streaming) prose.append(text);
    else prose.append(renderProse(text));
    const rec = { prose, streaming, text };
    this.messages.set(id, rec);
    const who = botId ? this.act.botOf?.(botId) : undefined;
    this.add(
      h(
        "div",
        { class: "item msg-assistant", ...(who ? { "data-bot": botId } : {}) },
        who
          ? h(
              "div",
              { class: "msg-by" },
              h(
                "span",
                {
                  class: "bot-av",
                  "data-size": "sm",
                  "data-tone": who.color ?? "ink",
                  "aria-hidden": "true",
                },
                who.avatar,
              ),
              h("span", { class: "msg-by-name" }, who.name),
            )
          : null,
        prose,
      ),
    );
    return rec;
  }

  /** Tasks whose confirmation is still open here. */
  pendingWorkers(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const id of this.pendingApprovalOrder) {
      const w = this.approvals.get(id)?.workerId;
      if (w) out.add(w);
    }
    return out;
  }

  get pendingApproval(): string | undefined {
    return this.pendingApprovalOrder[0];
  }

  get pendingQuestion(): { id: string; choices: string[] } | undefined {
    const id = this.pendingQuestionOrder[0];
    return id ? { id, choices: this.questions.get(id)?.choices ?? [] } : undefined;
  }

  /** P14 回覆檢查 rewrote a reply: replace its text and mark it 已修改. */
  revise(messageId: string, text: string): void {
    const rec = this.messages.get(messageId);
    if (!rec) return;
    rec.streaming = false;
    rec.text = text;
    rec.prose.classList.remove("streaming");
    rec.prose.replaceChildren(renderProse(text), h("span", { class: "msg-edited" }, tx("common.edited")));
  }

  apply(e: AlcaEvent): void {
    const key = `${e.runId}:${e.seq}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const d = e.data;
    switch (e.type) {
      case "message.completed": {
        const id = String(d.messageId);
        if (d.role === "user") {
          const text = String(d.text);
          if (text.startsWith("<alca:task") || text.startsWith("<alca:stream-events>"))
            this.taskMessage(id, text);
          else this.userMessage(id, text);
          return;
        }
        if (d.role === "system") {
          this.systemNote(id, String(d.text));
          return;
        }
        const rec = this.messages.get(id);
        if (!rec) {
          this.assistantMessage(id, String(d.text), false, botOfEvent(e));
          return;
        }
        if (rec.streaming) {
          rec.streaming = false;
          rec.text = String(d.text);
          rec.prose.classList.remove("streaming");
          rec.prose.replaceChildren(renderProse(rec.text));
        }
        return;
      }
      case "message.delta": {
        const stick = this.nearBottom();
        const rec = this.assistantMessage(String(d.messageId), "", true, botOfEvent(e));
        if (!rec.streaming) return;
        rec.text += String(d.delta);
        rec.prose.append(String(d.delta));
        if (stick) this.scrollToEnd();
        return;
      }
      case "tool.requested":
        this.toolRequested(String(d.callId), String(d.tool), (d.args ?? {}) as Record<string, unknown>, e.ts);
        return;
      case "tool.completed": {
        const t = this.tools.get(String(d.callId));
        if (!t || t.i < 0) return;
        t.group.done(
          t.i,
          !!d.ok,
          Date.parse(e.ts) || Date.now(),
          String(d.ok ? (d.result ?? "") : (d.error ?? "")),
        );
        return;
      }
      case "approval.requested":
        this.approvalCard(e);
        return;
      case "approval.resolved":
        this.resolveApproval(String(d.approvalId), String(d.decision), e.ts);
        return;
      case "question.asked":
        this.questionCard(String(d.questionId), String(d.prompt), (d.choices as string[] | undefined) ?? []);
        return;
      case "question.answered":
        this.resolveQuestion(String(d.questionId), String(d.answer));
        return;
      case "error": {
        const code = String(d.code);
        const tone = code.startsWith("loop_guard.warn") ? "warn" : "error";
        this.add(h("div", { class: "item notice", "data-tone": tone }, String(d.message)));
        return;
      }
      case "run.finished": {
        for (const rec of this.messages.values()) if (rec.streaming) rec.prose.classList.remove("streaming");
        const reason = String(d.reason);
        const text: Record<string, [string, string]> = {
          interrupted: [tx("desktop.timeline.thisTurnWasInterrupted"), "warn"],
          failed: [tx("desktop.timeline.thisTurnDidntFinish"), "error"],
          max_turns: [tx("desktop.timeline.reachedTheStepLimitStopping"), "warn"],
          cancelled: [tx("desktop.timeline.cancelled"), "warn"],
        };
        const t = text[reason];
        if (t) this.add(h("div", { class: "item notice", "data-tone": t[1] }, t[0]));
        return;
      }
      default:
        return;
    }
  }

  private toolRequested(callId: string, tool: string, args: Record<string, unknown>, ts: string): void {
    if (this.tools.has(callId)) return;
    if (HIDDEN_TOOLS.has(tool)) {
      // Recall and status lookups stay out of the transcript (§3.4); keep the call for its card.
      this.tools.set(callId, { group: this.group ?? new ActivityGroup(), i: -1, tool, args });
      return;
    }
    if (!this.group) {
      this.group = new ActivityGroup();
      this.add(this.group.el);
    }
    const i = this.group.add(tool, args, Date.parse(ts) || Date.now());
    this.tools.set(callId, { group: this.group, i, tool, args });
  }

  private approvalCard(e: AlcaEvent): void {
    const d = e.data;
    const id = String(d.approvalId);
    if (this.approvals.has(id)) return;
    const call = this.tools.get(String(d.callId ?? ""));
    const wid = typeof d.workerId === "string" ? d.workerId : undefined;
    const bot = typeof d.botId === "string" ? this.act.botOf?.(d.botId) : undefined;
    const known = wid ? this.act.workerLabel?.(wid) : undefined;
    const who = wid
      ? tx("desktop.approval.whoTask", {
          bot: known?.bot ?? bot?.name ?? "Alca",
          task: known?.title ?? tx("common.task"),
        })
      : bot?.name;
    const card = approvalCard(
      {
        id,
        cls: String(d.actionClass),
        summary: String(d.summary ?? ""),
        ...(call ? { tool: call.tool, args: call.args } : {}),
        ...(who ? { who } : {}),
        ...(known?.title ? { task: known.title } : {}),
        ...(wid ? { workerId: wid } : {}),
        ...(Array.isArray(d.applied) && d.applied.length ? { applied: d.applied.map(String) } : {}),
      },
      (decision) => this.act.approve(id, decision),
      this.act.compactCards,
    );
    this.approvals.set(id, { el: card.el, actions: card.actions, card, ...(wid ? { workerId: wid } : {}) });
    this.pendingApprovalOrder.push(id);
    this.add(card.el);
  }

  /** B10: a worker ended: its unanswered approval cards can no longer be answered. */
  workerUpdated(w: { workerId: string; status: string; harness?: { phase: string } | undefined }): void {
    if (!workerEnded(w)) return;
    const owner = (id: string) => this.approvals.get(id)?.workerId;
    for (const id of staleApprovals(this.pendingApprovalOrder, owner, w.workerId))
      this.resolveApproval(id, "stale");
  }

  private resolveApproval(id: string, decision: string, at?: string): void {
    const c = this.approvals.get(id);
    this.pendingApprovalOrder = this.pendingApprovalOrder.filter((x) => x !== id);
    if (!c?.card) return;
    c.card.resolve(decision, STALE_WORD, at);
  }

  private questionCard(id: string, prompt: string, choices: string[]): void {
    if (this.questions.has(id)) return;
    const input = h("input", {
      class: "field",
      type: "text",
      placeholder: tx("common.orTypeYourAnswer"),
      "aria-label": tx("desktop.timeline.answer"),
    });
    const submit = () => {
      const v = input.value.trim();
      if (v) this.act.answer(id, v);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.isComposing) {
        ev.preventDefault();
        submit();
      }
    });
    const actions = h(
      "div",
      {},
      choices.length
        ? h(
            "div",
            { class: "choices" },
            ...choices.map((c, i) =>
              h(
                "button",
                { class: "choice", type: "button", onclick: () => this.act.answer(id, c) },
                i < 9 ? h("kbd", {}, String(i + 1)) : null,
                c,
              ),
            ),
          )
        : null,
      h(
        "div",
        { class: "answer-row" },
        input,
        h(
          "button",
          { class: "btn btn-primary", type: "button", onclick: submit },
          tx("desktop.timeline.answer"),
        ),
      ),
    );
    const el = h(
      "article",
      { class: "item card", "data-state": "pending", "aria-label": tx("common.questionCard") },
      h("div", { class: "card-eyebrow" }, tx("common.alcaHasAQuestion")),
      h("h3", { class: "card-title" }, prompt),
      actions,
    );
    this.questions.set(id, { el, actions, choices });
    this.pendingQuestionOrder.push(id);
    this.add(el);
  }

  private resolveQuestion(id: string, answer: string): void {
    const c = this.questions.get(id);
    this.pendingQuestionOrder = this.pendingQuestionOrder.filter((x) => x !== id);
    if (!c) return;
    c.el.dataset.state = "done";
    c.el.replaceChildren(
      h(
        "div",
        { class: "receipt", "data-tone": "ok" },
        h("span", { class: "receipt-icon" }, icon("check")),
        h(
          "span",
          { class: "receipt-text resolution", "data-tone": "ok" },
          tx("desktop.timeline.yourAnswer", { answer }),
        ),
      ),
    );
  }
}
