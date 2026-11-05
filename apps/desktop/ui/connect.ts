// 連接: the apps Alca may use through Composio (the person's own key), per
// account and per bot, and the 例行工作 that watch them. OAuth tokens live at
// Composio (the person accepted that); the key and everything else stay here.
import type { Api } from "./api.ts";
import {
  CLASS_WORD,
  type ConnectApi,
  type ConnectorsStatus,
  connectApi,
  KEY_STORE,
  type RoutineList,
} from "./api-connect.ts";
import { accountRow } from "./connect-accounts.ts";
import { directSection } from "./connect-direct.ts";
import { h, renderPage } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { icon as plainIcon } from "./icons.ts";
import { routinesTab } from "./routines-view.ts";
import type { SiteLoginView } from "./site-logins-model.ts";
import { siteLoginsSection } from "./site-logins-view.ts";

export type ConnectTab = "apps" | "routines";

export interface ConnectHooks {
  changed(open: boolean): void;
  /** Routines that need a look (sidebar badge). */
  attention(n: number): void;
  openThread(id: string): void;
  /** Send a message in a chat (using a draft is a new, confirmed request). */
  sendIn(threadId: string, text: string): void;
  error(err: unknown): void;
}

const NS = "http://www.w3.org/2000/svg";
function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  svg.append(p);
  return svg;
}
export const ICON = {
  close: "M5.5 5.5l9 9M14.5 5.5l-9 9",
  key: "M10.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM9.5 10.5l6.5 6.5M13 14l1.75-1.75M15 16l1.5-1.5",
  plus: "M10 4.5v11M4.5 10h11",
  open: "M11.5 4.5h4v4M15.5 4.5 9 11M13.5 11.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3",
  refresh: "M15.5 9.5a5.5 5.5 0 1 1-1.6-3.9M15.5 4.5v3h-3",
};

/** An app's mark: a neutral outline icon on --fill, never a letter or kanji tile (§2.8). */
export function appMark(toolkit: string): HTMLElement {
  const name =
    toolkit === "gmail"
      ? "mail"
      : toolkit === "googlecalendar"
        ? "calendar"
        : toolkit === "mcp"
          ? "server"
          : "link";
  return h("span", { class: "cn-mark", "data-app": toolkit, "aria-hidden": "true" }, plainIcon(name));
}

export const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: tx("common.connected"), tone: "ok" },
  pending: { label: tx("common.waitingForAuthorization"), tone: "guess" },
  failed: { label: tx("common.connectionFailed"), tone: "danger" },
  expired: { label: tx("common.authorizationExpired"), tone: "danger" },
};

export class ConnectView {
  private readonly root: HTMLElement;
  readonly api: ConnectApi;
  private readonly hooks: ConnectHooks;
  private tab: ConnectTab = "apps";
  private status: ConnectorsStatus | undefined;
  private routines: RoutineList | undefined;
  private logins: SiteLoginView[] | undefined;
  /** 網站登入: the add form is open / which row asks before removing. */
  loginAdding = false;
  loginRemoving: string | undefined;
  adding: string | undefined;
  confirming: string | undefined;
  renaming: string | undefined;
  private keyEditing = false;
  private notice: string | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  /** UI state the routines tab keeps between renders. */
  readonly ui = { creating: false, removing: undefined as string | undefined };
  isOpen = false;

  constructor(root: HTMLElement, api: Api, hooks: ConnectHooks) {
    this.root = root;
    this.api = connectApi(api);
    this.hooks = hooks;
  }

  async open(tab: ConnectTab = this.tab): Promise<void> {
    this.tab = tab;
    this.isOpen = true;
    this.root.hidden = false;
    this.hooks.changed(true);
    await this.refresh(true);
  }

  close(): void {
    this.isOpen = false;
    this.root.hidden = true;
    this.stopPolling();
    this.hooks.changed(false);
  }

  toggle(tab: ConnectTab): void {
    if (this.isOpen && this.tab === tab) this.close();
    else if (this.isOpen) {
      this.tab = tab;
      this.render();
      this.hooks.changed(true);
    } else void this.open(tab);
  }

  /** Agents channel: connector / routine / draft events keep this view fresh. */
  onAgentsEvent(type: string): void {
    if (type === "routine.checked" || type === "draft.ready" || type === "connector.changed") {
      if (this.isOpen && !this.adding && !this.renaming) void this.refresh(false);
      else void this.counts();
    }
  }

  async counts(): Promise<void> {
    const r = await this.api.routines().catch(() => undefined);
    if (!r) return;
    this.routines = r;
    this.hooks.attention(r.routines.filter((x) => x.state === "error").length + r.drafts.length);
  }

  async refresh(remote = true): Promise<void> {
    try {
      const [s, r, l] = await Promise.all([
        this.api.status(remote),
        this.api.routines().catch(() => undefined),
        this.api.logins().catch(() => undefined),
      ]);
      this.status = s;
      if (r) this.routines = r;
      if (l) this.logins = l;
      this.hooks.attention(
        (r?.routines.filter((x) => x.state === "error").length ?? 0) + (r?.drafts.length ?? 0),
      );
      this.render();
    } catch (err) {
      this.hooks.error(err);
    }
  }

