// 團隊 (P7): who is on the team and what each bot is doing, the team's
// collaboration rules, and the bot-to-bot trail (who asked whom, what the
// person approved, the teammate's conversation). Simple first: a bot is a
// name and a role; everything else sits behind 進階 in the editor.
import type { Api } from "./api.ts";
import { providersApi } from "./api-providers.ts";
import {
  type EngineChoice,
  LEVEL_WORD,
  type Peer,
  type Team,
  type TeamBot,
  type TeamClient,
  teamApi,
} from "./api-team.ts";
import { BotEditor } from "./bot-edit.ts";
import { ago, h, renderPage } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { icon as plainIcon } from "./icons.ts";
import { moreButton } from "./menu.ts";
import { activity } from "./team-activity.ts";

export type TeamTab = "members" | "activity";

export interface TeamHooks {
  changed(open: boolean): void;
  openThread(id: string): void;
  /** Start talking to one bot (a new conversation addressed to it). */
  talkTo(botId: string): void;
  /** The roster changed (sidebar avatars, composer @mentions). */
  roster(team: Team): void;
  error(err: unknown): void;
}

const NS = "http://www.w3.org/2000/svg";
export function icon(d: string): SVGSVGElement {
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
  plus: "M10 4.5v11M4.5 10h11",
  chat: "M4.5 5.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H9l-3.5 2.5V13.5h-1a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z",
  edit: "m12.8 4.2 3 3-7.6 7.6-3.6.6.6-3.6zM11.3 5.7l3 3",
  arrow: "M4.5 10h11M11.5 6l4 4-4 4",
};

const BROWSER_WORD: Record<string, string> = {
  shared: tx("common.signInWithYourBrowser"),
  isolated: tx("common.separateBrowser"),
  isolated_keep: tx("desktop.team.separateBrowserKeepSignIns"),
};
const MEMORY_WORD: Record<string, string> = {
  team: tx("desktop.team.sharedMemory"),
  own: tx("common.ownMemoryOnly"),
  off: tx("common.noMemory"),
};
export const EVENT_WORD: Record<string, string> = {
  requested: tx("common.requestSent"),
  approval: tx("common.waitingForYourOk"),
  approved: tx("common.youAgreed"),
  denied: tx("common.youDeclined"),
  refused: tx("common.notSent"),
  started: tx("common.teammateStarted"),
  card: tx("common.needsYourConfirmation"),
  answered: tx("common.teammateReplied"),
  failed: tx("common.notFinished"),
  stopped: tx("common.stopped4"),
};

/** A bot's avatar tile. */
export function botAvatar(
  b: Pick<TeamBot, "avatar" | "color" | "name">,
  size: "sm" | "md" | "lg" = "md",
): HTMLElement {
  return h(
    "span",
    { class: "bot-av", "data-size": size, "data-tone": b.color ?? "ink", "aria-hidden": "true" },
    b.avatar || "?",
  );
}

export class TeamView {
  private readonly root: HTMLElement;
  readonly client: TeamClient;
  readonly hooks: TeamHooks;
  private readonly editor: BotEditor;
  private tab: TeamTab = "members";
  private data: Team | undefined;
  peers: Peer[] = [];
  selected: string | undefined;
  detail: Peer | undefined;
  private notice: string | undefined;
  private refreshSoon: ReturnType<typeof setTimeout> | undefined;
  isOpen = false;

  constructor(root: HTMLElement, api: Api, hooks: TeamHooks, connect: { open(): void }) {
    this.root = root;
    this.client = teamApi(api);
    this.hooks = hooks;
    this.editor = new BotEditor(this.client, providersApi(api), {
      saved: () => void this.refresh(),
      error: (e) => hooks.error(e),
      openConnect: () => {
        this.close();
        connect.open();
      },
    });
  }

  /** 模型與供應商 opens from the bot editor's 管理供應商 link. */
  useProviders(open: () => void): void {
    this.editor.openProviders = () => {
      this.editor.close();
      open();
    };
  }

  get team(): Team | undefined {
    return this.data;
  }

  get currentTab(): TeamTab {
    return this.tab;
  }

  async open(tab: TeamTab = this.tab, focus?: string): Promise<void> {
    this.tab = tab;
    if (focus) this.selected = focus;
    this.isOpen = true;
    this.root.hidden = false;
    this.hooks.changed(true);
    await this.refresh();
  }

  close(): void {
    this.isOpen = false;
    this.root.hidden = true;
    this.hooks.changed(false);
  }

