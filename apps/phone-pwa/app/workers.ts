// Tasks (workers) on the phone (§3.6): a vertical list in sections 需要你 /
// 進行中 / 已完成 — never horizontal pages — and a detail page per task:
// title, status line, 停止 (red, confirmed in an action sheet), 畫面 for a
// browser task, what it asks, 進度 as plain activity rows, 結果, 技術細節.
import { openBrowser } from "./browser.ts";
import { activityRow, shownTool } from "./chat-items.ts";
import { h, haptic, prose } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { type Session, type WorkerState, working } from "./session.ts";
import { actionSheet, Sheet } from "./sheet.ts";
import type { Item } from "./timeline.ts";
import { emptyState, group, row, statusIcon, techDetails } from "./ui.ts";
import { CardHarness, harnessTech } from "./worker-harness.ts";
import { cardStatus, PHASE_WORD } from "./worker-view.ts";

type Kind = "running" | "waiting" | "done" | "stopped" | "failed" | "queued";

const STATUS_WORD: Record<WorkerState["status"], string> = {
  queued: t("common.queued"),
  running: t("common.inProgress"),
  waiting: t("phone.task.needsYouDecide"),
  succeeded: t("common.done2"),
  failed: t("common.notFinished"),
  stopped: t("common.stopped3"),
  needs_review: t("phone.workers.needsConfirmation"),
};

export function taskKind(w: WorkerState): Kind {
  const st = w.harness ? cardStatus(w.harness.phase) : w.status;
  if (st === "running" || st === "queued") return st === "queued" ? "queued" : "running";
  if (st === "waiting" || st === "needs_review") return "waiting";
  if (st === "succeeded") return "done";
  if (st === "failed") return "failed";
  return "stopped";
}

/** 6 秒 / 3 分鐘 / 1 小時 (tabular, no seconds once past a minute). */
export function elapsed(fromIso: string | undefined, now = Date.now()): string {
  const from = fromIso ? Date.parse(fromIso) : Number.NaN;
  if (!Number.isFinite(from)) return "";
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return t("phone.task.seconds", { n: s });
  if (s < 3600) return t("phone.task.minutes", { n: Math.floor(s / 60) });
  return t("phone.task.hours", { n: Math.floor(s / 3600) });
}

