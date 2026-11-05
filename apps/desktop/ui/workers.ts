import type { AgentsEvent, AlcaEvent, Api, Bot, Worker } from "./api.ts";
import { h, MOD } from "./dom.ts";
import { t, tn } from "./i18n/index.ts";
import { type IconName, icon, spinner } from "./icons.ts";
import { Timeline } from "./timeline.ts";
import { HarnessSection } from "./worker-harness.ts";
import { HARNESS_WORD, isWorking, needsPerson, PHASE_WORD, statusTone, statusWord } from "./worker-view.ts";

// Worker panel (router mode): the thread's workers with their status, and one
// worker's own live stream. The stream comes straight from the worker's SSE
// channel; the router's context never sees it. Built as DOM nodes only.

/** Phase 6: a finished worker whose question waits on the person still belongs with the live ones. */
const active = (w: Worker) => isWorking(w) || (!!w.harness && needsPerson(w.harness.phase));
const attention = (w: Worker) =>
  w.status === "waiting" || w.status === "needs_review" || (!!w.harness && needsPerson(w.harness.phase));

function elapsed(w: Worker, now = Date.now()): string {
  const from = Date.parse(w.startedAt ?? w.createdAt);
  const to = w.finishedAt ? Date.parse(w.finishedAt) : now;
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 1) return t("desktop.workers.under1S");
  if (s < 60) return t("common.s", { s });
  const m = Math.floor(s / 60);
  return m < 60
    ? t("desktop.workers.minS", { m, p1: s % 60 })
    : t("common.hrMin", { p0: Math.floor(m / 60), p1: m % 60 });
}

function why(w: Worker): string | undefined {
  const r = w.stopReason;
  if (!r) return undefined;
  if (r === "user") return t("desktop.workers.youStoppedIt");
  if (r.startsWith("watchdog."))
    return t("desktop.workers.watchdogStoppedIt", { p0: r.split(": ").slice(1).join(": ") || r });
  if (r.startsWith("router")) return t("desktop.workers.theRouterStoppedIt");
  if (r.startsWith("restart")) return t("desktop.workers.anOutboundActionHadAlready");
  return r;
}

export interface WorkerPanelHooks {
  approve(id: string, decision: "approved" | "denied"): void;
  answer(id: string, answer: string): void;
  error(err: unknown): void;
  /** Open state / count changed (top-bar toggle). */
  changed(open: boolean, live: number, attention: boolean): void;
  /** The panel opened (the browser panel shares the column and closes). */
  opened(): void;
  /** Workers with a confirmation open in the chat (they sort under 需要你). */
  pending?(): ReadonlySet<string>;
}

export class WorkerPanel {
  private readonly root: HTMLElement;
  private readonly api: Api;
  private readonly hooks: WorkerPanelHooks;
  private readonly workers = new Map<string, Worker>();
  private bots = new Map<string, Bot>();
  private thread: string | null = null;
  private selected: string | null = null;
  private open = false;
  private stopStream: (() => void) | undefined;
  private readonly streamHost = h("section", { class: "wp-stream", "aria-live": "polite" });
  private timeline: Timeline | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly harness: HarnessSection;