  act(p: Promise<unknown>, after?: () => void): Promise<void> {
    return p.then(
      () => {
        after?.();
        return this.refresh(false);
      },
      (err) => {
        this.notice = String((err as Error)?.message ?? err);
        this.render();
      },
    );
  }

  get currentTab(): ConnectTab {
    return this.tab;
  }

  get client(): ConnectApi {
    return this.api;
  }
  get hook(): ConnectHooks {
    return this.hooks;
  }
  get state(): ConnectorsStatus | undefined {
    return this.status;
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  /** After a Connect Link opens: look again every few seconds until the account is active (2 min). */
  private watchPending(): void {
    this.stopPolling();
    const until = Date.now() + 120_000;
    this.poll = setInterval(() => {
      const pending = this.status?.groups.some((g) => g.accounts.some((a) => a.status === "pending"));
      if (!pending || Date.now() > until || !this.isOpen) return this.stopPolling();
      void this.api.refresh().then(
        (s) => {
          this.status = s;
          if (!this.adding && !this.renaming) this.render();
        },
        () => undefined,
      );
    }, 3000);
  }

  // ── render ─────────────────────────────────────────────────

  render(): void {
    const s = this.status;
    const r = this.routines;
    // §4.2: 連接 and 例行工作 are two pages (two sidebar rows), not tabs with counts.
    const head = h(
      "header",
      { class: "lb-head" },
      h("h1", { class: "lb-title" }, this.tab === "apps" ? tx("common.connections") : tx("common.routines")),
      h("span", { class: "lb-spacer" }),
      h(
        "button",
        {
          class: "tool-btn",
          type: "button",
          "aria-label": tx("common.close"),
          title: tx("common.backToChat"),
          onclick: () => this.close(),
        },
        plainIcon("cross"),
      ),
    );
    const body =
      this.tab === "apps"
        ? this.appsTab()
        : routinesTab(this, r ?? { routines: [], drafts: [], apps: [] }, s);
    const note = this.notice
      ? h(
          "p",
          { class: "cn-notice", role: "alert" },
          this.notice,
          h(
            "button",
            {
              class: "lb-act",
              type: "button",
              onclick: () => {
                this.notice = undefined;
                this.render();
              },
            },
            tx("common.gotIt"),
          ),
        )
      : null;
    renderPage(this.root, this.tab, head, h("div", { class: "lb-inner" }, note, body));
  }

  private appsTab(): HTMLElement {
    const s = this.status;
    if (!s) return h("p", { class: "lb-intro" }, tx("common.loading2"));
    const groups = s.groups.map((g) =>
      h(
        "section",
        { class: "lb-section cn-group" },
        h("h3", { class: "lb-h2" }, g.app),
        h("ul", { class: "lb-list" }, ...g.accounts.map((a) => accountRow(this, a, s))),
      ),
    );
    return h(
      "div",
      {},
      h("h2", { class: "lb-page-title" }, tx("common.connections")),
      h("p", { class: "lb-intro" }, tx("desktop.connect.intro")),
      s.keySet ? null : this.keyCard(s),
      ...groups,
      this.addApps(s),
      directSection(this, s),
      siteLoginsSection(this, this.logins, s),
      s.keySet ? this.usage(s) : null,
      // §5.3: the connection service (Composio), its key and where it is stored live in 技術細節.
      s.keySet
        ? h(
            "details",
            { class: "tech cn-tech", ...(this.keyEditing ? { open: true } : {}) },
            h("summary", {}, tx("common.technicalDetails")),
            h(
              "p",
              { class: "cn-hint" },
              tx("desktop.connect.service"),
              tx("common.joinColon"),
              tx("desktop.connect.composioConnected"),
            ),
            this.keyCard(s),
          )
        : null,
    );
  }

  private keyCard(s: ConnectorsStatus): HTMLElement {
    if (s.keySet && !this.keyEditing)
      return h(
        "div",
        { class: "cn-key", "data-set": "true" },
        h("span", { class: "lb-glyph" }, icon(ICON.key)),
        h(
          "div",
          { class: "lb-main" },
          h("div", { class: "cn-key-title" }, "Composio API key", h("code", {}, s.keyPreview ?? "")),
          h(
            "div",
            { class: "lb-meta" },
            tx("desktop.connect.storedInOnlyThisComputers", {
              p0: KEY_STORE[s.keyStore] ?? tx("desktop.connect.local"),
            }),
          ),
        ),
        h(
          "div",
          { class: "lb-actions" },
          h(
            "button",
            {
              class: "lb-act",
              type: "button",
              onclick: () => {
                this.keyEditing = true;
                this.render();
              },
            },
            tx("common.replace"),
          ),
          h(
            "button",
            {
              class: "lb-act",
              "data-tone": "danger",
              type: "button",
              onclick: () => void this.act(this.api.clearKey()),
            },
            tx("common.remove"),
          ),
        ),
      );
    const input = h("input", {
      class: "cn-input",
      type: "password",
      placeholder: tx("desktop.connect.pasteYourComposioApiKey"),
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Composio API key",
    });
    const save = (e: Event) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      void this.act(this.api.setKey(v), () => (this.keyEditing = false));
    };
    return h(
      "form",
      { class: "cn-key", onsubmit: save },
      h("span", { class: "lb-glyph" }, icon(ICON.key)),
      h(
        "div",
        { class: "lb-main" },
        h(
          "div",
          { class: "cn-key-title" },
          s.keySet
            ? tx("desktop.connect.useADifferentComposioApi")
            : tx("desktop.connect.addYourComposioApiKey"),
        ),
        h("div", { class: "lb-meta" }, tx("desktop.connect.createOneUnderProjectSettings")),
        h(
          "div",
          { class: "cn-key-row" },
          input,
          h(
            "button",
            { class: "btn btn-primary cn-btn", type: "submit" },
            tx("desktop.connect.verifyAndSave"),
          ),
          s.keySet
            ? h(
                "button",
                {
                  class: "btn btn-quiet cn-btn",
                  type: "button",
                  onclick: () => {
                    this.keyEditing = false;
                    this.render();
                  },
                },
                tx("common.cancel"),
              )
            : null,
        ),
      ),
    );
  }

