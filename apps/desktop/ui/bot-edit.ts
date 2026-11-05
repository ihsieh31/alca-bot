// Add or edit one bot (P7). The first part is all most people need — a
// name, an avatar and a one-line role; 指示, engine, permissions, browser and
// memory sit under 進階, closed by default, each with a sensible default.

import { addonsPane } from "./addons.ts";
import type { ProvidersClient, ProviderView } from "./api-providers.ts";
import type { BotColor, BotInput, Team, TeamBot, TeamClient } from "./api-team.ts";
import { harnessFields } from "./bot-advanced.ts";
import { defaultEngineRow, levelDraft, levelToSend } from "./bot-advanced-model.ts";
import { p13Fields } from "./bot-p13.ts";
import { sandboxFields } from "./bot-sandbox.ts";
import { h, trapDialog } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { chosenRow, modelPicker, providerList } from "./model-picker.ts";
import { popup } from "./popup.ts";

export interface EditorHooks {
  saved(bot: TeamBot): void;
  error(err: unknown): void;
  /** Connected apps per bot live on the 連接 page. */
  openConnect(): void;
}

const ROLE_HINTS = [
  tx("desktop.botEdit.researchAndPriceComparisons"),
  tx("desktop.botEdit.writingAndTidyingDocuments"),
  tx("desktop.botEdit.schedulingAndManagingTheCalendar"),
  tx("desktop.botEdit.readingMailAndDraftingReplies"),
];

export class BotEditor {
  private readonly client: TeamClient;
  private readonly providers: ProvidersClient;
  private readonly hooks: EditorHooks;
  private overlay: HTMLElement | undefined;
  private untrap: (() => void) | undefined;
  /** Opens 模型與供應商 (set by the team view). */
  openProviders: (() => void) | undefined;

  constructor(client: TeamClient, providers: ProvidersClient, hooks: EditorHooks) {
    this.client = client;
    this.providers = providers;
    this.hooks = hooks;
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = undefined;
    this.untrap?.();
    this.untrap = undefined;
  }

