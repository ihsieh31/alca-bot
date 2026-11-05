// 提前做 (P13) in 例行工作: what each bot is preparing ahead, and how far along
// it is. Finished work only ever becomes drafts (the list above); nothing here
// sends, and early work never raises an approval or question card.
import type { EarlyView, RoutineList } from "./api-connect.ts";
import { ago, h } from "./dom.ts";
import { t } from "./i18n/index.ts";

const STATUS: Record<EarlyView["status"], { label: string; tone: string }> = {
  queued: { label: t("common.queued"), tone: "" },
  running: { label: t("desktop.earlyView.preparing"), tone: "guess" },
  ready: { label: t("desktop.earlyView.draftReady"), tone: "ok" },
  skipped: { label: t("desktop.earlyView.skipped"), tone: "" },
  failed: { label: t("common.notFinished"), tone: "danger" },
};

const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** One line of what an item is waiting on / produced. */
export function earlyNote(e: EarlyView, now = Date.now()): string {
  if (e.status === "queued" && e.notBefore && Date.parse(e.notBefore) > now)
    return t("desktop.earlyView.quietHoursStartsAfter", { notBefore: clock(e.notBefore) });
  if (e.status === "queued") return t("desktop.earlyView.waitingForAFreeWorker");
  if (e.status === "running") return t("desktop.earlyView.preparingInTheBackgroundWont");
  if (e.status === "ready")
    return e.draftIds.length
      ? t("desktop.earlyView.draftsWaitingForYouAbove", { draftIdsCount: e.draftIds.length })
      : t("desktop.earlyView.readyNothingNeededADraft");
  return e.detail
    ? e.detail.slice(0, 120)
    : e.status === "failed"
      ? t("desktop.earlyView.backgroundWorkDidntFinish")
      : t("desktop.earlyView.nothingToPrepare");
}

/** The set of draft ids that came from 提前做, so their cards can say so. */
export function earlyDraftIds(list: RoutineList): Set<string> {
  return new Set((list.early ?? []).flatMap((e) => e.draftIds));
}

export function earlySection(list: RoutineList): HTMLElement | null {
  const items = list.early ?? [];
  if (!items.length) return null;
  const busy = items.filter((e) => e.status === "queued" || e.status === "running").length;
  return h(
    "section",
    { class: "lb-section" },
    h(
      "h3",
      { class: "lb-h2", title: busy ? t("desktop.earlyView.inProgress", { busy }) : undefined },
      t("common.workAhead"),
    ),
    h(
      "ul",
      { class: "lb-list rt-early" },
      ...items.map((e) => {
        const st = STATUS[e.status] ?? { label: e.status, tone: "" };
        return h(
          "li",
          { class: "lb-row rt-early-row", "data-status": e.status, title: ago(e.updatedAt) },
          h(
            "div",
            { class: "lb-main" },
            h("p", { class: "lb-body" }, e.title),
            h("p", { class: "lb-meta" }, earlyNote(e)),
          ),
          h("span", { class: "rt-early-state", "data-tone": st.tone }, st.label),
        );
      }),
    ),
  );
}
