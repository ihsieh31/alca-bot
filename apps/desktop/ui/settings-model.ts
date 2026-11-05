// 設定 → 模型與供應商 (P13 B3): the team's default bot's provider and model,
// with the same 選供應商 → 選模型 picker as the bot editor (model-picker.ts),
// saved with PATCH /api/bots/:id. Keys, custom providers and the full list
// stay in 模型與供應商 (the link opens it).
import type { Api } from "./api.ts";
import { type ProviderView, providersApi } from "./api-providers.ts";
import { type Team, teamApi } from "./api-team.ts";
import { h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { chosenRow, modelPicker, providerList } from "./model-picker.ts";
import { errText, note, section } from "./settings-parts.ts";

export function modelSection(api: Api, hooks: { openProviders?: (() => void) | undefined }): HTMLElement {
  const team = teamApi(api);
  const providers = providersApi(api);
  const body = h("div", { class: "st-live st-model" }, h("p", { class: "lk-note" }, tx("common.loading")));
  let choosing = false;

  const draw = (t: Team, provs: ProviderView[], msg?: { text: string; tone: "ok" | "bad" }) => {
    const bot = t.bots.find((b) => b.id === t.defaultBotId) ?? t.bots.find((b) => b.isDefault);
    if (!bot) {
      body.replaceChildren(note(tx("desktop.settingsModel.noBotsYet")));
      return;
    }
    const engineId = bot.engineId ?? "default";
    const defaultLabel = t.engines.find((e) => e.id === "default")?.label ?? tx("common.defaultEngine");
    const fallback = { label: defaultLabel, hint: tx("desktop.settingsModel.defaultEngineForThisLaunch") };
    const chosen = provs.find((p) => p.id === engineId);
    const save = async (patch: { engineId?: string | null; model?: string | null }) => {
      try {
        await team.update(bot.id, patch);
        choosing = false;
        await refresh({ text: tx("common.saved"), tone: "ok" });
      } catch (e) {
        draw(t, provs, { text: tx("common.notSaved", { e: errText(e) }), tone: "bad" });
      }
    };
    const modelsOf =
      engineId === "default" && defaultLabel.startsWith("Claude Code") ? "claude-code" : chosen?.id;
    const current =
      bot.model ||
      (chosen?.defaultModel
        ? tx("common.default2", { defaultModel: chosen.defaultModel })
        : tx("common.useItsOwnDefault"));
    const parts: Array<Node | null> = [
      h("p", { class: "lc-help" }, tx("desktop.settingsModel.isTheTeamsFirstBot", { name: bot.name })),
      choosing
        ? providerList({
            providers: provs,
            selected: engineId,
            dense: true,
            defaultRow: fallback,
            onPick: (id) =>
              void save({
                engineId: id === "default" ? null : id,
                ...(id !== engineId ? { model: null } : {}),
              }),
          })
        : chosenRow(chosen, fallback, () => {
            choosing = true;
            draw(t, provs);
          }),
      h(
        "div",
        { class: "lc-field" },
        h(
          "span",
          { class: "lc-label" },
          tx("desktop.settingsModel.model"),
          h("span", { class: "st-restart" }, current),
        ),
        modelPicker({
          value: bot.model ?? "",
          load: (fresh) =>
            modelsOf
              ? providers.models(modelsOf, fresh)
              : Promise.resolve({ source: "builtin" as const, models: [] }),
          onChange: (m) => void save({ model: m || null }),
          placeholder: tx("common.searchModelsOrTypeA"),
        }),
      ),
      hooks.openProviders
        ? h(
            "button",
            {
              class: "lb-act be-link",
              type: "button",
              "data-act": "open-providers",
              onclick: () => hooks.openProviders?.(),
            },
            tx("common.manageProvidersKeysAndCustom"),
          )
        : null,
      msg ? note(msg.text, msg.tone) : null,
    ];
    body.replaceChildren(...parts.filter((x): x is Node => !!x));
  };

  const refresh = async (msg?: { text: string; tone: "ok" | "bad" }) => {
    try {
      const t = await team.team();
      const allowed = new Set(t.engines.map((e) => e.id));
      const provs = (await providers.list().catch(() => [] as ProviderView[])).filter((p) =>
        allowed.has(p.id),
      );
      draw(t, provs, msg);
    } catch (e) {
      body.replaceChildren(note(tx("desktop.settingsModel.cantReadTheTeam", { e: errText(e) }), "bad"));
    }
  };
  void refresh();
  return section("model", tx("common.modelsAndProviders"), body);
}