const clock = (iso: string | undefined) => {
  const d = iso ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleTimeString(document.documentElement.lang || undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
};

/** The second line: what it is doing now, what it waits on, or the result's first sentence. */
function stepLine(s: Session, w: WorkerState): [string, "waiting" | "danger" | undefined] {
  const k = taskKind(w);
  if (k === "waiting") {
    const card = s.cards.some((c) => c.kind === "approval" && c.workerId === w.workerId);
    return [card ? t("phone.task.needsYouDecide") : t("phone.task.needsYouAnswer"), "waiting"];
  }
  if (k === "running" || k === "queued") {
    const tl = s.workerTimelines.get(w.workerId);
    const tool = [...(tl?.items ?? [])].reverse().find(shownTool) as (Item & { kind: "tool" }) | undefined;
    return [tool?.label ?? (w.harness ? PHASE_WORD[w.harness.phase] : STATUS_WORD[w.status]), undefined];
  }
  const first = w.result?.summary.split(/(?<=[。.!?！？])\s*/)[0];
  if (first) return [first, k === "failed" ? "danger" : undefined];
  return [
    w.harness ? PHASE_WORD[w.harness.phase] : STATUS_WORD[w.status],
    k === "failed" ? "danger" : undefined,
  ];
}

export function taskRow(s: Session, w: WorkerState, open: () => void): HTMLElement {
  const k = taskKind(w);
  const [line, tone] = stepLine(s, w);
  const live = k === "running" || k === "queued";
  return row({
    lead: statusIcon(k),
    title: w.title,
    sub: line,
    subTone: tone,
    value: live ? elapsed(w.startedAt ?? w.createdAt) : clock(w.finishedAt),
    chevron: true,
    onclick: open,
    attrs: { "data-worker": w.workerId },
  });
}

/** 需要你 / 進行中 / 已完成 sections for a list of tasks. */
export function taskSections(s: Session, list: WorkerState[], open: (id: string) => void): HTMLElement[] {
  const by = (k: (w: WorkerState) => boolean) =>
    list.filter(k).map((w) => taskRow(s, w, () => open(w.workerId)));
  const wait = by((w) => taskKind(w) === "waiting");
  const live = by((w) => ["running", "queued"].includes(taskKind(w)));
  const done = by((w) => ["done", "failed", "stopped"].includes(taskKind(w)));
  return [
    wait.length ? group({ header: t("phone.task.needsYou"), rows: wait }) : null,
    live.length ? group({ header: t("common.inProgress"), rows: live }) : null,
    done.length ? group({ header: t("phone.task.finished"), rows: done }) : null,
  ].filter((x): x is HTMLElement => !!x);
}

/** 任務 for this conversation (the chat's nav button), or straight to one task. */
export function openWorkers(s: Session, focus?: string, openCards?: () => void): Sheet {
  if (focus) return openTask(s, focus, openCards);
  const body = h("div", { class: "tasks-page" });
  const paint = () => {
    const secs = taskSections(s, s.workers, (id) => openTask(s, id, openCards));
    body.replaceChildren(
      ...(secs.length
        ? secs
        : [emptyState(t("phone.workers.thisChatHasNoWorkers"), t("phone.task.emptyText"))]),
    );
  };
  const off = s.subscribe((w) => (w === "workers" || w === "worker" || w === "cards") && paint());
  const tick = setInterval(paint, 5000);
  paint();
  return new Sheet(body, {
    label: t("phone.ui.tasks"),
    size: "page",
    onClose: () => {
      off();
      clearInterval(tick);
    },
  });
}

export function openTask(s: Session, workerId: string, openCards?: () => void): Sheet {
  const harness = new CardHarness(s);
  const head = h("header", { class: "task-head" });
  const screen = h("div", { class: "task-screen" });
  const progress = h("div", { class: "task-progress" });
  const result = h("div", { class: "task-result" });
  const tech = h("div", { class: "task-tech" });
  const decide = h("div", { class: "task-decide" });
  const shot = h("div", { class: "task-screen-sec" });
  const stop = h(
    "button",
    {
      class: "text-btn",
      type: "button",
      "data-tone": "danger",
      hidden: true,
      onclick: () => {
        const w = s.workers.find((x) => x.workerId === workerId);
        if (!w) return;
        actionSheet({
          label: t("phone.task.stopTitle", { title: w.title }),
          title: t("phone.task.stopTitle", { title: w.title }),
          message: t("phone.task.stopText"),
          actions: [
            {
              label: t("common.stop"),
              tone: "danger",
              run: async () => {
                haptic("tap");
                await s.stopWorker(workerId);
              },
            },
          ],
        });
      },
    },
    t("common.stop"),
  );
  let lastTech = "";
  const paint = () => {
    const w = s.workers.find((x) => x.workerId === workerId);
    if (!w) {
      head.replaceChildren(emptyState(t("phone.task.gone")));
      return;
    }
    const k = taskKind(w);
    const [line, tone] = stepLine(s, w);
    head.replaceChildren(
      h("h1", { class: "task-title" }, w.title),
      h(
        "p",
        { class: "task-status", "data-tone": tone },
        statusIcon(k),
        h(
          "span",
          {},
          k === "running" || k === "queued"
            ? `${line}`
            : w.harness
              ? PHASE_WORD[w.harness.phase]
              : STATUS_WORD[w.status],
        ),
      ),
    );
    stop.hidden = !working(w);
    // An approval this task waits on: the compact row that opens the sheet.
    const card = s.cards.find((c) => c.kind === "approval" && c.workerId === workerId);
    decide.replaceChildren(
      ...(card && openCards
        ? [
            group({
              header: t("phone.task.needsYou"),
              rows: [
                row({
                  lead: statusIcon("waiting"),
                  title: t("phone.task.needsYouDecide"),
                  chevron: true,
                  onclick: () => openCards(),
                }),
              ],
            }),
          ]
        : []),
    );
    // 畫面: a browser task's live screen, one tap to full screen.
    const sp = s.spaces.find((x) => x.workerId === workerId);
    shot.replaceChildren(
      ...(sp && s.can("view_screen")
        ? [
            group({
              header: t("phone.task.screen"),
              rows: [
                row({
                  icon: "globe",
                  title: sp.title,
                  sub:
                    sp.controller === "user"
                      ? t("common.youreInControl")
                      : t("phone.browser.alcaIsOperating"),
                  chevron: true,
                  onclick: () => void openBrowser(s, sp.spaceId, openCards),
                }),
              ],
            }),
          ]
        : []),
    );
    harness.paint(w);
    const tl = s.workerTimelines.get(workerId);
    const tools = (tl?.items ?? []).filter(shownTool) as Array<Item & { kind: "tool" }>;
    progress.replaceChildren(
      ...(tools.length
        ? [
            group({
              header: t("phone.task.progress"),
              rows: tools.slice(-30).map((x) => activityRow(x)),
              className: "act-cells",
            }),
          ]
        : []),
    );
    const said = [...(tl?.items ?? [])].reverse().find((x) => x.kind === "assistant") as
      | (Item & { kind: "assistant" })
      | undefined;
    const text = w.result?.summary ?? (k === "done" || k === "failed" ? said?.text : undefined);
    result.replaceChildren(
      ...(text
        ? [
            h("h3", { class: "group-h" }, t("phone.task.result")),
            h(
              "div",
              { class: "task-result-text" },
              prose(text.length > 4000 ? `${text.slice(0, 4000)}…` : text),
            ),
          ]
        : []),
    );
    const entries: Array<[string, string | undefined]> = [
      [t("phone.task.techId"), w.workerId],
      [t("phone.task.techSteps"), String(w.steps)],
      [t("phone.task.techStarted"), w.startedAt ?? w.createdAt],
      [t("phone.task.techFinished"), w.finishedAt],
      [t("phone.task.techStop"), w.stopReason],
      ...(w.harness ? harnessTech(w.harness) : []),
    ];
    const sig = JSON.stringify(entries);
    if (sig !== lastTech) {
      lastTech = sig;
      tech.replaceChildren(techDetails(entries));
    }
  };
  const body = h(
    "div",
    { class: "task-page" },
    head,
    decide,
    harness.el,
    shot,
    screen,
    progress,
    result,
    tech,
  );
  const off = s.subscribe((w) => {
    if (w === "workers" || w === "worker" || w === "cards" || w === "spaces" || w === "scopes") paint();
  });
  const tick = setInterval(paint, 5000);
  void s.watchWorker(workerId).catch(() => undefined);
  paint();
  return new Sheet(body, {
    label: t("phone.ui.tasks"),
    size: "page",
    nav: { title: "", trailing: stop, back: t("phone.ui.tasks") },
    onClose: () => {
      off();
      clearInterval(tick);
      void s.watchWorker(null).catch(() => undefined);
    },
  });
}
