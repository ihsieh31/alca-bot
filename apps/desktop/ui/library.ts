// 記憶與技能: what Alca remembers about you and the playbooks you approved,
// per bot. Everything lives on this computer; 忘記 is a permanent delete
// (every version), and Alca keeps only a one-way hash so it does not learn
// the same thing again.
import type { Api, Bot, LearningEvent, MemoryItem, MemoryList, Skill } from "./api.ts";
import { h, relativeTime, renderPage } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { icon as plainIcon } from "./icons.ts";
import { moreButton } from "./menu.ts";
import {
  CLASS_LABEL,
  proposalCard,
  type SkillCardActions,
  skillEditor,
  stepList,
  triggerLine,
} from "./skill-card.ts";

const KIND: Record<string, { label: string }> = {
  preference: { label: t("common.preference") },
  person: { label: t("common.person") },
  fact: { label: t("common.fact") },
  project: { label: t("common.project") },
};

type Tab = "memory" | "skills";

export interface LibraryHooks {
  /** The library opened or closed (the app hides the chat column meanwhile). */
  changed(open: boolean): void;
  /** Proposals waiting (sidebar badge). */
  pending(n: number): void;
  openThread(id: string): void;
  error(err: unknown): void;
}

export class Library {
  private readonly root: HTMLElement;
  private readonly api: Api;
  private readonly hooks: LibraryHooks;
  private tab: Tab = "memory";
  private bots: Bot[] = [];
  private bot = "";
  private query = "";
  private adding = false;
  private kind = "";
  private origin = "";
  private data: MemoryList | undefined;
  private skills: Skill[] = [];
  private editing: string | undefined;
  private forgetting: string | undefined;
  private skillEditing: string | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  isOpen = false;

  constructor(root: HTMLElement, api: Api, hooks: LibraryHooks) {
    this.root = root;
    this.api = api;
    this.hooks = hooks;
  }

  setBots(bots: Bot[]): void {
    this.bots = bots;
    if (!this.bot) this.bot = bots.find((b) => b.isDefault)?.id ?? bots[0]?.id ?? "";
  }

  async open(tab: Tab = this.tab, focusSkill?: string): Promise<void> {
    this.tab = tab;
    this.isOpen = true;
    this.root.hidden = false;
    this.hooks.changed(true);
    await this.refresh();
    if (focusSkill)
      this.root.querySelector(`[data-skill="${focusSkill}"]`)?.scrollIntoView({ block: "center" });
  }

  close(): void {
    this.isOpen = false;
    this.root.hidden = true;
    this.hooks.changed(false);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }

  /** Learning channel: refresh what is on screen, keep the sidebar badge right. */
  onLearning(_e: LearningEvent): void {
    void this.refreshCounts();
    if (this.isOpen && !this.editing && !this.skillEditing) void this.refresh();
  }

  async refreshCounts(): Promise<void> {
    const s = await this.api.skills(this.bot || undefined).catch(() => undefined);
    if (!s) return;
    this.skills = s.items;
    this.hooks.pending(s.items.filter((x) => x.pending).length);
  }

  private async refresh(): Promise<void> {
    try {
      const [m, s] = await Promise.all([
        this.api.memory({ bot: this.bot, q: this.query, kind: this.kind, origin: this.origin }),
        this.api.skills(this.bot || undefined),
      ]);
      this.data = m;
      this.skills = s.items;
      this.hooks.pending(s.items.filter((x) => x.pending).length);
      this.render();
    } catch (err) {
      this.hooks.error(err);
    }
  }

  private act(p: Promise<unknown>): Promise<void> {
    return p.then(
      () => this.refresh(),
      (err) => this.hooks.error(err),
    );
  }

  readonly skillActions: SkillCardActions = {
    approve: (id, edit) => this.act(this.api.approveSkill(id, edit)),
    reject: (id) => this.act(this.api.rejectSkill(id)),
  };

  // ── render ─────────────────────────────────────────────────

