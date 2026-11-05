// 資料庫 › 連接 and 進行中 › 例行工作 (§4.1 phone-connectors / phone-routines):
// pushed pages. 連接: one section per app with its accounts (state as the
// trailing value), 網站登入, 新增帳號, and 每日上限 as value rows. An account
// opens its own page where each bot's access is a menu row (不能用 / 只讀 /
// 可操作) and 中斷連線 is a red row. 例行工作: drafts to review on top, then
// one row per routine with its switch; a routine opens its details. Reading
// needs `chat`; every change needs `approve`. Composio is named only in 技術細節.
import {
  ACCESS,
  ACCOUNT_STATUS,
  type Access,
  type AccountView,
  type ConnectStatus,
  type DraftView,
  nextLook,
  type PhoneSiteLogin,
  phoneLogins,
  QUOTA_WORD,
  ROUTINE_STATE,
  type RoutineList,
  type RoutineView,
  RUN_WORD,
} from "./connect-view.ts";
import { ago, h, haptic, icon } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { openRoutineForm } from "./routine-form.ts";
import type { Session } from "./session.ts";
import { actionSheet, closeAll, pick, Sheet } from "./sheet.ts";
import { loginsGroup } from "./site-logins.ts";
import { toast } from "./toast.ts";
import { emptyState, group, row, statusIcon, switchEl, switchRow, techDetails } from "./ui.ts";

export type ConnectTab = "apps" | "routines";

const since = (iso: string) => ago(iso);
const TONE: Record<string, "success" | "waiting" | "danger" | undefined> = {
  ok: "success",
  attention: "waiting",
  danger: "danger",
};

interface Data {
  st?: ConnectStatus;
  list?: RoutineList;
  logins?: PhoneSiteLogin[];
  failed?: string;
}

async function loadAll(s: Session): Promise<Data> {
  const req = <T>(op: string) => s.client.request<T>(op, {});
  try {
    const [st, list, logins] = await Promise.all([
      req<ConnectStatus>("connectors.status"),
      req<RoutineList>("routines.list").catch(() => undefined),
      req<unknown>("connectors.logins").then(phoneLogins, () => undefined),
    ]);
    return { st, list: list ?? { routines: [], drafts: [] }, ...(logins ? { logins } : {}) };
  } catch (e) {
    return { failed: e instanceof Error ? e.message : tx("phone.connect.cantReadConnectionStatus") };
  }
}

const act = async (work: Promise<unknown>, done?: string) => {
  try {
    await work;
    if (done) toast(done);
    haptic("success");
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : tx("common.notChanged"));
    haptic("warn");
    return false;
  }
};

/** One account: who may use it (menu rows), its triggers, 中斷連線. */
function openAccount(s: Session, start: AccountView, reload: () => Promise<Data>): Sheet {
  let a = start;
  const can = s.can("approve");
  const body = h("div", { class: "account-page" });
  let sheet!: Sheet;
  const rank = (k: string) => (k === "act" ? 2 : k === "read" ? 1 : 0);
  // Next round R8: on MCP accounts the phone can only lower access.
  const tightenOnly = !!a.provider && a.provider !== "composio";
  const paint = () => {
    const status = ACCOUNT_STATUS[a.status] ?? { label: a.status };
    const triggers = a.triggers.filter((x) => x.status !== "removed");
    body.replaceChildren(
      group({
        rows: [
          row({
            lead: h("span", { class: "row-av", "data-size": "28", "aria-hidden": "true" }, a.mark),
            title: a.label,
            sub: a.identity || null,
            value: status.label,
            valueTone: TONE[status.tone ?? ""],
          }),
        ],
        footer: a.status === "pending" ? tx("phone.connect.finishAuthorizingOnTheComposio") : null,
      }),
      group({
        header: tx("phone.connect.whoMayUse"),
        rows: a.bots.map((b) => {
          const cur = b.access ?? "none";
          return row({
            title: b.name,
            value: ACCESS.find((x) => x[0] === cur)?.[1] ?? "",
            chevron: can && a.status === "active",
            ...(can && a.status === "active"
              ? {
                  onclick: () =>
                    pick({
                      label: tx("phone.connect.howCanUse", { name: b.name, label: a.label }),
                      title: tx("phone.connect.howCanUse", { name: b.name, label: a.label }),
                      options: ACCESS.filter(([k]) => !tightenOnly || rank(k) <= rank(cur)),
                      current: cur,
                      onPick: async (k) => {
                        const access: Access = k === "none" ? null : k;
                        if (
                          await act(
                            s.client.request("connectors.grant", { accountId: a.id, botId: b.botId, access }),
                          )
                        )
                          a = { ...a, bots: a.bots.map((x) => (x.botId === b.botId ? { ...x, access } : x)) };
                        paint();
                      },
                    }),
                }
              : {}),
          });
        }),
        footer: tightenOnly ? tx("phone.connect.toLoosenItUseThe") : null,
      }),
      triggers.length
        ? group({
            header: tx("phone.connect.wakes"),
            rows: triggers.map((x) => row({ title: x.name })),
          })
        : "",
      can
        ? group({
            rows: [
              row({
                title: tx("common.disconnect"),
                tone: "danger",
                center: true,
                onclick: () =>
                  actionSheet({
                    label: tx("common.disconnect2"),
                    title: tx("phone.connect.disconnect", { label: a.label }),
                    message: tx("phone.connect.alcaDeletesThisAccountsGrant"),
                    actions: [
                      {
                        label: tx("common.disconnect2"),
                        tone: "danger",
                        run: async () => {
                          await s.client.request("connectors.disconnect", { accountId: a.id });
                          toast(tx("phone.connect.disconnected", { label: a.label }));
                          await reload();
                          sheet.close();
                        },
                      },
                    ],
                  }),
              }),
            ],
          })
        : "",
      techDetails([
        [tx("phone.connect.techAccount"), a.id],
        [tx("phone.connect.techToolkit"), a.toolkit],
        [tx("phone.connect.techProvider"), a.provider ?? "composio"],
        [tx("phone.connect.techTriggers"), triggers.map((x) => x.slug).join("\n")],
        [tx("phone.connect.techSince"), a.createdAt],
      ]),
    );
  };
  paint();
  sheet = new Sheet(body, {
    label: a.label,
    size: "page",
    nav: { title: a.app, back: tx("common.connections") },
  });
  return sheet;
}

