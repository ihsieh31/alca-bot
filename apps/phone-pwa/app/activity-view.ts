// 進行中 tab (§2.1): 需要你 first — the approvals and questions waiting here,
// other conversations that wait on the person, a skill Alca learned — then
// the running tasks, the browser windows Alca has open, what finished, and
// 例行工作. Every row opens the thing itself; nothing is decided from the list.
import { approvalView } from "./approval-view.ts";
import { parseAppAction } from "./connect-view.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import type { Session } from "./session.ts";
import { emptyState, group, largeTitleScreen, row, statusIcon } from "./ui.ts";
import { taskKind, taskRow } from "./workers.ts";

export interface ActivityActions {
  openCard(id: string): void;
  openThread(id: string): void;
  openTask(id: string): void;
  openBrowser(spaceId: string): void;
  openProposal(id: string): void;
  openRoutines(): void;
}

export function activityScreen(s: Session, a: ActivityActions): HTMLElement {
  const body = h("div", { class: "activity-body" });
  const title = (id: string | null) => s.threads.find((x) => x.id === id)?.title || t("common.chat");
  const paint = () => {
    const here = s.threadId;
    const needs = [
      ...s.cards.map((c) =>
        row({
          lead: statusIcon("waiting"),
          title: c.kind === "approval" ? approvalView(c, parseAppAction(c.summary, c.args)).title : c.prompt,
          sub: c.kind === "approval" ? title(here) : t("common.alcaHasAQuestion"),
          chevron: true,
          onclick: () => a.openCard(c.id),
          attrs: { "data-card": c.id },
        }),
      ),
      ...s.workers
        .filter(
          (w) =>
            taskKind(w) === "waiting" &&
            !s.cards.some((c) => c.kind === "approval" && c.workerId === w.workerId),
        )
        .map((w) => taskRow(s, w, () => a.openTask(w.workerId))),
      ...s.threads
        .filter((x) => x.waiting && x.id !== here)
        .map((x) =>
          row({
            lead: statusIcon("waiting"),
            title: x.title || t("common.chat"),
            sub: t("phone.ui.needsYouLine"),
            subTone: "waiting",
            chevron: true,
            onclick: () => a.openThread(x.id),
          }),
        ),
      ...s.proposals
        .filter((p) => p.pending)
        .map((p) =>
          row({
            icon: "checkCircle",
            iconTone: "accent",
            bare: true,
            title: t("phone.chat.learnedSkill", { name: p.pending?.name ?? "" }),
            sub: t("phone.activity.reviewSkill"),
            chevron: true,
            onclick: () => a.openProposal(p.id),
          }),
        ),
    ];
    const live = [
      ...s.workers
        .filter((w) => ["running", "queued"].includes(taskKind(w)))
        .map((w) => taskRow(s, w, () => a.openTask(w.workerId))),
      ...s.threads
        .filter((x) => x.busy && x.id !== here)
        .map((x) =>
          row({
            lead: statusIcon("running"),
            title: x.title || t("common.chat"),
            sub: x.workers ? t("phone.ui.tasksCount", { n: x.workers }) : t("phone.ui.working"),
            chevron: true,
            onclick: () => a.openThread(x.id),
          }),
        ),
    ];
    const screens = s.can("view_screen")
      ? s.spaces.map((sp) =>
          row({
            icon: "globe",
            title: sp.title,
            sub:
              sp.controller === "user"
                ? t("common.youreInControl")
                : sp.status === "waiting_user"
                  ? t("common.waitingOnYou")
                  : t("phone.browser.alcaIsOperating"),
            subTone: sp.status === "waiting_user" ? "waiting" : undefined,
            chevron: true,
            onclick: () => a.openBrowser(sp.spaceId),
          }),
        )
      : [];
    const done = s.workers
      .filter((w) => ["done", "failed", "stopped"].includes(taskKind(w)))
      .map((w) => taskRow(s, w, () => a.openTask(w.workerId)));
    const nothing = !needs.length && !live.length && !screens.length && !done.length;
    body.replaceChildren(
      ...(nothing ? [emptyState(t("phone.activity.emptyTitle"), t("phone.activity.emptyText"))] : []),
      needs.length ? group({ header: t("phone.task.needsYou"), rows: needs }) : "",
      live.length ? group({ header: t("common.inProgress"), rows: live }) : "",
      screens.length ? group({ header: t("phone.activity.browser"), rows: screens }) : "",
      done.length
        ? group({
            header: here ? t("phone.activity.finishedIn", { title: title(here) }) : t("phone.task.finished"),
            rows: done,
          })
        : "",
      group({
        rows: [
          row({
            icon: "refresh",
            title: t("common.routines"),
            chevron: true,
            onclick: () => a.openRoutines(),
          }),
        ],
        footer: t("phone.activity.routinesFooter"),
      }),
    );
  };
  const screen = largeTitleScreen({
    title: t("phone.ui.tabActivity"),
    content: body,
    className: "activity-screen",
  });
  s.subscribe((w) => {
    if (["cards", "thread", "threads", "workers", "worker", "spaces", "skills", "scopes"].includes(w))
      paint();
  });
  screen.el.addEventListener("tabshow", () => {
    paint();
    void s.refreshThreads().catch(() => undefined);
    if (s.can("view_screen")) void s.loadSpaces().catch(() => undefined);
  });
  setInterval(() => !screen.el.hidden && paint(), 5000);
  paint();
  return screen.el;
}
