// Phase 6: the harness part of one worker in the worker panel — harness and
// phase, doneWhen, the verification checks (red / green with the end of their
// output), the budget used, the open NEEDS_INPUT (answered right here, the
// same path as worker_answer with the person's own words), the reviewer's
// gaps, the 完全授權 log, and the dispatch's git snapshots (還原 / 清除, each
// behind a confirm step). Built as DOM nodes only; the wording is in
// worker-view.ts / snapshot-view.ts.

import type { Api, Worker } from "./api.ts";
import { h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import {
  ConfirmGate,
  confirmText,
  restoredLine,
  type Snapshot,
  type SnapshotAction,
  snapshotLabel,
} from "./snapshot-view.ts";
import {
  answerCheck,
  autoAllowedLines,
  budgetRows,
  capView,
  expiresIn,
  HARNESS_WORD,
  type HarnessPart,
  harnessSections,
  markedRecommended,
  PHASE_WORD,
  reviewView,
  sandboxBadge,
  snapshotSkippedLine,
  verificationLine,
  type WorkerHarness,
} from "./worker-view.ts";

export interface HarnessHooks {
  error(err: unknown): void;
  /** The answer went in: the continuation worker (shown in the list). */
  answered(next: Worker): void;
}

/** A meter bar; its fill goes through CSSOM (the page's CSP has no inline styles). */
function bar(ratio: number | undefined): HTMLElement {
  const fill = h("i");
  fill.style.setProperty("--fill", `${Math.round((ratio ?? 0) * 100)}%`);
  return h("span", { class: "wh-bar", "aria-hidden": "true" }, fill);
}

/** Keeps what the person typed and the snapshot list across re-renders of one worker. */
export class HarnessSection {
  private readonly api: Api;
  private readonly hooks: HarnessHooks;
  private drafts = new Map<string, string[]>();
  private snaps = new Map<string, Snapshot[] | "loading" | "error">();
  private note = new Map<string, string>();
  private readonly gate: ConfirmGate;
  private current: Worker | undefined;
  private host: HTMLElement | undefined;
  private key = "";

  constructor(api: Api, hooks: HarnessHooks) {
    this.api = api;
    this.hooks = hooks;
    this.gate = new ConfirmGate((a) => this.act(a));
  }

  /** The section for `w`, rebuilt only when its state changed (the panel re-renders every second). */
  render(w: Worker): HTMLElement | null {
    const hs = w.harness;
    if (!hs) return null;
    const key = JSON.stringify([
      w.workerId,
      w.status,
      hs,
      this.snaps.get(hs.dispatchId ?? ""),
      this.gate.pending,
      this.note.get(w.workerId),
    ]);
    if (this.host && key === this.key && this.current?.workerId === w.workerId) return this.host;
    this.current = w;
    this.key = key;
    this.host = this.build(w, hs);
    return this.host;
  }

  private refresh(): void {
    const w = this.current;
    const old = this.host;
    if (!w || !old) return;
    this.key = "";
    const next = this.render(w);
    if (next && next !== old) old.replaceWith(next);
  }

  private build(w: Worker, hs: WorkerHarness): HTMLElement {
    const v = verificationLine(hs.verification);
    const box = sandboxBadge(hs);
    return h(
      "section",
      { class: "wh", "aria-label": tx("desktop.workerHarness.jobStatus") },
      // Next round §5.7: no sandbox here — the work runs, and the panel says so.
      box?.warning ? h("p", { class: "wh-nosandbox", role: "note" }, box.warning) : null,
      // B10: questions and the 完全授權 list first (harnessSections).
      ...harnessSections(hs, Boolean(v)).map((s) => this.section(s, w, hs, v)),
    );
  }

  /**
   * 素 Plain §5.3: the machine-room facts (harness kind, phase, sandbox, budget
   * meters) for the task's 技術細節 disclosure, not the primary column.
   */
  tech(w: Worker): HTMLElement | null {
    const hs = w.harness;
    if (!hs) return null;
    const box = sandboxBadge(hs);
    const facts = [
      tx("desktop.workerHarness.harness", { p0: HARNESS_WORD[hs.kind] }),
      PHASE_WORD[hs.phase],
      box?.text ?? "",
    ].filter(Boolean);
    return h(
      "div",
      { class: "wh-tech" },
      h("p", { class: "wh-facts" }, facts.join("\n")),
      this.budget(w, hs),
    );
  }

  private section(s: HarnessPart, w: Worker, hs: WorkerHarness, v: string | undefined): HTMLElement | null {
    switch (s) {
      case "cap":
        return this.cap(w, hs);
      case "questions":
        return this.questions(w, hs);
      case "allowed":
        return this.allowed(hs);
      case "doneWhen":
        return h(
          "p",
          { class: "wh-done" },
          h("b", {}, tx("desktop.workerHarness.doneCriteria")),
          h("span", {}, hs.doneWhen ?? ""),
        );
      case "checks":
        return v ? this.checks(hs, v) : null;
      case "budget":
        return null; // in 技術細節 (tech())
      case "review":
        return this.review(hs);
      case "snapshots":
        return hs.dispatchId ? this.snapshots(hs.dispatchId) : null;
    }
  }

  /** Design §0.2.5: 步數預算用完 → 續做 (the person's own act; the core checks the limit again). */
  private cap(w: Worker, hs: WorkerHarness): HTMLElement | null {
    const c = capView(hs.cap);
    if (!c) return null;
    const err = h("p", { class: "wh-err", role: "alert", hidden: true });
    const go = h("button", { class: "btn btn-primary", type: "button" }, tx("common.continue"));
    go.addEventListener("click", () => {
      go.disabled = true;
      void this.api.continueWorker(w.workerId).then(
        (res) => this.hooks.answered(res.worker),
        (e) => {
          go.disabled = false;
          err.hidden = false;
          err.textContent = String((e as Error)?.message ?? e);
        },
      );
    });
    return h(
      "div",
      { class: "wh-block wh-cap", "data-tone": c.canContinue ? "waiting" : "neutral" },
      h("b", {}, c.title),
      h("p", {}, c.detail),
      err,
      c.canContinue ? h("div", { class: "wh-actions" }, go) : null,
    );
  }

  /** B4: 審查：通過／未達成（gaps）／跳過（why）. */
  private review(hs: WorkerHarness): HTMLElement | null {
    const r = reviewView(hs);
    if (!r) return null;
    return h(
      "div",
      { class: "wh-block wh-review", "data-tone": r.tone },
      h("b", {}, r.title),
      r.gaps.length ? h("ul", { class: "wh-list" }, ...r.gaps.map((g) => h("li", {}, g))) : null,
    );
  }

  private checks(hs: WorkerHarness, line: string): HTMLElement {
    const ver = hs.verification;
    const tone = ver?.state === "passed" ? "ok" : ver?.state === "failed" ? "bad" : "live";
    return h(
      "div",
      { class: "wh-block", "data-tone": tone },
      h("b", {}, line),
      ...(ver?.checks ?? []).map((c) =>
        h(
          "details",
          { class: "wh-check", "data-ok": String(c.ok) },
          h(
            "summary",
            {},
            h("i", { "aria-hidden": "true" }),
            h("code", {}, c.command),
            h(
              "small",
              {},
              c.ok
                ? tx("desktop.workerHarness.passed")
                : c.exitCode === null
                  ? tx("common.disconnect")
                  : `exit ${c.exitCode}`,
            ),
          ),
          c.summary
            ? h("pre", {}, c.summary)
            : h("p", { class: "wh-muted" }, tx("desktop.workerHarness.noOutput")),
        ),
      ),
      ver?.feedback && !ver.checks.length ? h("pre", { class: "wh-pre" }, ver.feedback) : null,
    );
  }

  private budget(w: Worker, hs: WorkerHarness): HTMLElement {
    const rows = budgetRows(hs.budget, { startedAt: w.startedAt, finishedAt: w.finishedAt });
    return h(
      "div",
      { class: "wh-budget", role: "list", "aria-label": tx("desktop.workerHarness.budgetUsed") },
      ...rows.map((r) =>
        h(
          "div",
          { class: "wh-meter", role: "listitem", "data-high": String(r.high) },
          h("span", {}, r.label),
          bar(r.ratio),
          h("small", {}, r.text),
        ),
      ),
    );
  }

  private questions(w: Worker, hs: WorkerHarness): HTMLElement {
    const qs = hs.questions ?? [];
    const drafts = this.drafts.get(w.workerId) ?? qs.map(() => "");
    this.drafts.set(w.workerId, drafts);
    const err = h("p", { class: "wh-err", role: "alert", hidden: true });
    const send = h(
      "button",
      { class: "btn btn-primary", type: "submit" },
      tx("common.sendAnswer"),
    ) as HTMLButtonElement;
    const left = expiresIn(hs);
    const items = qs.map((q, i) => {
      const text = h("input", {
        class: "cn-input",
        type: "text",
        maxlength: "4000",
        value: drafts[i] ?? "",
        placeholder: q.options?.length ? tx("common.orWriteYourOwnAnswer") : tx("common.yourAnswer"),
        "aria-label": tx("common.answerToQuestion", { p0: i + 1 }),
      }) as HTMLInputElement;
      text.addEventListener("input", () => {
        drafts[i] = text.value;
        for (const b of opts.querySelectorAll("button"))
          b.setAttribute("aria-pressed", String(b.textContent === text.value));
      });
      const opts = h(
        "div",
        { class: "wh-opts", role: "group" },
        ...(q.options ?? []).map((o, j) =>
          h(
            "button",
            {
              class: "wh-opt",
              type: "button",
              "aria-pressed": String(drafts[i] === o),
              onclick: () => {
                drafts[i] = o;
                text.value = o;
                for (const b of opts.querySelectorAll("button"))
                  b.setAttribute("aria-pressed", String(b.dataset.v === o));
              },
              "data-v": o,
            },
            o,
            j === 0 && !markedRecommended(o) ? h("small", {}, tx("desktop.workerHarness.suggested")) : null,
          ),
        ),
      );
      return h(
        "li",
        { class: "wh-q" },
        h("p", {}, h("b", {}, qs.length > 1 ? `${i + 1}. ` : ""), q.question),
        q.personOnly ? h("span", { class: "wp-badge" }, tx("common.onlyYouCanAnswer")) : null,
        q.options?.length ? opts : null,
        text,
      );
    });
    return h(
      "form",
      {
        class: "wh-block wh-ask",
        "data-tone": "waiting",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const r = answerCheck(qs, drafts);
          if (!r.ok) {
            err.hidden = false;
            err.textContent = r.error;
            return;
          }
          send.disabled = true;
          void this.api.answerWorker(w.workerId, r.answers).then(
            (res) => {
              this.drafts.delete(w.workerId);
              this.hooks.answered(res.worker);
            },
            (e2) => {
              send.disabled = false;
              err.hidden = false;
              err.textContent = String((e2 as Error)?.message ?? e2);
            },
          );
        },
      },
      h(
        "b",
        {},
        tx("common.theWorkerIsWaitingFor"),
        left ? h("small", {}, `${tx("common.joinComma")}${left}`) : null,
      ),
      h("ol", { class: "wh-qs" }, ...items),
      err,
      h("div", { class: "wh-actions" }, send),
    );
  }

  private allowed(hs: WorkerHarness): HTMLElement {
    const skipped = snapshotSkippedLine(hs);
    return h(
      "details",
      { class: "wh-block wh-allowed", "data-tone": "quiet" },
      h(
        "summary",
        {},
        h("span", { class: "wp-badge wh-full" }, tx("common.fullAccess")),
        tx("desktop.workerHarness.autoAllowedActions", { autoAllowedCount: hs.autoAllowed?.length ?? 0 }),
      ),
      skipped ? h("p", { class: "wh-err wh-nosnap" }, skipped) : null,
      h(
        "ul",
        { class: "wh-list" },
        ...autoAllowedLines(hs).map((l) =>
          h("li", {}, h("small", {}, tx("desktop.workerHarness.ago", { when: l.when })), " ", l.text),
        ),
      ),
      h("p", { class: "wh-muted" }, tx("desktop.workerHarness.paymentsAndOutboundSendingAre")),
    );
  }

  // ── snapshots ─────────────────────────────────────────────
  private snapshots(dispatchId: string): HTMLElement {
    const state = this.snaps.get(dispatchId);
    const note = this.current ? this.note.get(this.current.workerId) : undefined;
    const load = h(
      "button",
      { class: "lb-act", type: "button", onclick: () => void this.load(dispatchId) },
      state === undefined ? tx("desktop.workerHarness.showSnapshots") : tx("common.refresh"),
    );
    const list = Array.isArray(state) ? state : [];
    const pending = this.gate.pending;
    return h(
      "div",
      { class: "wh-block wh-snaps", "data-tone": "quiet" },
      h(
        "div",
        { class: "wh-row" },
        h("b", {}, tx("desktop.workerHarness.snapshots")),
        h("span", { class: "wh-spacer" }),
        load,
      ),
      state === "loading" ? h("p", { class: "wh-muted" }, tx("common.loading")) : null,
      state === "error" ? h("p", { class: "wh-err" }, tx("desktop.workerHarness.cantReadSnapshots")) : null,
      Array.isArray(state) && !list.length
        ? h("p", { class: "wh-muted" }, tx("desktop.workerHarness.thisJobHasNoSnapshots"))
        : null,
      list.length
        ? h(
            "ul",
            { class: "wh-snap-list" },
            ...list.map((s) =>
              h(
                "li",
                {},
                h("span", {}, snapshotLabel(s)),
                h("span", { class: "wh-spacer" }),
                h(
                  "button",
                  {
                    class: "lb-act",
                    type: "button",
                    onclick: () => this.ask({ kind: "restore", snapshot: s }),
                  },
                  tx("common.restore"),
                ),
                h(
                  "button",
                  {
                    class: "lb-act",
                    "data-tone": "danger",
                    type: "button",
                    onclick: () => this.ask({ kind: "purge", snapshot: s }),
                  },
                  tx("common.clear"),
                ),
              ),
            ),
          )
        : null,
      list.length > 1
        ? h(
            "button",
            {
              class: "lb-act",
              "data-tone": "danger",
              type: "button",
              onclick: () => this.ask({ kind: "purge" }),
            },
            tx("desktop.workerHarness.clearAll"),
          )
        : null,
      pending && list.length ? this.confirm(pending, list.length) : null,
      note ? h("p", { class: "wh-muted", role: "status" }, note) : null,
    );
  }

  private confirm(a: SnapshotAction, count: number): HTMLElement {
    const t = confirmText(a, count);
    const no = h(
      "button",
      { class: "btn btn-quiet", type: "button", onclick: () => this.cancel() },
      tx("common.notNow2"),
    );
    const yes = h(
      "button",
      {
        class: a.kind === "restore" ? "btn btn-primary" : "btn btn-danger",
        type: "button",
        onclick: () => {
          yes.disabled = true;
          void this.gate.confirm().finally(() => this.refresh());
        },
      },
      t.yes,
    ) as HTMLButtonElement;
    const box = h(
      "div",
      { class: "wh-confirm", role: "alertdialog", "aria-modal": "false", "aria-label": t.title },
      h("b", {}, t.title),
      h("p", {}, t.body),
      h("div", { class: "wh-actions" }, no, yes),
    );
    queueMicrotask(() => no.focus());
    return box;
  }

  private ask(a: SnapshotAction): void {
    this.gate.ask(a);
    this.refresh();
  }

  private cancel(): void {
    this.gate.cancel();
    this.refresh();
  }

  private async load(dispatchId: string): Promise<void> {
    this.snaps.set(dispatchId, "loading");
    this.refresh();
    try {
      this.snaps.set(dispatchId, await this.api.snapshots(dispatchId));
    } catch (e) {
      this.snaps.set(dispatchId, "error");
      this.hooks.error(e);
    }
    this.refresh();
  }

  /** Runs only after the confirm step (ConfirmGate). */
  private async act(a: SnapshotAction): Promise<void> {
    const w = this.current;
    const dispatchId = w?.harness?.dispatchId;
    if (!w || !dispatchId) return;
    try {
      if (a.kind === "restore") {
        const r = await this.api.restoreSnapshot(a.snapshot.repo, a.snapshot.ref);
        this.note.set(w.workerId, restoredLine(r));
      } else {
        const r = await this.api.purgeSnapshots(
          a.snapshot ? { repo: a.snapshot.repo, ref: a.snapshot.ref } : { dispatchId },
        );
        this.note.set(w.workerId, tx("desktop.workerHarness.clearedSnapshots", { purged: r.purged }));
      }
    } catch (e) {
      this.hooks.error(e);
    }
    await this.load(dispatchId);
  }
}