export function openConnect(s: Session, first: ConnectTab = "apps"): Sheet {
  return first === "routines" ? routinesPage(s) : appsPage(s);
}

function appsPage(s: Session): Sheet {
  const can = s.can("approve");
  const body = h("div", { class: "connect-page" });
  let d: Data = {};
  const reload = async () => {
    d = await loadAll(s);
    paint();
    return d;
  };
  const connectApp = async (toolkit: string, name: string, n: number) => {
    const label = n ? `${name} ${n + 1}` : name;
    // Open the window first (inside the tap), then point it at the Connect Link.
    const win = window.open("about:blank", "_blank");
    if (win) win.opener = null; // the sign-in page gets no handle on the app
    try {
      const r = await s.client.request<{ redirectUrl: string }>("connectors.connect", { toolkit, label });
      if (win) win.location.href = r.redirectUrl;
      else location.assign(r.redirectUrl);
      toast(tx("phone.connect.signInToOnThe", { name }));
    } catch (e) {
      win?.close();
      toast(e instanceof Error ? e.message : tx("phone.connect.connectionNotStarted"));
    }
    await reload();
  };
  const paint = () => {
    const st = d.st;
    if (!st) {
      body.replaceChildren(emptyState(d.failed ?? tx("common.loading2")));
      return;
    }
    const counts = new Map(st.groups.map((g) => [g.toolkit, g.accounts.length]));
    const quota = Object.keys(QUOTA_WORD).filter((k) => k in st.quota);
    body.replaceChildren(
      st.keySet ? "" : h("p", { class: "fine connect-note" }, tx("phone.connect.notSetUp")),
      ...st.groups.map((g) =>
        group({
          header: g.app,
          rows: g.accounts.map((a) => {
            const status = ACCOUNT_STATUS[a.status] ?? { label: a.status };
            return row({
              lead: h("span", { class: "row-av", "data-size": "28", "aria-hidden": "true" }, g.mark),
              title: a.label,
              sub: a.identity || null,
              value: a.status === "active" ? null : status.label,
              valueTone: TONE[status.tone ?? ""],
              chevron: true,
              onclick: () => openAccount(s, a, reload),
              attrs: { "data-account": a.id },
            });
          }),
        }),
      ),
      st.groups.length
        ? ""
        : emptyState(tx("phone.connect.noAppsTitle"), tx("phone.connect.noAppsConnectedYet")),
      ...(d.logins
        ? [
            loginsGroup(d.logins, {
              can,
              remove: (loginId) => s.client.request("connectors.logins.remove", { loginId }),
              toast,
              reload: async () => void (await reload()),
            }),
          ]
        : []),
      can && st.keySet
        ? group({
            header: tx("phone.connect.addAccount"),
            rows: st.apps.map((a) =>
              row({
                lead: h("span", { class: "row-av", "data-size": "28", "aria-hidden": "true" }, a.mark),
                title: a.name,
                sub: a.blurb,
                value: h("span", { class: "row-add", "aria-hidden": "true" }, icon("plus", 20)),
                onclick: () => void connectApp(a.toolkit, a.name, counts.get(a.toolkit) ?? 0),
              }),
            ),
          })
        : "",
      quota.length
        ? group({
            header: tx("phone.connect.dailyLimits"),
            rows: quota.map((k) => {
              const limit = st.quota[k] ?? 0;
              return row({
                title: QUOTA_WORD[k] ?? k,
                value:
                  limit > 0
                    ? tx("phone.connect.usedOf", { used: st.usageToday[k] ?? 0, limit })
                    : tx("common.notAllowed"),
              });
            }),
            footer: tx("phone.connect.dailyLimitsFooter"),
          })
        : "",
      h(
        "p",
        { class: "fine" },
        can ? tx("phone.connect.grantsFooter") : tx("phone.connect.thisPhoneDoesntHaveThe"),
      ),
      techDetails([
        [tx("phone.connect.techService"), "Composio"],
        [
          tx("phone.connect.techKey"),
          st.keySet ? tx("phone.connect.keySet") : tx("phone.connect.keyMissing"),
        ],
        [tx("phone.connect.techError"), st.error],
      ]),
    );
  };
  const refresh = h(
    "button",
    {
      class: "icon-btn",
      type: "button",
      "aria-label": tx("common.refresh"),
      onclick: async () => {
        haptic("tap");
        await act(s.client.request("connectors.refresh", {}));
        await reload();
      },
    },
    icon("refresh", 22),
  );
  const off = s.subscribe((w) => (w === "connectors" || w === "scopes") && void reload());
  paint();
  void reload();
  return new Sheet(body, {
    label: tx("common.connections"),
    size: "page",
    nav: { back: tx("phone.ui.tabLibrary"), trailing: refresh },
    onClose: off,
  });
}

