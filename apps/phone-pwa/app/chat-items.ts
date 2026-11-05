// How the conversation's items look (§3.3, §3.4): the user's bubble, the
// assistant's full-width text, one collapsed 「做了 N 件事」 row for each run of
// tool calls (expands to plain activity rows; tap one for 技術細節), a task
// row for a worker's report, a one-line receipt for a decided approval.
import { h, icon, prose } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { Sheet } from "./sheet.ts";
import type { Item } from "./timeline.ts";
import { statusIcon, techDetails } from "./ui.ts";

type ToolItem = Item & { kind: "tool" };

/** Which icon a tool's row gets (§3.4): globe = web, doc = read, magnifier = search… */
export function toolIcon(tool: string): string {
  if (/^browser_(open|navigate)/.test(tool) || /web|fetch|http/.test(tool)) return "globe";
  if (/click|press|type|select/.test(tool)) return "cursor";
  if (/search|query|find/.test(tool)) return "search";
  if (/write|edit|patch|update/.test(tool)) return "pencil";
  if (/mail|gmail|send/i.test(tool)) return "mail";
  if (/^worker_|peer|hand/.test(tool)) return "person";
  if (/run|exec|shell|command/.test(tool)) return "terminal";
  return "doc";
}

/** Recall lookups stay out of the transcript (§3.4): they live in 技術細節. */
export const shownTool = (it: Item): boolean => it.kind === "tool" && it.tool !== "recall";

function toolTech(it: ToolItem) {
  new Sheet(
    h(
      "div",
      { class: "tech-sheet" },
      h("p", { class: "ts-title" }, it.label),
      techDetails([
        [t("phone.chatItems.tool"), it.tool],
        [
          t("phone.chatItems.args"),
          it.args === undefined ? undefined : JSON.stringify(it.args, null, 2).slice(0, 3000),
        ],
        [t("phone.chatItems.state"), it.state],
        [t("phone.chatItems.callId"), it.id.replace(/^tool:/, "")],
      ]),
    ),
    { label: t("phone.ui.technicalDetails"), nav: { title: t("phone.ui.technicalDetails") } },
  ).panel
    .querySelector<HTMLDetailsElement>("details")
    ?.setAttribute("open", "");
}

/** One plain activity row: [icon] verb phrase · trailing state word. */
export function activityRow(it: ToolItem, tappable = true): HTMLElement {
  const lead =
    it.state === "running"
      ? h("span", { class: "act-icon", "aria-hidden": "true" }, h("i", { class: "spin" }))
      : h(
          "span",
          {
            class: "act-icon",
            "data-tone": it.state === "fail" ? "danger" : undefined,
            "aria-hidden": "true",
          },
          icon(it.state === "fail" ? "alert" : toolIcon(it.tool), 18),
        );
  const kids = [
    lead,
    h("span", { class: "act-label" }, it.label),
    it.state === "fail"
      ? h("span", { class: "act-state", "data-tone": "danger" }, t("phone.chatItems.failed"))
      : null,
  ];
  return tappable
    ? h(
        "button",
        { class: "act-row", type: "button", "data-state": it.state, onclick: () => toolTech(it) },
        ...kids,
      )
    : h("div", { class: "act-row", "data-state": it.state }, ...kids);
}

/** The collapsed row over a run of tool calls; open shows each step. */
export function activityGroup(tools: ToolItem[], open: boolean, toggle: () => void): HTMLElement {
  const running = tools.find((x) => x.state === "running");
  const failed = tools.some((x) => x.state === "fail");
  const summary = h(
    "button",
    { class: "act-sum", type: "button", "aria-expanded": String(open), onclick: toggle },
    running
      ? h("span", { class: "act-icon", "aria-hidden": "true" }, h("i", { class: "spin" }))
      : h(
          "span",
          { class: "act-icon", "data-tone": failed ? "danger" : undefined, "aria-hidden": "true" },
          icon(failed ? "alert" : "activity", 18),
        ),
    h(
      "span",
      { class: "act-label" },
      running ? running.label : t("phone.chatItems.didThings", { n: tools.length }),
    ),
    h("span", { class: "act-chev", "aria-hidden": "true" }, icon("chevron", 14)),
  );
  return h(
    "div",
    { class: "act-group", "data-open": String(open) },
    summary,
    open ? h("div", { class: "act-list" }, ...tools.map((x) => activityRow(x))) : null,
  );
}

const REPORT_STATUS: Record<string, "done" | "failed" | "stopped" | "waiting" | "running"> = {
  succeeded: "done",
  failed: "failed",
  stopped: "stopped",
  needs_review: "waiting",
  peer: "running",
};

/** A worker's (or teammate's) report: a task row with a chevron. */
export function reportRow(it: Item & { kind: "report" }, open: (() => void) | undefined): HTMLElement {
  const st = REPORT_STATUS[it.status];
  const first = it.text.split(/(?<=[。.!?！？])\s*/)[0] ?? "";
  const kids = [
    st ? statusIcon(st) : h("span", { class: "row-icon bare", "aria-hidden": "true" }, icon("info", 20)),
    h(
      "span",
      { class: "rp-text" },
      h("span", { class: "rp-title" }, it.title),
      first ? h("span", { class: "rp-sub" }, first) : null,
    ),
    open ? h("span", { class: "row-chev", "aria-hidden": "true" }, icon("chevron", 16)) : null,
  ];
  return open
    ? h("button", { class: "report-row", type: "button", onclick: open }, ...kids)
    : h("div", { class: "report-row" }, ...kids);
}

export function receiptRow(it: Item & { kind: "receipt" }): HTMLElement {
  const at = new Date(it.at);
  const time = Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleTimeString(document.documentElement.lang || undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
  return h(
    "div",
    { class: "receipt", "data-decision": it.decision },
    h(
      "span",
      { class: "act-icon", "aria-hidden": "true" },
      icon(it.decision === "approved" ? "checkCircle" : it.decision === "denied" ? "xmark" : "alert", 18),
    ),
    h("span", { class: "act-label" }, it.text),
    time ? h("span", { class: "receipt-time" }, time) : null,
  );
}

export function assistantBody(
  it: Item & { kind: "assistant" },
  who: { name: string; avatar: string; color: string | null } | undefined,
): Node[] {
  return [
    ...(who ? [h("div", { class: "msg-by" }, who.name)] : []),
    prose(it.text),
    ...(it.edited ? [h("span", { class: "msg-edited" }, t("common.edited"))] : []),
  ];
}