  constructor(root: HTMLElement, api: Api, hooks: WorkerPanelHooks) {
    this.root = root;
    this.api = api;
    this.hooks = hooks;
    this.harness = new HarnessSection(api, {
      error: (err) => hooks.error(err),
      answered: (next) => {
        // The continuation carries on; its own updates follow on the agents channel.
        if (next.threadId === this.thread) this.workers.set(next.workerId, next);
        this.select(null);
        this.render();
      },
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  setBots(bots: readonly Bot[]): void {
    this.bots = new Map(bots.map((b) => [b.id, b]));
  }

  label(workerId: string): { title: string; bot?: string } | undefined {
    const w = this.workers.get(workerId);
    if (!w) return undefined;
    const bot = this.bots.get(w.botId)?.name;
    return { title: w.title, ...(bot ? { bot } : {}) };
  }

  /** The thread on screen changed: load its workers. */
  async setThread(threadId: string | null, initial?: readonly Worker[]): Promise<void> {
    this.thread = threadId;
    if (this.selected && this.workers.get(this.selected)?.threadId !== threadId) this.select(null);
    for (const [id, w] of this.workers) if (w.threadId !== threadId) this.workers.delete(id);
    const list = initial ?? (threadId ? await this.api.workers(threadId).catch(() => []) : []);
    for (const w of list) this.workers.set(w.workerId, w);
    this.render();
  }

  onAgentsEvent(e: AgentsEvent): void {
    const w = e.data.worker;
    if (e.type !== "worker.updated" || !w || w.threadId !== this.thread) return;
    const isNew = !this.workers.has(w.workerId);
    this.workers.set(w.workerId, w);
    // Two or more workers dispatched at once: show them.
    if (isNew && [...this.workers.values()].filter(isWorking).length >= 2 && !this.open) this.toggle(true);
    else this.render();
  }

  toggle(force?: boolean): void {
    const next = force ?? !this.open;
    if (next && !this.open) this.hooks.opened();
    this.open = next;
    if (this.open && !this.ticker) {
      this.ticker = setInterval(() => this.render(), 1000);
    } else if (!this.open && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    this.render();
  }

  /** Open one worker's live stream (from a card's origin line or a report row). */
  show(workerId: string): void {
    this.select(workerId);
    this.toggle(true);
  }

  private select(id: string | null): void {
    if (this.selected === id) return;
    this.stopStream?.();
    this.stopStream = undefined;
    this.selected = id;
    this.streamHost.replaceChildren();
    this.timeline = undefined;
    if (!id) return;
    this.timeline = new Timeline(this.streamHost, {
      // §3.5: the decision lives in the chat; here the card is a one-line 「需要你」 row.
      compactCards: true,
      approve: (a, d) => this.hooks.approve(a, d),
      answer: (q, a) => this.hooks.answer(q, a),
      suggest: () => undefined,
      workerLabel: (w) => this.label(w),
    });
    this.stopStream = this.api.workerStream(id, (e: AlcaEvent) => this.timeline?.apply(e));
  }

  private async stop(w: Worker): Promise<void> {
    try {
      const r = await this.api.stopWorker(w.workerId);
      this.workers.set(w.workerId, r.worker);
      this.render();
    } catch (err) {
      this.hooks.error(err);
    }
  }

  // ── render ───────────────────────────────────────────────
  render(): void {
    const all = [...this.workers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const live = all.filter(isWorking);
    this.hooks.changed(this.open, live.length, all.some(attention));
    this.root.hidden = !this.open;
    if (!this.open) return;
    const w = this.selected ? this.workers.get(this.selected) : undefined;
    if (w) this.mount([this.head(w), this.summary(w), this.streamHost]);
    else this.mount([this.head(undefined), this.list(all), this.foot(undefined)]);
  }

  /** Swap the parts in place: the stream host stays attached, so the ticker never replays its animations. */
  private mount(parts: readonly HTMLElement[]): void {
    const kids = [...this.root.children];
    const same =
      kids.length === parts.length &&
      parts.every((p, i) => (kids[i] === this.streamHost) === (p === this.streamHost));
    if (!same) {
      this.root.replaceChildren(...parts);
      return;
    }
    parts.forEach((p, i) => {
      const k = kids[i];
      if (k && k !== p) k.replaceWith(p);
    });
  }

  private waiting(w: Worker): boolean {
    return attention(w) || (this.hooks.pending?.().has(w.workerId) ?? false);
  }

  /** §3.6 leading status icon: spinner, orange hand, green check, grey stop, red exclamation. */
  private state(w: Worker): { icon: HTMLElement; tone: string } {
    const tone = this.waiting(w) && active(w) ? "waiting" : statusTone(w);
    const map: Record<string, IconName> = {
      waiting: "hand",
      needs_review: "hand",
      succeeded: "check",
      failed: "alert",
      stopped: "stop",
    };
    const name = map[tone];
    return {
      tone,
      icon: h("span", { class: "wp-state", "data-tone": tone }, name ? icon(name) : spinner()),
    };
  }

  private head(w: Worker | undefined): HTMLElement {
    const close = h(
      "button",
      {
        class: "tool-btn",
        type: "button",
        title: t("desktop.workers.hideI", { MOD }),
        "aria-label": t("desktop.workers.hideTheWorkerPanel"),
        onclick: () => this.toggle(false),
      },
      icon("cross"),
    );
    if (!w)
      return h("header", { class: "wp-head" }, h("h2", { class: "wp-title" }, t("common.worker2")), close);
    const back = h(
      "button",
      {
        class: "tool-btn",
        type: "button",
        title: t("desktop.workers.backToTheWorkerList"),
        "aria-label": t("desktop.workers.backToTheWorkerList"),
        onclick: () => {
          this.select(null);
          this.render();
        },
      },
      icon("chevron", "flip"),
    );
    const stop = isWorking(w)
      ? h(
          "button",
          {
            class: "btn btn-text wp-stop",
            "data-tone": "danger",
            type: "button",
            onclick: () => void this.stop(w),
          },
          t("common.stop"),
        )
      : null;
    return h(
      "header",
      { class: "wp-head" },
      back,
      h("h2", { class: "wp-title" }, t("desktop.workers.backToTheWorkerList")),
      stop,
      close,
    );
  }

  private summary(w: Worker): HTMLElement {
    const bot = this.bots.get(w.botId)?.name ?? "Alca";
    const st = this.state(w);
    const harness = this.harness.render(w);
    const reason = why(w);
    const res = w.result;
    const tech = [
      t("desktop.workers.sWorker", { bot }),
      tn("plural.steps", w.steps),
      w.speculative ? t("desktop.workers.preparedAhead") : "",
      res && !isWorking(w)
        ? res.mode === "spill"
          ? t("desktop.workers.theFullCharacterTextWas", { chars: res.chars })
          : t("desktop.workers.theWholeResultWentTo")
        : "",
      w.workerId,
    ].filter(Boolean);
    return h(
      "div",
      { class: "wp-summary" },
      h("h3", { class: "wp-name" }, w.title),
      h(
        "p",
        { class: "wp-status", "data-tone": st.tone },
        st.icon,
        h("span", {}, st.tone === "waiting" ? t("common.waitingOnYou") : statusWord(w)),
        h("span", { class: "wp-time" }, elapsed(w)),
      ),
      reason ? h("p", { class: "wp-reason", "data-status": w.status }, reason) : null,
      harness,
      h(
        "details",
        { class: "tech" },
        h("summary", {}, t("common.technicalDetails")),
        this.harness.tech(w),
        h("pre", { class: "tech-body" }, tech.join("\n")),
      ),
    );
  }

  private list(all: readonly Worker[]): HTMLElement {
    if (all.length === 0)
      return h(
        "div",
        { class: "wp-empty" },
        h("b", {}, t("desktop.workers.noWorkersYet")),
        h("p", {}, t("desktop.workers.whenSomethingNeedsDoingThe")),
      );
    const section = (label: string, ws: readonly Worker[]) =>
      ws.length
        ? h(
            "div",
            { class: "wp-section" },
            h("div", { class: "wp-label" }, label),
            h("div", { class: "wp-group" }, ...ws.map((w) => this.row(w))),
          )
        : null;
    const live = all.filter(active);
    return h(
      "div",
      { class: "wp-list" },
      section(
        t("common.waitingOnYou"),
        live.filter((w) => this.waiting(w)),
      ),
      section(
        t("common.inProgress"),
        live.filter((w) => !this.waiting(w)),
      ),
      section(t("desktop.workers.ended"), all.filter((w) => !active(w)).reverse()),
    );
  }

  private row(w: Worker): HTMLElement {
    const reason = why(w);
    const hs = w.harness;
    const st = this.state(w);
    // One subtitle line: the result's first sentence, why it stopped, or what it is doing.
    const sub =
      w.status === "succeeded" && w.result?.summary
        ? w.result.summary
        : reason
          ? reason
          : st.tone === "waiting"
            ? t("common.waitingOnYou")
            : hs
              ? PHASE_WORD[hs.phase]
              : statusWord(w);
    return h(
      "button",
      {
        class: "wp-item",
        type: "button",
        title: hs ? HARNESS_WORD[hs.kind] : w.title,
        "data-status": st.tone === "waiting" ? "waiting" : w.status,
        onclick: () => this.show(w.workerId),
      },
      st.icon,
      h("span", { class: "wp-item-body" }, h("b", {}, w.title), h("small", { "data-tone": st.tone }, sub)),
      h("span", { class: "wp-time" }, elapsed(w)),
      icon("chevron", "wp-go"),
    );
  }

  private foot(w: Worker | undefined): HTMLElement {
    return h(
      "footer",
      { class: "wp-foot" },
      w
        ? h("span", {}, t("desktop.workers.thisIsTheWorkersOwn"))
        : h("span", {}, t("desktop.workers.eachWorkerHasItsOwn")),
    );
  }
}