/** A draft a routine prepared ahead: what it says, 使用 / 捨棄. */
function draftRow(s: Session, d: DraftView, reload: () => Promise<unknown>): HTMLElement {
  return row({
    lead: statusIcon("waiting"),
    title: d.title,
    sub: d.target.to ? tx("phone.connect.to", { to: d.target.to }) : d.body.slice(0, 80),
    chevron: true,
    onclick: () => openDraft(s, d, reload),
  });
}

function openDraft(s: Session, d: DraftView, reload: () => Promise<unknown>): Sheet {
  let sheet!: Sheet;
  const use = h("button", { class: "btn big primary", type: "button" }, tx("common.useThis"));
  use.addEventListener("click", async () => {
    haptic("tap");
    use.disabled = true;
    try {
      const r = await s.client.request<{ threadId: string; text: string }>("drafts.use", { draftId: d.id });
      closeAll();
      await s.openThread(r.threadId);
      await s.send(r.text);
    } catch (e) {
      use.disabled = false;
      toast(e instanceof Error ? e.message : tx("phone.connect.thisDraftWasntUsed"));
    }
  });
  const discard = h(
    "button",
    { class: "btn big secondary", type: "button", "data-tone": "danger" },
    tx("common.discard"),
  );
  discard.addEventListener("click", async () => {
    if (
      await act(s.client.request("drafts.discard", { draftId: d.id }), tx("phone.connect.draftDiscarded"))
    ) {
      await reload();
      sheet.close();
    }
  });
  sheet = new Sheet(
    h(
      "div",
      { class: "draft-page" },
      h(
        "header",
        { class: "task-head" },
        h("p", { class: "ap-eyebrow" }, tx("common.draft")),
        h("h1", { class: "task-title" }, d.title),
      ),
      group({
        rows: [
          d.target.to ? row({ title: tx("phone.cards.recipient"), value: d.target.to }) : null,
          d.target.subject ? row({ title: tx("phone.cards.subject"), value: d.target.subject }) : null,
          row({ title: tx("phone.connect.prepared"), value: since(d.createdAt) }),
        ],
      }),
      h("div", { class: "task-result-text draft-body" }, d.body),
      h("p", { class: "fine" }, tx("phone.connect.notSentYetUseThis")),
      h("div", { class: "ap-actions draft-actions" }, use, discard),
    ),
    { label: d.title, size: "page", nav: { title: "", back: tx("common.routines") } },
  );
  return sheet;
}