  private render(): void {
    const m = this.data;
    const pending = this.skills.filter((s) => s.pending).length;
    const saved = this.skills.filter((s) => s.status === "active" || s.status === "disabled").length;
    const tabs = h(
      "div",
      { class: "lb-tabs", role: "tablist" },
      this.tabButton("memory", t("common.memory"), m?.counts.all ?? 0),
      this.tabButton("skills", t("desktop.library.skill"), saved, pending),
    );
    const botPicker =
      this.bots.length > 1
        ? h(
            "select",
            {
              class: "lb-bot",
              "aria-label": "bot",
              onchange: (e: Event) => {
                this.bot = (e.target as HTMLSelectElement).value;
                void this.refresh();
              },
            },
            ...this.bots.map((b) => {
              const o = h("option", { value: b.id }, b.name);
              o.selected = b.id === this.bot;
              return o;
            }),
          )
        : null;
    const head = h(
      "header",
      { class: "lb-head" },
      h("h1", { class: "lb-title" }, t("common.memoryAndSkills")),
      tabs,
      h("span", { class: "lb-spacer" }),
      botPicker,
      h(
        "button",
        {
          class: "tool-btn",
          type: "button",
          title: t("desktop.library.exportAsJson"),
          "aria-label": t("common.export"),
          onclick: () => void this.export(),
        },
        plainIcon("export"),
      ),
      h(
        "button",
        {
          class: "tool-btn",
          type: "button",
          "aria-label": t("common.close"),
          title: t("common.backToChat"),
          onclick: () => this.close(),
        },
        plainIcon("cross"),
      ),
    );
    const body = this.tab === "memory" ? this.memoryTab() : this.skillsTab();
    renderPage(this.root, this.tab, head, h("div", { class: "lb-inner" }, body));
  }

  private tabButton(tab: Tab, label: string, _count: number, attention = 0): HTMLElement {
    return h(
      "button",
      {
        class: "lb-tab",
        type: "button",
        role: "tab",
        "aria-selected": this.tab === tab ? "true" : "false",
        onclick: () => {
          this.tab = tab;
          this.render();
        },
      },
      label,
      attention
        ? h(
            "span",
            { class: "lb-attn", title: t("desktop.library.awaitingYourConfirmation", { attention }) },
            String(attention),
          )
        : null,
    );
  }