  toggle(tab: TeamTab = "members"): void {
    if (this.isOpen && this.tab === tab) this.close();
    else void this.open(tab);
  }

  /** Open the editor for a new bot or an existing one. */
  edit(bot?: TeamBot): void {
    if (!this.data) return;
    this.editor.open(this.data, bot);
  }

  async refresh(): Promise<void> {
    try {
      const [t, p] = await Promise.all([this.client.team(), this.client.peers({ limit: 60 })]);
      this.data = t;
      this.peers = p;
      this.hooks.roster(t);
      if (this.selected) this.detail = await this.client.peer(this.selected).catch(() => undefined);
      if (this.isOpen) this.render();
    } catch (err) {
      this.hooks.error(err);
    }
  }

  /** Agents channel: team and peer changes, and worker activity (who is busy). */
  onAgentsEvent(type: string): void {
    if (type !== "team.changed" && type !== "peer.updated" && type !== "worker.updated") return;
    clearTimeout(this.refreshSoon);
    this.refreshSoon = setTimeout(() => void this.refresh(), type === "worker.updated" ? 400 : 60);
  }

  bot(id: string): TeamBot | undefined {
    return this.data?.bots.find((b) => b.id === id) ?? this.data?.archived.find((b) => b.id === id);
  }

  private engineLabel(b: TeamBot): string {
    const e: EngineChoice | undefined = this.data?.engines.find((x) => x.id === (b.engineId ?? "default"));
    const label = e?.label ?? tx("common.defaultEngine");
    const model = b.model ?? (e?.kind !== "default" ? e?.model : null);
    return model ? `${label}${tx("common.joinComma")}${model}` : label;
  }

  // ── render ─────────────────────────────────────────────────