function openRoutine(s: Session, r: RoutineView, reload: () => Promise<unknown>): Sheet {
  const can = s.can("approve");
  const state = ROUTINE_STATE[r.state];
  const next = r.enabled && r.kind !== "trigger" ? nextLook(r.nextAt, r.backoffUntil) : "";
  const sheet = new Sheet(
    h(
      "div",
      { class: "routine-page" },
      h(
        "header",
        { class: "task-head" },
        h("h1", { class: "task-title" }, r.name),
        h(
          "p",
          { class: "task-status", "data-tone": r.state === "error" ? "danger" : undefined },
          state.label,
        ),
      ),
      group({
        rows: [
          row({ title: tx("phone.connect.when"), value: r.schedule }),
          row({ title: tx("phone.connect.checks"), sub: r.check }),
          row({
            title: tx("phone.connect.lastChecked"),
            value: r.lastCheckedAt ? since(r.lastCheckedAt) : tx("common.notCheckedYet"),
          }),
          next ? row({ title: tx("phone.connect.nextCheck"), value: next }) : null,
          r.speculative ? row({ title: tx("common.workAhead"), value: tx("phone.settings.allowed") }) : null,
        ],
      }),
      r.state === "error" && r.lastError
        ? group({
            header: tx("phone.connect.cantRead"),
            rows: [row({ lead: statusIcon("failed"), title: r.lastError })],
            footer: tx("phone.connect.progressIsKeptNothingWill"),
          })
        : "",
      r.runs.length
        ? group({
            header: tx("phone.connect.recent"),
            rows: r.runs.slice(0, 5).map((x) =>
              row({
                lead: statusIcon(
                  x.outcome === "read_failed" || x.outcome === "ai_failed" || x.outcome === "ai_invalid"
                    ? "failed"
                    : x.outcome === "new" || x.outcome === "ai_done"
                      ? "done"
                      : "stopped",
                ),
                title: `${RUN_WORD[x.outcome] ?? x.outcome}${x.items ? tx("common.items", { items: x.items }) : ""}`,
                sub: x.detail && x.outcome !== "read_failed" ? x.detail : null,
                value: since(x.at),
              }),
            ),
          })
        : "",
      group({
        rows: [
          row({
            title: tx("phone.connect.seeTheReport"),
            tone: "accent",
            onclick: async () => {
              closeAll();
              await s.openThread(r.threadId);
            },
          }),
          can && r.enabled && r.state !== "working"
            ? row({
                title: tx("common.checkNow"),
                tone: "accent",
                onclick: async () => {
                  await act(s.client.request("routines.run", { routineId: r.id }), tx("phone.connect.seen"));
                  await reload();
                },
              })
            : null,
        ],
      }),
      techDetails([
        [tx("phone.connect.techRoutine"), r.id],
        [tx("phone.connect.techKind"), r.kind],
        [tx("phone.connect.techInstructions"), r.instructions],
        [tx("phone.connect.techThread"), r.threadId],
      ]),
    ),
    { label: r.name, size: "page", nav: { title: "", back: tx("common.routines") } },
  );
  return sheet;
}

function routinesPage(s: Session): Sheet {
  const can = s.can("approve");
  const body = h("div", { class: "routines-page" });
  let d: Data = {};
  const reload = async () => {
    d = await loadAll(s);
    paint();
    return d;
  };
  const routineRow = (r: RoutineView) => {
    const state = ROUTINE_STATE[r.state];
    const sw = switchEl(
      r.enabled,
      tx("common.text5", { p0: tx("common.enable"), name: r.name }),
      async (on, el) => {
        haptic("tap");
        if (!(await act(s.client.request("routines.enable", { routineId: r.id, enabled: on }))))
          el.checked = !on;
        await reload();
      },
    );
    sw.disabled = !can;
    const el = switchRow({
      title: r.name,
      sub: r.state === "error" ? state.label : r.schedule,
      subTone: r.state === "error" ? "danger" : undefined,
      sw,
    });
    el.classList.add("tappable");
    el.dataset.routine = r.id;
    el.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("input")) openRoutine(s, r, reload);
    });
    return el;
  };
  const add = h(
    "button",
    {
      class: "icon-btn",
      type: "button",
      "aria-label": tx("common.newRoutine"),
      hidden: true,
      onclick: () => {
        haptic("tap");
        if (d.list)
          openRoutineForm(
            s,
            d.list,
            d.st,
            () => void reload().then(() => toast(tx("phone.connect.routineAdded"))),
          );
      },
    },
    icon("plus", 24),
  );
  const paint = () => {
    const list = d.list;
    add.hidden = !(can && list?.apps?.length);
    if (!list) {
      body.replaceChildren(emptyState(d.failed ?? tx("common.loading2")));
      return;
    }
    body.replaceChildren(
      list.drafts.length
        ? group({
            header: tx("phone.connect.draftsHeader"),
            rows: list.drafts.map((x) => draftRow(s, x, reload)),
          })
        : "",
      list.routines.length
        ? group({ rows: list.routines.map(routineRow), footer: tx("phone.connect.eachTimeCodeChecksFor") })
        : emptyState(
            tx("phone.connect.noRoutinesTitle"),
            can ? tx("phone.connect.noRoutinesYetForExample") : tx("phone.connect.noRoutinesYetAddOne"),
          ),
    );
  };
  const off = s.subscribe((w) => (w === "connectors" || w === "scopes") && void reload());
  paint();
  void reload();
  return new Sheet(body, {
    label: tx("common.routines"),
    size: "page",
    nav: { back: tx("phone.ui.tabActivity"), trailing: add },
    onClose: off,
  });
}
