// 設定 → 網路搜尋 (next round R1): pick the provider general workers may use
// for web_search (Brave, Tavily, a self-hosted SearXNG, or none) and paste
// its key. The key is checked with one real query, kept in the vault and
// never shown again (only its last four characters). Adding a provider or a
// key needs a window Alca opened itself (the approve key); turning it off
// does not. With none set, searching goes through Alca Browser as before.
import type { Api } from "./api.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { button, errText, live, note, section } from "./settings-parts.ts";

type Provider = "brave" | "tavily" | "searxng";

export interface WebSearchData {
  provider: Provider | null;
  searxngUrl: string | null;
  count: number;
  keys: Record<Provider, string | null>;
  available: boolean;
}

const LABELS: Array<[Provider | "none", string, string]> = [
  ["none", t("desktop.settingsSearch.noneDefault"), t("desktop.settingsSearch.workersSearchWithTheBrowser")],
  ["brave", "Brave Search", t("desktop.settingsSearch.needsABraveSearchApi")],
  ["tavily", "Tavily", t("desktop.settingsSearch.needsATavilyApiKey")],
  [
    "searxng",
    t("desktop.settingsSearch.selfHostedSearxng"),
    t("desktop.settingsSearch.enterYourSearxngAddressQueries"),
  ],
];

export function searchSection(api: Api): HTMLElement {
  const put = (body: Record<string, unknown>) => api.call<WebSearchData>("PUT", "/api/settings/search", body);
  const body = live(
    "st-search",
    () => api.call<WebSearchData>("GET", "/api/settings/search"),
    (d, reload) => {
      let pick: Provider | "none" = d.provider ?? "none";
      const keyInput = h("input", {
        class: "field",
        type: "password",
        autocomplete: "off",
        spellcheck: "false",
        placeholder: t("desktop.settingsSearch.pasteTheKeyStoredOnly"),
        "aria-label": t("desktop.settingsSearch.searchServiceKey"),
      }) as HTMLInputElement;
      const urlInput = h("input", {
        class: "field",
        type: "url",
        placeholder: "http://127.0.0.1:8888",
        value: d.searxngUrl ?? "",
        "aria-label": t("desktop.settingsSearch.searxngAddress"),
      }) as HTMLInputElement;
      const fields = h("div", { class: "st-search-fields" });
      const drawFields = () => {
        const saved = pick === "none" ? null : d.keys[pick];
        const kids: Array<Node | null> = [
          pick === "searxng"
            ? h(
                "label",
                { class: "lc-field" },
                h("span", { class: "lc-label" }, t("desktop.settingsSearch.searxngAddress")),
                urlInput,
              )
            : null,
          pick !== "none"
            ? h(
                "label",
                { class: "lc-field" },
                h(
                  "span",
                  { class: "lc-label" },
                  pick === "searxng"
                    ? t("desktop.settingsSearch.accessTokenOptionalForA")
                    : t("desktop.settingsSearch.apiKey"),
                  saved
                    ? h("span", { class: "st-restart" }, t("desktop.settingsSearch.saved", { saved }))
                    : null,
                ),
                keyInput,
              )
            : null,
          pick === "searxng"
            ? h("p", { class: "lc-help" }, t("desktop.settingsSearch.searxngNeedsJsonAddedTo"))
            : null,
        ];
        fields.replaceChildren(...kids.filter((x): x is Node => !!x));
      };
      const radios = h(
        "div",
        { class: "st-choice", role: "radiogroup", "aria-label": t("desktop.settingsSearch.searchService") },
        ...LABELS.map(([v, label, help]) =>
          h(
            "label",
            { class: "st-option" },
            h("input", {
              type: "radio",
              name: "web-search",
              value: v,
              ...(v === pick ? { checked: true } : {}),
              onchange: () => {
                pick = v;
                drawFields();
              },
            }),
            h("span", { class: "st-option-text" }, h("b", {}, label), h("small", {}, help)),
          ),
        ),
      );
      drawFields();
      const save = async () => {
        try {
          const key = keyInput.value.trim();
          await put({
            provider: pick === "none" ? null : pick,
            ...(pick === "searxng" ? { searxngUrl: urlInput.value.trim() || null } : {}),
            ...(key ? { key } : {}),
          });
          keyInput.value = "";
          reload({
            text:
              pick === "none"
                ? t("desktop.settingsSearch.webSearchTurnedOff")
                : t("desktop.settingsSearch.savedAvailableFromTheNext"),
            tone: "ok",
          });
        } catch (e) {
          reload({ text: t("common.notSaved", { e: errText(e) }), tone: "bad" });
        }
      };
      const clear = async (p: Provider) => {
        try {
          await api.call("DELETE", `/api/settings/search/key/${p}`);
          reload({ text: t("desktop.settingsSearch.keyDeleted"), tone: "ok" });
        } catch (e) {
          reload({ text: t("desktop.settingsSearch.notDeleted", { e: errText(e) }), tone: "bad" });
        }
      };
      return [
        h("p", { class: "lc-help" }, t("desktop.settingsSearch.onceYouPickASearch")),
        radios,
        fields,
        h(
          "div",
          { class: "st-row" },
          button(t("common.save"), () => void save(), { id: "search-save" }),
          ...(["brave", "tavily", "searxng"] as Provider[])
            .filter((p) => d.keys[p])
            .map((p) =>
              button(t("desktop.settingsSearch.deleteTheKey", { p }), () => void clear(p), {
                danger: true,
                id: `search-clear-${p}`,
              }),
            ),
        ),
        note(
          d.available
            ? t("desktop.settingsSearch.nowGeneralWorkersCanSearch")
            : t("desktop.settingsSearch.nowNoWebSearchUses"),
        ),
      ];
    },
  );
  return section("search", t("desktop.settingsSearch.webSearch"), body);
}
