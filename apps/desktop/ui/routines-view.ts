// 例行工作: watches and schedules that look with plain code first. Nothing
// new → no AI (0 tokens). A read failure is shown as such (the place in the
// mailbox is kept, Alca tries again later). Drafts a run prepared ahead wait
// here; using one is a new request, and sending still asks.
import type {
  ConnectorsStatus,
  DraftView,
  NewRoutine,
  RoutineList,
  RoutineRun,
  RoutineView,
} from "./api-connect.ts";
import type { ConnectView } from "./connect.ts";
import { ago, h } from "./dom.ts";
import { earlyDraftIds, earlySection } from "./early-view.ts";
import { t } from "./i18n/index.ts";
import { spinner } from "./icons.ts";
import { moreButton } from "./menu.ts";

const OUTCOME: Record<RoutineRun["outcome"], { label: string; tone: string }> = {
  quiet: { label: t("common.nothingNew"), tone: "quiet" },
  new: { label: t("desktop.routinesView.foundSomethingNewAi"), tone: "new" },
  ai_done: { label: t("common.aiFinishedReading"), tone: "done" },
  ai_invalid: { label: t("desktop.routinesView.aisAnswerWasBadlyFormatted"), tone: "warn" },
  ai_failed: { label: t("common.aiDidntFinish"), tone: "warn" },
  read_failed: { label: t("common.readFailed"), tone: "danger" },
  capped: { label: t("common.todaysAiRunsAreUsed"), tone: "warn" },
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(document.documentElement.lang || undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

/** After a read failure the next look waits for the backoff, whichever is later. */
const later = (a: string, b: string | null) => (b && Date.parse(b) > Date.parse(a) ? b : a);

const until = (iso: string) => {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 60_000) return t("common.rightAway");
  const min = Math.round(ms / 60_000);
  if (min < 60) return t("common.inMin", { min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("common.inHr", { hr });
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${clock(iso)}`;
};

/** §4.2: a routine is a row — name, one line (when, next or the problem), switch and a `…` menu; the log folds under it. */
function routineCard(v: ConnectView, r: RoutineView): HTMLElement {
  const api = v.client;
  const removing = v.ui.removing === r.id;
  const next =
    r.enabled && r.nextAt && r.kind !== "trigger"
      ? t("desktop.routinesView.next", { nextAt: until(later(r.nextAt, r.backoffUntil)) })
      : r.enabled
        ? ""
        : t("common.disabled");
  const sub =
    r.state === "error" && r.lastError
      ? `${t("desktop.routinesView.cantRead")}${plainError(r.lastError)}`
      : [r.schedule, next].filter(Boolean).join(t("common.joinComma"));
  const tip = [
    r.check,
    r.lastCheckedAt
      ? t("common.checked", { lastCheckedAt: ago(r.lastCheckedAt) })
      : t("common.notCheckedYet"),
    r.speculative ? t("desktop.routinesView.canDraftAheadAnythingSent") : "",
    r.instructions ? t("desktop.routinesView.text", { instructions: r.instructions }) : "",
    r.state === "error" && r.lastError ? r.lastError : "",
  ]
    .filter(Boolean)
    .join("\n");
  const log = r.runs
    .slice(0, 6)
    .map((x) =>
      h(
        "li",
        { class: "act-row rt-log-row", "data-tone": OUTCOME[x.outcome]?.tone ?? "" },
        h(
          "span",
          { class: "act-text" },
          OUTCOME[x.outcome]?.label ?? x.outcome,
          x.items ? t("common.items", { items: x.items }) : "",
          x.detail && x.outcome !== "read_failed" ? `${t("common.joinComma")}${x.detail.slice(0, 80)}` : "",
        ),
        h("span", { class: "act-trail" }, clock(x.at)),
      ),
    );
  const row = h(
    "li",
    { class: "lb-row rt-row", "data-state": r.state, title: tip },
    h(
      "details",
      { class: "lb-main rt-fold" },
      h(
        "summary",
        {},
        h("p", { class: "lb-body rt-name" }, r.name),
        h("p", { class: "lb-meta rt-sub", "data-state": r.state }, sub),
      ),
      r.state === "error"
        ? h(
            "p",
            { class: "rt-error-note" },
            t("desktop.routinesView.progressIsKeptNothingWill", {
              p0: r.backoffUntil
                ? t("desktop.routinesView.retrying", { backoffUntil: until(r.backoffUntil) })
                : t("desktop.routinesView.retryingLater"),
            }),
          )
        : null,
      log.length ? h("ul", { class: "rt-log" }, ...log) : null,
    ),
    removing
      ? h(
          "div",
          { class: "lb-actions lb-confirm" },
          h("span", {}, t("desktop.routinesView.removeThisRoutine")),
          h(
            "button",
            {
              class: "btn btn-quiet",
              type: "button",
              onclick: () => {
                v.ui.removing = undefined;
                v.render();
              },
            },
            t("common.cancel"),
          ),
          h(
            "button",
            {
              class: "btn btn-danger",
              type: "button",
              onclick: () => void v.act(api.removeRoutine(r.id), () => (v.ui.removing = undefined)),
            },
            t("common.remove"),
          ),
        )
      : h(
          "div",
          { class: "lb-actions" },
          r.state === "working" ? spinner() : null,
          h(
            "button",
            {
              class: "lb-switch",
              type: "button",
              role: "switch",
              "aria-checked": r.enabled ? "true" : "false",
              "aria-label": r.name,
              title: r.enabled ? t("common.disabled2") : t("common.enable"),
              onclick: () => void v.act(api.setRoutine(r.id, !r.enabled)),
            },
            h("i"),
          ),
          moreButton(t("common.more"), () => [
            ...(r.enabled && r.state !== "working"
              ? [{ label: t("common.checkNow"), run: () => void v.act(api.runRoutine(r.id)) }]
              : []),
            {
              label: t("desktop.routinesView.reportsTo", { p0: r.threadTitle || t("common.chat") }),
              run: () => v.hook.openThread(r.threadId),
            },
            {
              label: t("common.remove"),
              danger: true,
              run: () => {
                v.ui.removing = r.id;
                v.render();
              },
            },
          ]),
        ),
  );
  return row;
}

function draftCard(v: ConnectView, d: DraftView, early = false): HTMLElement {
  return h(
    "li",
    { class: "rt-draft" },
    h(
      "div",
      { class: "rt-draft-head" },
      h("span", { class: "rt-draft-title" }, d.title),
      h(
        "span",
        { class: "lb-meta" },
        early
          ? t("desktop.routinesView.draftsPreparedAhead")
          : t("common.drafted", { createdAt: ago(d.createdAt) }),
      ),
    ),
    d.target.to
      ? h(
          "div",
          { class: "lb-meta" },
          t("desktop.routinesView.to", {
            to: d.target.to,
            p1: d.target.subject ? t("desktop.routinesView.text2", { subject: d.target.subject }) : "",
          }),
        )
      : null,
    h("p", { class: "rt-draft-body" }, d.body),
    h(
      "div",
      { class: "rt-draft-actions" },
      h("span", { class: "cn-hint" }, t("desktop.routinesView.notSentYetUseThis")),
      h(
        "button",
        {
          class: "btn btn-quiet",
          type: "button",
          onclick: () => void v.act(v.client.discardDraft(d.id)),
        },
        t("common.discard"),
      ),
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: () =>
            void v.client.useDraft(d.id).then(
              (r) => v.hook.sendIn(r.threadId, r.text),
              (err) => v.hook.error(err),
            ),
        },
        t("common.useThis"),
      ),
    ),
  );
}

function newRoutineForm(v: ConnectView, list: RoutineList, s: ConnectorsStatus | undefined): HTMLElement {
  const accounts = (s?.groups ?? []).flatMap((g) =>
    g.accounts
      .filter((a) => a.status === "active")
      .map((a) => ({ app: g.toolkit, appName: g.app, label: a.label })),
  );
  const pollable = new Set(list.apps.map((a) => a.toolkit));
  const usable = accounts.filter((a) => pollable.has(a.app));
  if (!v.ui.creating)
    return h(
      "button",
      {
        class: "btn-link rt-new",
        type: "button",
        disabled: !usable.length,
        title: usable.length
          ? t("common.newRoutine")
          : t("desktop.routinesView.connectGmailOrGoogleCalendar"),
        onclick: () => {
          v.ui.creating = true;
          v.render();
        },
      },
      t("desktop.routinesView.newRoutine"),
      usable.length
        ? null
        : h("span", { class: "cn-hint" }, t("desktop.routinesView.connectGmailOrGoogleCalendar2")),
    );
  const field = (label: string, el: HTMLElement) =>
    h("label", { class: "rt-field" }, h("span", {}, label), el);
  const name = h("input", {
    class: "cn-input",
    name: "name",
    placeholder: t("desktop.routinesView.eGWorkMail"),
    maxlength: "80",
    required: true,
  });
  const source = h(
    "select",
    { class: "cn-input", name: "source" },
    ...usable.map((a) =>
      h(
        "option",
        { value: `${a.app}|${a.label}` },
        t("desktop.routinesView.text3", { appName: a.appName, label: a.label }),
      ),
    ),
  );
  const when = h(
    "select",
    { class: "cn-input", name: "when" },
    h("option", { value: "i900" }, t("desktop.routinesView.every15Minutes")),
    h("option", { value: "i3600" }, t("desktop.routinesView.hourly")),
    h("option", { value: "c0 9 * * 1-5" }, t("desktop.routinesView.weekdays0900")),
    h("option", { value: "c0 8 * * *" }, t("desktop.routinesView.daily0800")),
    h("option", { value: "c0 18 * * 5" }, t("desktop.routinesView.fridays1800")),
  );
  const instr = h("input", {
    class: "cn-input",
    name: "instructions",
    placeholder: t("desktop.routinesView.whatToWatchForE"),
    maxlength: "500",
  });
  const ahead = h("input", { type: "checkbox", name: "speculative", checked: true });
  const submit = (e: Event) => {
    e.preventDefault();
    const [app, account] = source.value.split("|");
    const w = when.value;
    const r: NewRoutine = {
      name: name.value.trim(),
      ...(w.startsWith("i")
        ? { kind: "interval" as const, intervalSec: Number(w.slice(1)) }
        : {
            kind: "cron" as const,
            cron: w.slice(1),
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei",
          }),
      check: { kind: "app", app: app ?? "gmail", ...(account ? { account } : {}) },
      instructions: instr.value.trim(),
      speculative: ahead.checked,
    };
    void v.act(v.client.createRoutine(r), () => (v.ui.creating = false));
  };
  return h(
    "form",
    { class: "rt-form", onsubmit: submit },
    h(
      "div",
      { class: "rt-form-grid" },
      field(t("common.name"), name),
      field(t("desktop.routinesView.whereToLook"), source),
      field(t("desktop.routinesView.howOftenToCheck"), when),
      field(t("common.instructions"), instr),
    ),
    h(
      "label",
      { class: "rt-check" },
      ahead,
      h("span", {}, t("desktop.routinesView.workAheadDraftRepliesTo")),
    ),
    h(
      "div",
      { class: "rt-form-actions" },
      h("span", { class: "cn-hint" }, t("desktop.routinesView.eachTimeCodeChecksFor")),
      h("code", {}, Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei"),
      h("span", { class: "lb-spacer" }),
      h(
        "button",
        {
          class: "btn btn-quiet cn-btn",
          type: "button",
          onclick: () => {
            v.ui.creating = false;
            v.render();
          },
        },
        t("common.cancel"),
      ),
      h("button", { class: "btn btn-primary cn-btn", type: "submit" }, t("desktop.routinesView.create")),
    ),
  );
}

/** §1.6: a read error leads with the tool that failed ("GMAIL_FETCH_EMAILS 讀取失敗：…");
 *  the row shows only the reason after it, the full text stays in the tooltip. */
export function plainError(msg: string): string {
  const m = /^\s*[A-Z][A-Z0-9_]{3,}[^：:]*[：:]\s*(.+)$/s.exec(msg);
  return m?.[1] ?? msg;
}

export function routinesTab(v: ConnectView, list: RoutineList, s: ConnectorsStatus | undefined): HTMLElement {
  const fromEarly = earlyDraftIds(list);
  return h(
    "div",
    {},
    h("h2", { class: "lb-page-title" }, t("common.routines")),
    h("p", { class: "lb-intro" }, t("desktop.routinesView.eachRunCodeFirstChecks")),
    list.drafts.length
      ? h(
          "section",
          { class: "lb-section" },
          h("h3", { class: "lb-h2" }, t("common.draftsPreparedAhead")),
          h("ul", { class: "rt-drafts" }, ...list.drafts.map((d) => draftCard(v, d, fromEarly.has(d.id)))),
        )
      : null,
    earlySection(list),
    h(
      "section",
      { class: "lb-section" },
      list.drafts.length || list.early?.length
        ? h("h3", { class: "lb-h2" }, t("desktop.routinesView.yourRoutines"))
        : null,
      list.routines.length
        ? h("ul", { class: "lb-list rt-list" }, ...list.routines.map((r) => routineCard(v, r)))
        : h("p", { class: "lb-empty" }, t("desktop.routinesView.noRoutinesYet")),
      newRoutineForm(v, list, s),
    ),
  );
}