  open(team: Team, bot?: TeamBot, o: { advanced?: boolean; tab?: "settings" | "addons" } = {}): void {
    this.close();
    const creating = !bot;
    const used = new Set(team.bots.map((b) => b.color));
    const tone: BotColor = bot?.color ?? team.colors.find((c) => !used.has(c)) ?? "ink";
    const err = h("p", { class: "tm-err", role: "alert", hidden: true });
    const name = h("input", {
      class: "cn-input",
      id: "be-name",
      value: bot?.name ?? "",
      maxlength: "40",
      placeholder: tx("common.eGResearcher"),
      autocomplete: "off",
    }) as HTMLInputElement;
    const avatar = h("input", {
      class: "cn-input be-avatar-input",
      id: "be-avatar",
      value: bot?.avatar ?? "",
      maxlength: "2",
      placeholder: tx("desktop.botEdit.r"),
      "aria-label": tx("desktop.botEdit.avatarLetter"),
    }) as HTMLInputElement;
    const preview = h("span", {
      class: "bot-av",
      "data-size": "xl",
      "data-tone": tone,
      "aria-hidden": "true",
    });
    const syncPreview = () => {
      preview.textContent = avatar.value.trim() || [...name.value.trim()][0] || "?";
      preview.dataset.tone = tone;
    };
    name.addEventListener("input", syncPreview);
    avatar.addEventListener("input", syncPreview);
    syncPreview();
    const role = h("input", {
      class: "cn-input",
      id: "be-role",
      value: bot?.role ?? "",
      maxlength: "120",
      placeholder: tx("desktop.botEdit.oneSentenceOnWhatIts", {
        p0: ROLE_HINTS[team.bots.length % ROLE_HINTS.length],
      }),
    }) as HTMLInputElement;

    // ── 進階 ──
    const instructions = h(
      "textarea",
      {
        class: "cn-input be-area",
        id: "be-instr",
        rows: "3",
        maxlength: "4000",
        placeholder: tx("desktop.botEdit.standingInstructionsForThisBot"),
      },
      bot?.instructions ?? "",
    ) as HTMLTextAreaElement;
    // 選供應商 → 選模型 (P11)
    let engineId = bot?.engineId ?? "default";
    let modelValue = bot?.model ?? "";
    const pickEl = h(
      "div",
      { class: "be-pick" },
      h("p", { class: "pv-empty" }, tx("desktop.botEdit.loadingProviders")),
    );
    const modelEl = h("div", { class: "be-model" });
    let provs: ProviderView[] = [];
    const defaultLabel = team.engines.find((e) => e.id === "default")?.label ?? tx("common.defaultEngine");
    const renderModel = () => {
      const p = provs.find((x) => x.id === engineId);
      const modelsOf =
        (engineId === "default" || engineId === "claude-code") && defaultLabel.startsWith("Claude Code")
          ? "claude-code"
          : p?.id;
      const reset = modelValue
        ? h(
            "button",
            {
              class: "lb-act pv-reset",
              type: "button",
              onclick: () => {
                modelValue = "";
                renderModel();
              },
            },
            tx("common.resetToDefault"),
          )
        : "";
      modelEl.replaceChildren(
        h(
          "span",
          { class: "be-hint be-label-row" },
          h(
            "span",
            { class: "pv-cur" },
            modelValue ||
              (p?.defaultModel
                ? tx("common.default2", { defaultModel: p.defaultModel })
                : tx("common.useItsOwnDefault")),
          ),
          reset,
        ),
        modelPicker({
          value: modelValue,
          load: (refresh) =>
            modelsOf
              ? this.providers.models(modelsOf, refresh)
              : Promise.resolve({ source: "builtin" as const, models: [] }),
          onChange: (m) => {
            modelValue = m;
            renderModel();
          },
          placeholder: tx("common.searchModelsOrTypeA"),
        }),
      );
    };
    let choosing = false;
    const renderPick = () => {
      const chosen = provs.find((x) => x.id === engineId);
      pickEl.replaceChildren(
        choosing
          ? providerList({
              providers: provs,
              selected: engineId,
              dense: true,
              defaultRow: defaultEngineRow(
                engineId,
                defaultLabel,
                provs.map((x) => x.id),
              ),
              onPick: (id) => {
                if (id !== engineId) modelValue = "";
                engineId = id;
                choosing = false;
                renderPick();
                renderModel();
                (modelEl.querySelector(".pv-search") as HTMLInputElement | null)?.focus();
              },
            })
          : chosenRow(
              chosen,
              defaultEngineRow(
                engineId,
                defaultLabel,
                provs.map((x) => x.id),
              ),
              () => {
                choosing = true;
                renderPick();
              },
            ),
        h(
          "button",
          { class: "lb-act be-link", type: "button", onclick: () => this.openProviders?.() },
          tx("common.manageProvidersKeysAndCustom"),
        ),
      );
    };
    const allowed = new Set(team.engines.map((e) => e.id));
    void this.providers.list().then(
      (list) => {
        provs = list.filter((p) => allowed.has(p.id));
        renderPick();
        renderModel();
      },
      () => {
        provs = [];
        renderPick();
        renderModel();
      },
    );
    renderModel();
    const seg = <T extends string>(id: string, value: T, options: Array<[T, string]>) =>
      popup(id, value, options);
    // Phase 6: 完全授權 is its own switch below (warning + second confirm), on top of 自主.
    const startLevel = levelDraft(bot?.approvalLevel);
    const level = seg("be-level", startLevel.level, [
      ["team", tx("common.sameAsTheTeam")],
      ["confirm_each_step", tx("common.askEveryStep")],
      ["autonomous", tx("common.autonomous")],
    ]);
    const browser = seg("be-browser", bot?.browserProfile ?? "shared", [
      ["shared", tx("desktop.botEdit.useMySignIns")],
      ["isolated", tx("desktop.botEdit.separate")],
      ["isolated_keep", tx("desktop.botEdit.separateKeepSignIns")],
    ]);
    const memory = seg("be-memory", bot?.memoryMode ?? "team", [
      ["team", tx("desktop.botEdit.sharedItsOwn")],
      ["own", tx("desktop.botEdit.itsOwnOnly")],
      ["off", tx("common.noMemory")],
    ]);
    const extract = seg("be-extract", bot?.memoryExtract ?? "rules", [
      ["rules", tx("desktop.botEdit.rulesDefault")],
      ["model", tx("desktop.botEdit.alsoAskTheModelTo")],
    ]);
    const language = seg("be-language", bot?.language ?? "auto", [
      ["auto", tx("desktop.botEdit.botLanguageAuto")],
      ["zh", tx("desktop.botEdit.botLanguageZh")],
      ["en", tx("desktop.botEdit.botLanguageEn")],
    ]);
    const field = (label: string, control: HTMLElement, hint?: string, forId?: string) =>
      h(
        "div",
        { class: "be-field" },
        h("label", { class: "be-label", ...(forId ? { for: forId } : {}) }, label),
        control,
        hint ? h("span", { class: "be-hint" }, hint) : null,
      );
    const p13 = p13Fields(bot, team, field);
    const harness = harnessFields(bot, startLevel.full, field);
    const sandbox = sandboxFields(bot, field);
    // (an existing bot's 指令審查 and 提前做 are in the 擴充 tab)
    const advanced = h(
      "details",
      { class: "be-adv", ...(o.advanced ? { open: true } : {}) },
      h(
        "summary",
        { class: "be-adv-sum" },
        h("span", { class: "be-adv-word" }, tx("common.advanced")),
        h("span", { class: "be-hint" }, tx("desktop.botEdit.instructionsEnginePermissionsHarnessBudget")),
      ),
      h(
        "div",
        { class: "be-adv-body" },
        field(tx("common.instructions"), instructions, undefined, "be-instr"),
        field(tx("desktop.botEdit.botLanguage"), language.el, tx("desktop.botEdit.botLanguageHint")),
        h("div", { class: "be-field" }, h("span", { class: "be-label" }, tx("common.provider")), pickEl),
        h("div", { class: "be-field" }, h("span", { class: "be-label" }, tx("common.model")), modelEl),
        field(tx("common.permissions"), level.el, tx("desktop.botEdit.paymentsSendingDeletingAndPublishing")),
        ...harness.elements,
        ...sandbox.elements,
        field(tx("common.browser"), browser.el, tx("desktop.botEdit.separateNeverUsesYourEveryday")),
        field(tx("common.memory"), memory.el, tx("desktop.botEdit.sharedPreferencesYouTellAny")),
        field(
          tx("desktop.botEdit.memoryTidyUp"),
          extract.el,
          tx("desktop.botEdit.optionalAfterEachRoundThis"),
        ),
        ...p13.elements,
        bot
          ? field(
              tx("desktop.botEdit.connectedApps"),
              h(
                "button",
                {
                  class: "lb-act be-link",
                  type: "button",
                  onclick: () => {
                    this.close();
                    this.hooks.openConnect();
                  },
                },
                tx("desktop.botEdit.chooseWhichAccountsThisBot"),
              ),
            )
          : null,
      ),
    );
    const save = h(
      "button",
      { class: "btn btn-primary", type: "submit" },
      creating ? tx("desktop.botEdit.addToTeam") : tx("common.save"),
    ) as HTMLButtonElement;
    // 封存 asks in place (the footer turns into the question), not in a native dialog.
    const foot = h("footer", { class: "be-foot" });
    const cancel = () =>
      h(
        "button",
        { class: "btn btn-quiet", type: "button", onclick: () => this.close() },
        tx("common.cancel"),
      );
    const normal = () => {
      foot.dataset.confirm = "false";
      foot.replaceChildren(
        bot && !bot.isDefault
          ? h(
              "button",
              { class: "lb-act", "data-tone": "danger", type: "button", onclick: asking },
              tx("common.archive"),
            )
          : h("span"),
        h("span", { class: "lb-spacer" }),
        cancel(),
        save,
      );
    };
    const asking = () => {
      if (!bot) return;
      foot.dataset.confirm = "true";
      const yes = h(
        "button",
        {
          class: "btn btn-danger",
          type: "button",
          onclick: () => {
            yes.disabled = true;
            void this.client.archive(bot.id).then(
              () => {
                this.close();
                this.hooks.saved(bot);
              },
              (e) => {
                normal();
                show(e);
              },
            );
          },
        },
        tx("common.archive"),
      ) as HTMLButtonElement;
      const back = h(
        "button",
        { class: "btn btn-quiet", type: "button", onclick: normal },
        tx("common.notNow2"),
      );
      foot.replaceChildren(
        h(
          "p",
          { class: "be-confirm", role: "alert" },
          h("b", {}, tx("desktop.botEdit.archive", { name: bot.name })),
          tx("desktop.botEdit.itsChatsAndRecordsAre"),
        ),
        h("span", { class: "lb-spacer" }),
        back,
        yes,
      );
      back.focus();
    };
    const show = (e: unknown) => {
      err.hidden = false;
      err.textContent = String((e as Error)?.message ?? e);
    };
    // P14: an existing bot's add-ons live in their own tab (each switch saves at once).
    const addonsBox = h("div", {
      class: "be-pane",
      id: "be-pane-addons",
      role: "tabpanel",
      "aria-labelledby": "be-tab-addons",
      hidden: true,
    });
    const pick = (which: "settings" | "addons") => {
      for (const t of tabs.querySelectorAll<HTMLElement>(".be-tab"))
        t.setAttribute("aria-selected", t.dataset.tab === which ? "true" : "false");
      const settingsPane = addonsBox.parentElement?.querySelector<HTMLElement>("#be-pane-settings");
      if (settingsPane) settingsPane.hidden = which !== "settings";
      addonsBox.hidden = which !== "addons";
      save.hidden = which !== "settings";
      if (which === "addons" && bot && !addonsBox.firstChild)
        addonsBox.append(addonsPane(this.client, bot.id, (e) => show(e)));
    };
    const tab = (which: "settings" | "addons", label: string) =>
      h(
        "button",
        {
          class: "be-tab",
          type: "button",
          role: "tab",
          id: `be-tab-${which}`,
          "data-tab": which,
          "aria-controls": `be-pane-${which}`,
          "aria-selected": which === "settings" ? "true" : "false",
          onclick: () => pick(which),
        },
        label,
      );
    const tabs = h(
      "div",
      { class: "be-tabs", role: "tablist" },
      tab("settings", tx("common.settings")),
      tab("addons", tx("common.addOns")),
    );
    const form = h(
      "form",
      {
        class: "sheet tm-editor",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "be-title",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const hb = harness.harness();
          if (!hb.ok) {
            show(hb.error);
            return;
          }
          const input: BotInput = {
            name: name.value,
            avatar: avatar.value.trim() || null,
            color: tone,
            role: role.value.trim() || null,
            instructions: instructions.value.trim() || null,
            engineId: engineId === "default" ? null : engineId,
            model: modelValue.trim() || null,
            approvalLevel: levelToSend(level.get(), harness.fullAccess()),
            harness: hb.harness,
            browserProfile: browser.get() as TeamBot["browserProfile"],
            memoryMode: memory.get() as TeamBot["memoryMode"],
            memoryExtract: extract.get() as NonNullable<TeamBot["memoryExtract"]>,
            language: language.get() as NonNullable<TeamBot["language"]>,
            ...p13.values(),
            ...sandbox.values(),
          };
          save.disabled = true;
          void (bot ? this.client.update(bot.id, input) : this.client.create(input)).then(
            (b) => {
              this.close();
              this.hooks.saved(b);
            },
            (e2) => {
              save.disabled = false;
              show(e2);
            },
          );
        },
      },
      h(
        "header",
        { class: "be-head" },
        preview,
        h(
          "div",
          {},
          h("h2", { id: "be-title" }, creating ? tx("common.newBot") : tx("common.edit", { name: bot.name })),
          h(
            "p",
            { class: "be-hint" },
            creating ? tx("desktop.botEdit.onceAddedTypeNameIn") : tx("desktop.botEdit.afterAChangeTheNext"),
          ),
        ),
      ),
      bot ? tabs : null,
      h(
        "div",
        { class: "be-body" },
        h(
          "div",
          {
            class: "be-pane",
            id: "be-pane-settings",
            role: "tabpanel",
            "aria-labelledby": "be-tab-settings",
          },
          h(
            "div",
            { class: "be-row-name" },
            field(tx("common.name2"), name, undefined, "be-name"),
            field(tx("common.avatar"), avatar, undefined, "be-avatar"),
          ),
          field(tx("common.role"), role, tx("desktop.botEdit.teammatesDecideWhetherToBring"), "be-role"),
          advanced,
        ),
        addonsBox,
        err,
      ),
      foot,
    );
    normal();
    if (bot && o.tab === "addons") pick("addons");
    const overlay = h("div", { class: "overlay tm-overlay" }, form);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });
    document.body.append(overlay);
    this.overlay = overlay;
    this.untrap = trapDialog(form, () => this.close(), name);
  }
}
