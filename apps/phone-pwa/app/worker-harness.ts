// Phase 6 on the task detail page (§3.6): what a harness task waits on and how
// it stands, as grouped sections — the questions it asks (answered right here
// with the `approve` scope, the same path as worker_answer), 續做 when its step
// budget ran out, the state rows (phase, 完成條件, checks, review). Budget,
// sandbox and the 完全授權 log are technical: they go to 技術細節. Rebuilt only
// when the task's state changes, so what the person is typing survives repaints.
import { h, haptic, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";
import type { Session, WorkerState } from "./session.ts";
import { group, row, statusIcon } from "./ui.ts";
import {
  answerCheck,
  budgetLine,
  canAnswer,
  capView,
  HARNESS_WORD,
  markedRecommended,
  PHASE_WORD,
  questionText,
  reviewView,
  sandboxBadge,
  snapshotSkippedLine,
  verificationLine,
  type WorkerHarness,
} from "./worker-view.ts";

/** Technical rows for 技術細節: [label, value]. */
export function harnessTech(hs: WorkerHarness): Array<[string, string | undefined]> {
  const box = sandboxBadge(hs);
  return [
    [t("phone.task.techKind"), HARNESS_WORD[hs.kind]],
    [t("phone.task.techPhase"), hs.phase],
    [t("phone.task.techBudget"), budgetLine(hs.budget)],
    [t("phone.task.techSandbox"), box ? `${box.text}${box.warning ? `\n${box.warning}` : ""}` : undefined],
    [t("phone.task.techDispatch"), hs.dispatchId],
    [t("phone.task.techSnapshot"), snapshotSkippedLine(hs)],
    [
      t("common.fullAccess"),
      hs.autoAllowed?.length
        ? [...hs.autoAllowed]
            .reverse()
            .slice(0, 8)
            .map((a) => `${a.tool}: ${a.summary}`)
            .join("\n")
        : undefined,
    ],
    [
      t("phone.task.techChecks"),
      hs.verification?.checks.length
        ? hs.verification.checks.map((c) => `${c.ok ? "✓" : "✕"} ${c.command}`).join("\n")
        : undefined,
    ],
  ];
}

export class CardHarness {
  readonly el = h("div", { class: "wh" });
  private key = "";
  private readonly drafts: string[] = [];
  private readonly s: Session;

  constructor(s: Session) {
    this.s = s;
  }

  paint(w: WorkerState): void {
    const hs = w.harness;
    const key = JSON.stringify([w.status, hs, this.s.can("approve")]);
    if (key === this.key) return;
    this.key = key;
    this.el.hidden = !hs;
    if (hs) this.el.replaceChildren(...this.build(w, hs));
  }

  private build(w: WorkerState, hs: WorkerHarness): HTMLElement[] {
    const v = verificationLine(hs.verification);
    const r = reviewView(hs);
    const box = sandboxBadge(hs);
    const out: Array<HTMLElement | null> = [
      hs.questions?.length && hs.phase === "waiting_input" ? this.ask(w, hs) : null,
      this.cap(w, hs),
      group({
        header: t("phone.task.state"),
        rows: [
          row({ title: t("phone.task.phase"), value: PHASE_WORD[hs.phase] }),
          hs.doneWhen ? row({ title: t("phone.task.doneWhen"), sub: hs.doneWhen }) : null,
          v
            ? row({
                lead: statusIcon(v.ok === true ? "done" : v.ok === false ? "failed" : "running"),
                title: v.text,
              })
            : null,
          r
            ? row({
                lead: statusIcon(r.tone === "ok" ? "done" : r.tone === "warn" ? "failed" : "stopped"),
                title: r.title,
                sub: r.gaps.length ? r.gaps.slice(0, 4).join("\n") : null,
              })
            : null,
        ],
        // Next round §5.7: no sandbox on the computer — the work runs, and the phone says so.
        footer: box?.warning ?? null,
      }),
    ];
    return out.filter((x): x is HTMLElement => x !== null);
  }

  /** Design §0.2.5: 步數預算用完 → 續做 (needs `approve`; the core checks the limit again). */
  private cap(w: WorkerState, hs: WorkerHarness): HTMLElement | null {
    const c = capView(hs.cap);
    if (!c) return null;
    const may = c.canContinue && this.s.can("approve");
    const err = h("p", { class: "inline-error", role: "alert", hidden: true });
    const go = h(
      "button",
      { class: "btn big primary", type: "button" },
      t("common.continue"),
    ) as HTMLButtonElement;
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await this.s.continueWorker(w.workerId);
        haptic("success");
      } catch (e) {
        err.textContent = e instanceof Error ? e.message : t("phone.workerHarness.notContinued");
        err.hidden = false;
        go.disabled = false;
        haptic("warn");
      }
    });
    return h(
      "div",
      { class: "wh-cap" },
      group({
        header: c.canContinue ? t("phone.task.needsYou") : null,
        rows: [
          row({ lead: statusIcon(c.canContinue ? "waiting" : "stopped"), title: c.title, sub: c.detail }),
        ],
        footer: c.canContinue && !may ? t("phone.workerHarness.thisPhoneDoesntHaveApproval") : null,
      }),
      err,
      may ? go : null,
    );
  }

  private ask(w: WorkerState, hs: WorkerHarness): HTMLElement {
    const qs = hs.questions ?? [];
    if (!canAnswer(hs, (x) => this.s.can(x)))
      return group({
        header: t("phone.task.asksYou"),
        rows: qs.map((q) => row({ title: questionText(q.question) })),
        footer: t("phone.workerHarness.thisPhoneDoesntHaveApproval2"),
      });
    const err = h("p", { class: "inline-error", role: "alert", hidden: true });
    const send = h(
      "button",
      { class: "btn big primary", type: "submit" },
      t("common.sendAnswer"),
    ) as HTMLButtonElement;
    const items = qs.map((q, i) => {
      const input = h("input", {
        class: "field-input",
        type: "text",
        maxlength: "4000",
        placeholder: q.options?.length ? t("common.orWriteYourOwnAnswer") : t("common.yourAnswer"),
        "aria-label": t("common.answerToQuestion", { p0: i + 1 }),
      }) as HTMLInputElement;
      input.value = this.drafts[i] ?? "";
      const opts = (q.options ?? []).map((o, j) => {
        const b = h(
          "button",
          {
            type: "button",
            class: "row wh-opt",
            "aria-pressed": String(this.drafts[i] === o),
            onclick: () => {
              haptic("tap");
              this.drafts[i] = o;
              input.value = o;
              for (const x of b.parentElement?.querySelectorAll(".wh-opt") ?? [])
                x.setAttribute("aria-pressed", String(x === b));
            },
          },
          h(
            "span",
            { class: "row-text" },
            h("span", { class: "row-title" }, o),
            j === 0 && !markedRecommended(o)
              ? h("span", { class: "row-sub" }, t("phone.workerHarness.suggested"))
              : null,
          ),
          h("span", { class: "wh-check", "aria-hidden": "true" }, icon("check", 20)),
        );
        return b;
      });
      input.addEventListener("input", () => {
        this.drafts[i] = input.value;
        for (const x of opts)
          x.setAttribute("aria-pressed", String(x.querySelector(".row-title")?.textContent === input.value));
      });
      return group({
        header: `${qs.length > 1 ? `${i + 1}. ` : ""}${questionText(q.question)}`,
        rows: [...opts, h("div", { class: "row field-row" }, input)],
        footer: q.personOnly ? t("common.onlyYouCanAnswer") : null,
        className: "wh-q",
      });
    });
    return h(
      "form",
      {
        class: "wh-ask",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const r = answerCheck(qs, this.drafts);
          if (!r.ok) {
            err.textContent = r.error;
            err.hidden = false;
            haptic("warn");
            return;
          }
          send.disabled = true;
          try {
            await this.s.answerWorker(w.workerId, r.answers);
            haptic("success");
            this.drafts.length = 0;
          } catch (e2) {
            err.textContent = e2 instanceof Error ? e2.message : t("common.notSent");
            err.hidden = false;
            send.disabled = false;
            haptic("warn");
          }
        },
      },
      ...items,
      err,
      send,
    );
  }
}