  /** 每日上限 as value rows (§4.1 connectors), not chips. */
  private usage(s: ConnectorsStatus): HTMLElement {
    const order = ["send", "publish", "delete", "payment"];
    return h(
      "section",
      { class: "lb-section", title: tx("desktop.connect.howManyTimesADay") },
      h("h3", { class: "lb-h2" }, tx("desktop.connect.dailyLimits")),
      h(
        "div",
        { class: "form-group" },
        ...order.map((c) => {
          const used = s.usageToday[c] ?? 0;
          const max = s.quota[c] ?? 0;
          return h(
            "div",
            { class: "form-row cn-quota-row", "data-off": max === 0 ? "true" : "false" },
            h("span", { class: "form-label" }, CLASS_WORD[c] ?? c),
            h(
              "span",
              { class: "form-value" },
              max === 0 ? tx("common.notAllowed") : tx("desktop.connect.usedOf", { used, max }),
            ),
          );
        }),
      ),
    );
  }

  private addApps(s: ConnectorsStatus): HTMLElement {
    const cards = s.apps.map((app) => {
      const open = this.adding === app.toolkit;
      const form = open
        ? h(
            "form",
            {
              class: "cn-add-form",
              onsubmit: (e: Event) => {
                e.preventDefault();
                const v = (
                  (e.target as HTMLFormElement).elements.namedItem("label") as HTMLInputElement
                ).value.trim();
                if (!v) return;
                // Open the tab synchronously (popup rules), then point it at the Connect Link.
                const tab = window.open("about:blank", "_blank");
                if (tab) tab.opener = null; // the sign-in page gets no handle on this window
                void this.api.connect(app.toolkit, v).then(
                  (r) => {
                    if (tab) tab.location.href = r.redirectUrl;
                    else window.open(r.redirectUrl, "_blank", "noopener");
                    this.adding = undefined;
                    void this.refresh(false).then(() => this.watchPending());
                  },
                  (err) => {
                    tab?.close();
                    this.notice = String((err as Error)?.message ?? err);
                    this.render();
                  },
                );
              },
            },
            h("input", {
              class: "cn-input",
              name: "label",
              placeholder: tx("desktop.connect.accountNameEGWork"),
              maxlength: "60",
              "aria-label": tx("desktop.connect.accountName", { name: app.name }),
              autofocus: true,
            }),
            h(
              "button",
              { class: "btn btn-primary cn-btn", type: "submit" },
              tx("desktop.connect.goAuthorize"),
            ),
            h(
              "button",
              {
                class: "btn btn-quiet cn-btn",
                type: "button",
                onclick: () => {
                  this.adding = undefined;
                  this.render();
                },
              },
              tx("common.cancel"),
            ),
          )
        : null;
      return h(
        "li",
        { class: "lb-row cn-app", "data-open": open ? "true" : "false" },
        appMark(app.toolkit),
        h(
          "div",
          { class: "lb-main" },
          h("p", { class: "lb-body" }, app.name),
          h("p", { class: "lb-meta" }, app.blurb),
          form,
        ),
        open
          ? null
          : h(
              "button",
              {
                class: "btn cn-app-add",
                type: "button",
                disabled: !s.keySet,
                title: s.keySet
                  ? tx("desktop.connect.connectAAccount", { name: app.name })
                  : tx("desktop.connect.addAComposioApiKey"),
                onclick: () => {
                  this.adding = app.toolkit;
                  this.render();
                },
              },
              tx("desktop.connect.connectEllipsis"),
            ),
      );
    });
    return h(
      "section",
      { class: "lb-section cn-group" },
      h(
        "h3",
        { class: "lb-h2", title: tx("desktop.connect.oneAppCanHaveSeveral") },
        tx("desktop.connect.addApp"),
      ),
      h("ul", { class: "lb-list cn-apps" }, ...cards),
    );
  }
}