  private memoryTab(): HTMLElement {
    const m = this.data;
    const search = h("input", {
      type: "search",
      placeholder: t("common.searchMemories"),
      value: this.query,
      "aria-label": t("common.searchMemories"),
      oninput: (e: Event) => {
        this.query = (e.target as HTMLInputElement).value;
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => void this.refresh().then(() => this.focusSearch()), 220);
      },
    });
    const c = m?.counts ?? {};
    // §3.8: one 「全部 ⌄」 menu instead of a row of chips.
    const opt = (value: string, label: string, n?: number) => {
      const o = h(
        "option",
        { value },
        n !== undefined ? t("desktop.library.optionCount", { label, n }) : label,
      );
      o.selected = (this.kind ? `kind:${this.kind}` : this.origin ? `origin:${this.origin}` : "") === value;
      return o;
    };
    const menu = h(
      "select",
      {
        class: "lb-menu",
        "aria-label": t("common.type"),
        onchange: (e: Event) => {
          const [key, value] = (e.target as HTMLSelectElement).value.split(":");
          this.kind = key === "kind" ? (value ?? "") : "";
          this.origin = key === "origin" ? (value ?? "") : "";
          void this.refresh();
        },
      },
      opt("", t("common.all"), c.all),
      ...Object.entries(KIND).map(([k, v]) => opt(`kind:${k}`, v.label, c[k])),
      opt("origin:inferred", t("common.guess"), c.inferred),
      opt("origin:user", t("common.confirmed"), c.user),
    );
    const add = h("input", {
      class: "field",
      placeholder: t("desktop.library.addSomethingAlcaShouldRemember"),
      maxlength: "2000",
      "aria-label": t("desktop.library.addAMemory"),
    });
    const addForm = h(
      "form",
      {
        class: "lb-add",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const text = add.value.trim();
          if (!text) return;
          void this.act(this.api.addMemory({ body: text, botId: this.bot }));
        },
      },
      add,
      h("button", { class: "btn btn-primary", type: "submit" }, t("desktop.library.remember")),
      h(
        "button",
        {
          class: "btn btn-quiet",
          type: "button",
          onclick: () => {
            this.adding = false;
            this.render();
          },
        },
        t("common.cancel"),
      ),
    );
    if (this.adding) queueMicrotask(() => add.focus());
    const items = m?.items ?? [];
    return h(
      "div",
      { class: "lb-memory" },
      h("h2", { class: "lb-page-title" }, t("common.memory")),
      h("p", { class: "lb-intro" }, t("desktop.library.thingsAlcaNotedFromChats")),
      h(
        "div",
        { class: "lb-tools" },
        h("label", { class: "lb-search" }, plainIcon("search"), search),
        menu,
        h("span", { class: "lb-spacer" }),
        h(
          "button",
          {
            class: "btn btn-quiet",
            type: "button",
            onclick: () => {
              this.adding = true;
              this.render();
            },
          },
          t("desktop.library.addEllipsis"),
        ),
      ),
      this.adding ? addForm : null,
      items.length
        ? h("ul", { class: "lb-list" }, ...items.map((i) => this.memoryRow(i)))
        : h(
            "div",
            { class: "lb-empty" },
            this.query || this.kind || this.origin
              ? t("common.noMatchingMemories")
              : t("desktop.library.noMemoriesYetTellAlca"),
          ),
      h(
        "footer",
        { class: "lb-foot" },
        t("desktop.library.forgotOnlyAnIrreversibleHash", { forgotten: m?.forgotten ?? 0 }),
        m?.forgotten
          ? h(
              "button",
              { class: "btn-link", type: "button", onclick: () => void this.act(this.api.clearForgotten()) },
              t("desktop.library.letAlcaLearnItAgain"),
            )
          : null,
      ),
    );
  }

  private focusSearch(): void {
    const el = this.root.querySelector<HTMLInputElement>(".lb-search input");
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  private memoryRow(i: MemoryItem): HTMLElement {
    const src = i.source.threadId
      ? h(
          "button",
          {
            class: "lb-src",
            type: "button",
            title: t("desktop.library.openThatChat"),
            onclick: () => i.source.threadId && this.hooks.openThread(i.source.threadId),
          },
          t("desktop.library.from", { threadTitle: i.source.threadTitle ?? t("common.chat") }),
        )
      : h(
          "span",
          {},
          i.source.kind === "ui"
            ? t("desktop.library.addedByYouHere")
            : i.source.kind === "migrated"
              ? t("desktop.library.olderMemory")
              : t("common.chat"),
        );
    // One secondary line (§3.12): 推測 as words, then where it came from; the rest in the tooltip.
    const details = [
      KIND[i.kind]?.label ?? i.kind,
      i.scope === "shared"
        ? t("desktop.library.sharedByAllBots")
        : t("desktop.library.only", { botName: i.botName }),
      i.edited ? t("desktop.library.editedByYou") : "",
      relativeTime(i.updatedAt),
      i.uses ? t("common.usedTimes", { uses: i.uses }) : "",
      i.versions > 1 ? t("desktop.library.versions", { versions: i.versions }) : "",
      i.quote && i.quote !== i.body ? i.quote : "",
    ].filter(Boolean);
    const meta = h(
      "div",
      { class: "lb-meta", title: details.join("\n") },
      i.origin === "user" ? null : h("span", { class: "lb-guess" }, t("desktop.library.guessUnconfirmed")),
      src,
    );
    const row = h("li", { class: "lb-row", "data-origin": i.origin });
    if (this.editing === i.id) {
      const area = h("textarea", { class: "field sk-area", rows: "2", "aria-label": t("common.content") });
      area.value = i.body;
      const kind = h(
        "select",
        { class: "lb-kind", "aria-label": t("common.type") },
        ...Object.entries(KIND).map(([key, v]) => {
          const o = h("option", { value: key }, v.label);
          o.selected = key === i.kind;
          return o;
        }),
      );
      row.append(
        h(
          "div",
          { class: "lb-main" },
          area,
          h("p", { class: "lb-hint" }, t("desktop.library.savingMakesANewVersion")),
          h(
            "div",
            { class: "card-actions" },
            kind,
            h(
              "button",
              {
                class: "btn btn-primary",
                type: "button",
                onclick: () => {
                  this.editing = undefined;
                  void this.act(this.api.editMemory(i.id, { body: area.value, kind: kind.value }));
                },
              },
              t("common.save"),
            ),
            h(
              "button",
              {
                class: "btn btn-quiet",
                type: "button",
                onclick: () => {
                  this.editing = undefined;
                  this.render();
                },
              },
              t("common.cancel"),
            ),
            h(
              "button",
              {
                class: "btn-link",
                type: "button",
                onclick: () =>
                  void this.act(
                    this.api.editMemory(i.id, { scope: i.scope === "shared" ? "bot" : "shared" }),
                  ),
              },
              i.scope === "shared"
                ? t("desktop.library.makeItOnly", { botName: i.botName })
                : t("desktop.library.shareWithAllBots"),
            ),
          ),
        ),
      );
      queueMicrotask(() => area.focus());
      return row;
    }
    const actions =
      this.forgetting === i.id
        ? h(
            "div",
            { class: "lb-actions lb-confirm" },
            h("span", {}, t("desktop.library.deletePermanentlyIncludingOldVersions")),
            h(
              "button",
              {
                class: "btn btn-danger",
                type: "button",
                onclick: () => {
                  this.forgetting = undefined;
                  void this.act(this.api.forgetMemory(i.id));
                },
              },
              t("common.forget"),
            ),
            h(
              "button",
              {
                class: "btn btn-quiet",
                type: "button",
                onclick: () => {
                  this.forgetting = undefined;
                  this.render();
                },
              },
              t("common.cancel"),
            ),
          )
        : h(
            "div",
            { class: "lb-actions" },
            i.origin === "inferred"
              ? h(
                  "button",
                  {
                    class: "lb-act",
                    type: "button",
                    onclick: () => void this.act(this.api.confirmMemory(i.id)),
                  },
                  t("desktop.library.confirm"),
                )
              : null,
            moreButton(t("common.more"), () => [
              {
                label: t("common.edit2"),
                run: () => {
                  this.editing = i.id;
                  this.render();
                },
              },
              {
                label: t("common.forget"),
                danger: true,
                run: () => {
                  this.forgetting = i.id;
                  this.render();
                },
              },
            ]),
          );
    row.append(h("div", { class: "lb-main" }, h("p", { class: "lb-body" }, i.body), meta), actions);
    return row;
  }

  private skillsTab(): HTMLElement {
    const pending = this.skills.filter((s) => s.pending);
    const saved = this.skills.filter((s) => s.status === "active" || s.status === "disabled");
    return h(
      "div",
      { class: "lb-skills" },
      h("h2", { class: "lb-page-title" }, t("desktop.library.skillsTitle")),
      h("p", { class: "lb-intro" }, t("desktop.library.afterAJobGoesWell")),
      pending.length
        ? h(
            "section",
            { class: "lb-section" },
            h("h3", { class: "lb-h2" }, t("desktop.library.awaitingYourConfirmation2")),
            ...pending.map((s) => proposalCard(s, this.skillActions)),
          )
        : null,
      h(
        "section",
        { class: "lb-section" },
        pending.length ? h("h3", { class: "lb-h2" }, t("common.savedSkills")) : null,
        saved.length
          ? h("ul", { class: "lb-list" }, ...saved.map((s) => this.skillRow(s)))
          : h("div", { class: "lb-empty" }, t("desktop.library.noSkillsYetAfterAlca")),
      ),
    );
  }

  private skillRow(s: Skill): HTMLElement {
    const v = s.current;
    const row = h("li", { class: "lb-row sk-row", "data-skill": s.id, "data-status": s.status });
    if (!v) return row;
    if (this.skillEditing === s.id) {
      row.append(
        h(
          "div",
          { class: "lb-main" },
          skillEditor(
            v,
            (e) => {
              this.skillEditing = undefined;
              void this.act(this.api.editSkill(s.id, e));
            },
            () => {
              this.skillEditing = undefined;
              this.render();
            },
          ),
        ),
      );
      return row;
    }
    const toggle = h(
      "button",
      {
        class: "lb-switch",
        type: "button",
        role: "switch",
        "aria-checked": s.status === "active" ? "true" : "false",
        "aria-label": v.name,
        title:
          s.status === "active"
            ? t("desktop.library.enabledClickToDisable")
            : t("desktop.library.disabledClickToEnable"),
        onclick: () => void this.act(this.api.setSkillEnabled(s.id, s.status !== "active")),
      },
      h("i", {}),
    );
    const always = v.alwaysConfirm.map((c) => CLASS_LABEL[c] ?? c).join(t("common.text2"));
    const meta = t("desktop.library.skillMeta", {
      steps: t("common.steps", { stepsCount: v.steps.length }),
      uses: s.uses ? t("common.usedTimes", { uses: s.uses }) : t("common.notUsedYet"),
    });
    const tip = [
      `v${s.version}${v.author === "user" ? t("desktop.library.editedByYou2") : ""}`,
      s.lastUsedAt ? t("desktop.library.last", { lastUsedAt: relativeTime(s.lastUsedAt) }) : "",
    ]
      .filter(Boolean)
      .join("\n");
    // §3.7: name + one secondary line; the steps fold under the name (a disclosure, not a box).
    row.append(
      h(
        "details",
        { class: "lb-main sk-fold" },
        h(
          "summary",
          {},
          h("p", { class: "lb-body" }, v.name),
          h(
            "p",
            { class: "lb-meta", title: tip },
            s.status === "disabled" ? h("span", {}, t("common.disabled")) : null,
            always ? h("span", { class: "lb-lock", title: always }, plainIcon("lock")) : null,
            h("span", {}, meta),
          ),
        ),
        stepList(v),
        triggerLine(v),
      ),
      h(
        "div",
        { class: "lb-actions" },
        toggle,
        moreButton(t("common.more"), () => [
          {
            label: t("common.edit2"),
            run: () => {
              this.skillEditing = s.id;
              this.render();
            },
          },
          {
            label: t("common.delete"),
            danger: true,
            run: () => {
              if (confirm(t("desktop.library.deleteTheSkillAllVersions", { name: v.name })))
                void this.act(this.api.deleteSkill(s.id));
            },
          },
        ]),
      ),
    );
    return row;
  }

  private async export(): Promise<void> {
    try {
      const blob = await this.api.exportMemory(this.bot || undefined);
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: `alca-memory-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      this.hooks.error(err);
    }
  }
}