  render(): void {
    const t = this.data;
    const running = this.peers.filter((p) => p.status === "running").length;
    const tab = (k: TeamTab, label: string, attn = 0) =>
      h(
        "button",
        {
          class: "lb-tab",
          type: "button",
          role: "tab",
          "aria-selected": this.tab === k ? "true" : "false",
          onclick: () => {
            this.tab = k;
            this.render();
            this.hooks.changed(true);
          },
        },
        label,
        attn
          ? h("span", { class: "lb-attn", title: tx("desktop.team.inProgress", { attn }) }, String(attn))
          : null,
      );
    const head = h(
      "header",
      { class: "lb-head" },
      h("h1", { class: "lb-title" }, tx("common.team")),
      h(
        "div",
        { class: "lb-tabs", role: "tablist" },
        tab("members", tx("desktop.team.members")),
        tab("activity", tx("common.collaborationLog"), running),
      ),
      h("span", { class: "lb-spacer" }),
      h(
        "button",
        {
          class: "tool-btn",
          type: "button",
          "aria-label": tx("common.newBot"),
          title: tx("common.newBot"),
          onclick: () => this.edit(),
        },
        plainIcon("plus"),
      ),
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
    const body = !t
      ? h("p", { class: "lb-intro" }, tx("common.loading2"))
      : this.tab === "members"
        ? this.members(t)
        : activity(this, t);
    renderPage(this.root, this.tab, head, h("div", { class: "lb-inner tm-inner" }, note, body));
  }

  act(p: Promise<unknown>): void {
    void p.then(
      () => this.refresh(),
      (err) => {
        this.notice = String((err as Error)?.message ?? err);
        this.render();
      },
    );
  }

  private members(t: Team): HTMLElement {
    const solo = t.bots.length === 1;
    return h(
      "div",
      {},
      h("h2", { class: "lb-page-title" }, tx("common.team")),
      h(
        "p",
        { class: "lb-intro" },
        solo ? tx("desktop.team.theTeamHasOnlyOne") : tx("desktop.team.eachBotHasItsOwn"),
      ),
      h(
        "ul",
        { class: "lb-list tm-list" },
        ...t.bots.map((b) => this.row(b)),
        h(
          "li",
          { class: "tm-add" },
          h(
            "button",
            { class: "btn-link", type: "button", onclick: () => this.edit() },
            tx("desktop.team.addBotRow"),
          ),
        ),
      ),
      solo ? null : this.rules(t),
      t.archived.length
        ? h(
            "section",
            { class: "lb-section tm-archived" },
            h("h3", { class: "lb-h2" }, tx("common.archived")),
            h(
              "ul",
              { class: "lb-list" },
              ...t.archived.map((b) =>
                h(
                  "li",
                  { class: "lb-row tm-row", "data-archived": "true" },
                  botAvatar({ ...b, avatar: b.avatar ?? b.name.slice(0, 1) }),
                  h(
                    "div",
                    { class: "lb-main" },
                    h("p", { class: "tm-row-name" }, b.name),
                    h(
                      "p",
                      { class: "lb-meta" },
                      tx("desktop.team.archivedChatsAndRecordsAre", {
                        archivedAt: ago(b.archivedAt ?? b.createdAt),
                      }),
                    ),
                  ),
                  h(
                    "div",
                    { class: "lb-actions" },
                    h(
                      "button",
                      { class: "lb-act", type: "button", onclick: () => this.act(this.client.restore(b.id)) },
                      tx("desktop.team.restore"),
                    ),
                  ),
                ),
              ),
            ),
          )
        : null,
    );
  }

  /** §4.2: a member is a row (avatar glyph, name, role, state); 對話 and the `…` menu on hover. */
  private row(b: TeamBot): HTMLElement {
    const a = b.activity;
    const state = a.waiting ? "waiting" : a.workers || a.peersOpen ? "working" : "idle";
    const now = a.working[0];
    const role = b.role ?? tx("common.noRoleWrittenYet");
    const facts = [
      this.engineLabel(b),
      tx("desktop.team.permissions", { level: LEVEL_WORD[b.approvalLevel ?? "team"] ?? "" }),
      b.browserProfile !== "shared" ? (BROWSER_WORD[b.browserProfile] ?? "") : "",
      b.memoryMode !== "team" ? (MEMORY_WORD[b.memoryMode] ?? "") : "",
      tx("desktop.team.chats", { threads: b.threads }),
    ].filter(Boolean);
    const trail =
      state === "idle"
        ? null
        : h(
            "button",
            {
              class: "tm-state",
              type: "button",
              "data-state": state,
              disabled: !now,
              title: now ? `${now.title}\n${tx("desktop.team.openTheChatThisJob")}` : "",
              onclick: (e: Event) => {
                e.stopPropagation();
                if (now) this.hooks.openThread(now.threadId);
              },
            },
            state === "waiting" ? tx("desktop.team.stateWaiting") : tx("desktop.team.stateWorking"),
          );
    const row = h(
      "li",
      {
        class: "lb-row tm-row",
        "data-bot": b.id,
        "data-state": state,
        tabindex: "0",
        title: facts.join("\n"),
        onclick: () => this.edit(b),
        onkeydown: (e: Event) => {
          if ((e as KeyboardEvent).key === "Enter" && e.target === row) this.edit(b);
        },
      },
      botAvatar(b),
      h(
        "div",
        { class: "lb-main" },
        h("p", { class: "tm-row-name" }, b.name),
        h("p", { class: "lb-meta" }, b.isLead ? tx("desktop.team.leadRole", { role }) : role),
      ),
      h(
        "div",
        { class: "lb-actions" },
        h(
          "button",
          {
            class: "lb-act",
            type: "button",
            onclick: (e: Event) => {
              e.stopPropagation();
              this.hooks.talkTo(b.id);
            },
          },
          tx("common.chat"),
        ),
        moreButton(tx("common.more"), () => [
          { label: tx("desktop.team.editEllipsis"), run: () => this.edit(b) },
          ...(b.isDefault
            ? []
            : [
                {
                  label: tx("desktop.team.archive"),
                  danger: true,
                  run: () => this.act(this.client.archive(b.id)),
                },
              ]),
        ]),
      ),
      trail,
    );
    return row;
  }

  /** A popup button (§3.8): one value from a few, as a native select styled like a push button. */
  private popup<T extends string | number>(
    label: string,
    value: T,
    options: Array<[T, string]>,
    set: (v: T) => void,
  ): HTMLElement {
    const sel = h(
      "select",
      {
        class: "popup",
        "aria-label": label,
        onchange: (e: Event) => {
          const raw = (e.target as HTMLSelectElement).value;
          const hit = options.find(([v]) => String(v) === raw);
          if (hit) set(hit[0]);
        },
      },
      ...options.map(([v, text]) => h("option", { value: String(v), selected: v === value }, text)),
    );
    return sel;
  }

  /** §3.7 grouped form: label + one line of help on the left, the control on the right. */
  private rules(t: Team): HTMLElement {
    const r = t.rules;
    const row = (label: string, hint: string, control: HTMLElement) =>
      h(
        "div",
        { class: "form-row" },
        h("div", { class: "form-label" }, h("span", {}, label), h("small", {}, hint)),
        h("div", { class: "form-control" }, control),
      );
    return h(
      "section",
      { class: "lb-section tm-rules" },
      h("h3", { class: "lb-h2" }, tx("common.collaborationRules")),
      h(
        "div",
        { class: "form-group" },
        row(
          tx("common.whenTeammatesHandOffWork"),
          r.peerApproval === "auto"
            ? tx("desktop.team.botsHandOffDirectlyWithout")
            : r.peerApproval === "ask_all"
              ? tx("desktop.team.askMeBeforeHandOffs")
              : tx("desktop.team.askMeBeforeHandOffs2"),
          this.popup(
            tx("common.teammateHandOff"),
            r.peerApproval,
            [
              ["auto", tx("common.auto")],
              ["ask_delegate", tx("desktop.team.askMeBeforeHandOffs3")],
              ["ask_all", tx("desktop.team.askMeBeforeBoth")],
            ],
            (v) => this.act(this.client.rules({ peerApproval: v })),
          ),
        ),
        row(
          tx("desktop.team.maxHandOffLevels"),
          tx("desktop.team.aHandingToBIs"),
          stepper(
            tx("desktop.team.maxHandOffLevels"),
            r.maxDepth,
            1,
            3,
            (n) => tx("desktop.team.maxDepthValue", { n }),
            (v) => this.act(this.client.rules({ maxDepth: v as 1 | 2 | 3 })),
          ),
        ),
        row(
          tx("common.lead"),
          tx("desktop.team.withALeadNewChats"),
          this.popup(
            tx("common.lead"),
            t.leadId ?? "",
            [["", tx("desktop.team.noLead")], ...t.bots.map((b): [string, string] => [b.id, b.name])],
            (v) => this.act(this.client.lead(v || null)),
          ),
        ),
      ),
      h(
        "p",
        { class: "ap-lock" },
        plainIcon("lock"),
        h("span", {}, tx("desktop.team.paymentsSendingDeletingAndPublishing")),
      ),
    );
  }
}

/** A stepper (§3.8, number 1–3): − value +. */
export function stepper(
  label: string,
  value: number,
  min: number,
  max: number,
  word: (n: number) => string,
  set: (n: number) => void,
): HTMLElement {
  const btn = (d: number, glyph: string) =>
    h(
      "button",
      {
        class: "stepper-btn",
        type: "button",
        "aria-label": `${label} ${glyph}`,
        disabled: value + d < min || value + d > max,
        onclick: () => set(value + d),
      },
      glyph,
    );
  return h(
    "div",
    { class: "stepper", role: "group", "aria-label": label },
    h("span", { class: "stepper-value", "aria-live": "polite" }, word(value)),
    h("span", { class: "stepper-btns" }, btn(-1, "−"), btn(1, "+")),
  );
}

/** A system message in a teammate's conversation, as a person reads it: what it was asked, a worker's report. */
export function systemLine(content: string): { label: string; text: string } | null {
  const head = content.split("\n")[0] ?? "";
  const inner = (tag: string) => {
    const m = content.match(new RegExp(`<alca:${tag}[^>]*>\\n?([\\s\\S]*?)\\n?</alca:${tag}>`));
    return (m?.[1] ?? "").split("\n").filter((l) => l.trim());
  };
  if (head.startsWith("<alca:peer ") || head.startsWith("<alca:peer>")) {
    const kind = (head.match(/kind="([^"]*)"/) ?? [])[1];
    return {
      label: kind === "ask" ? tx("desktop.team.asked") : tx("desktop.team.handedOff"),
      text: inner("peer").join(" "),
    };
  }
  if (head.startsWith("<alca:worker")) {
    const body = inner("worker")
      .filter((l) => !l.startsWith("相鄰：") && !l.startsWith("全文："))
      .map((l) => l.replace(/^結果摘要（全文 \d+ 字(，未放進這裡)?）：/, "").replace(/^停止原因：/, "停下："))
      .join(" ");
    return { label: tx("desktop.team.workerReport"), text: body };
  }
  if (head.startsWith("<alca:peer-report")) {
    const bot = (head.match(/bot="([^"]*)"/) ?? [])[1] ?? tx("common.teammate");
    return { label: tx("desktop.team.replied", { bot }), text: inner("peer-report").join(" ") };
  }
  return null;
}
