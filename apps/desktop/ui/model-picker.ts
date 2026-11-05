// 選供應商 → 選模型 (P11): the provider list (six pinned, the rest folded under
// 更多供應商) with each one's status chip and one-line fix, then a searchable
// model list with context and price when known, and a free-form model id.
import {
  contextWord,
  KIND_WORD,
  type ModelInfo,
  type ModelList,
  type ProviderView,
  priceWord,
  STATUS_WORD,
} from "./api-providers.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";

/** Two-letter marks for the built-in providers (no vendor logos). */
const MARKS: Record<string, string> = {
  "claude-code": "CC",
  codex: "CX",
  "gemini-cli": "GC",
  opencode: "OC",
  openai: "OA",
  openrouter: "OR",
  "grok-cli": "GK",
  "kimi-cli": "KM",
  "qwen-code": "QW",
  "cursor-cli": "CU",
  "factory-droid": "FD",
  antigravity: "AG",
  anthropic: "AN",
  gemini: "GM",
  mistral: "MI",
  minimax: "MX",
  cerebras: "CB",
  groq: "GQ",
  deepseek: "DS",
  xai: "XA",
  together: "TG",
  fireworks: "FW",
  ollama: "OL",
  lmstudio: "LM",
};

/** The two-letter mark of a provider (no vendor logos). */
export function markOf(label: string, id?: string): string {
  if (id && MARKS[id]) return MARKS[id];
  const words = label
    .replace(/[（(].*$/, "")
    .trim()
    .split(/[\s-]+/);
  const a = words[0]?.[0] ?? "?";
  const b = words.length > 1 ? (words[1]?.[0] ?? "") : (words[0]?.[1] ?? "");
  return (a + b).replace(/^(.)(.)$/, (_m, x: string, y: string) => x.toUpperCase() + y.toLowerCase());
}

export function statusChip(p: Pick<ProviderView, "status">): HTMLElement {
  return h("span", { class: "pv-chip", "data-status": p.status }, STATUS_WORD[p.status]);
}

export interface ProviderListOptions {
  providers: ProviderView[];
  selected: string | null;
  /** A first row for the team's default engine (bot editor). */
  defaultRow?: { label: string; hint: string };
  onPick(id: string): void;
  /** Extra content under a row (settings: its details when open). */
  detail?: (p: ProviderView) => HTMLElement | null;
  /** Settings: rows are expandable cards rather than radio rows. */
  compact?: boolean;
  /** Bot editor: one line per provider; the fix only for one that is not ready. */
  dense?: boolean;
}

function row(p: ProviderView, o: ProviderListOptions): HTMLElement {
  const sel = o.selected === p.id;
  const btn = h(
    "button",
    {
      class: "pv-row",
      type: "button",
      role: "radio",
      "aria-checked": sel ? "true" : "false",
      "data-id": p.id,
      onclick: () => o.onPick(p.id),
    },
    h("span", { class: "pv-mark", "aria-hidden": "true" }, markOf(p.label, p.id)),
    h(
      "span",
      { class: "pv-main" },
      h(
        "span",
        { class: "pv-name" },
        p.label,
        h("span", { class: "pv-kind" }, p.custom ? t("desktop.modelPicker.custom") : KIND_WORD[p.kind]),
      ),
      // §1.6: the install command or key hint is the fix, shown when the row opens (title meanwhile).
      o.dense && p.status === "ready" ? null : h("span", { class: "pv-hint" }, p.blurb || p.hint),
    ),
    statusChip(p),
  );
  if (p.status !== "ready" && p.hint) btn.title = p.hint;
  const extra = o.detail?.(p);
  return extra
    ? h("div", { class: "pv-item", "data-open": "true" }, btn, extra)
    : h("div", { class: "pv-item" }, btn);
}

export function providerList(o: ProviderListOptions): HTMLElement {
  const pinned = o.providers.filter((p) => p.pinned);
  const rest = o.providers.filter((p) => !p.pinned);
  const restOpen = !!o.selected && rest.some((p) => p.id === o.selected);
  const list = h(
    "div",
    {
      class: "pv-list",
      role: "radiogroup",
      "aria-label": t("common.provider"),
      ...(o.compact ? { "data-compact": "true" } : {}),
    },
    o.defaultRow
      ? h(
          "div",
          { class: "pv-item" },
          h(
            "button",
            {
              class: "pv-row",
              type: "button",
              role: "radio",
              "aria-checked": o.selected === "default" ? "true" : "false",
              "data-id": "default",
              onclick: () => o.onPick("default"),
            },
            h(
              "span",
              { class: "pv-mark", "data-default": "true", "aria-hidden": "true" },
              t("desktop.modelPicker.d"),
            ),
            h(
              "span",
              { class: "pv-main" },
              h("span", { class: "pv-name" }, o.defaultRow.label),
              o.dense ? null : h("span", { class: "pv-hint" }, o.defaultRow.hint),
            ),
          ),
        )
      : null,
    ...pinned.map((p) => row(p, o)),
    rest.length
      ? h(
          "details",
          { class: "pv-more", ...(restOpen ? { open: true } : {}) },
          h(
            "summary",
            { class: "pv-more-sum" },
            t("desktop.modelPicker.moreProviders"),
            h("span", { class: "pv-count" }, String(rest.length)),
          ),
          h("div", { class: "pv-more-body" }, ...rest.map((p) => row(p, o))),
        )
      : null,
  );
  return list;
}

/** The chosen provider as one row with 更換 (the bot editor keeps the list folded). */
export function chosenRow(
  p: ProviderView | undefined,
  fallback: { label: string; hint: string },
  onChange: () => void,
): HTMLElement {
  return h(
    "button",
    { class: "pv-row pv-chosen", type: "button", "aria-expanded": "false", onclick: onChange },
    h(
      "span",
      { class: "pv-mark", "aria-hidden": "true", ...(p ? {} : { "data-default": "true" }) },
      p ? markOf(p.label, p.id) : t("desktop.modelPicker.d"),
    ),
    h(
      "span",
      { class: "pv-main" },
      h(
        "span",
        { class: "pv-name" },
        p?.label ?? fallback.label,
        p
          ? h("span", { class: "pv-kind" }, p.custom ? t("desktop.modelPicker.custom") : KIND_WORD[p.kind])
          : null,
      ),
      h("span", { class: "pv-hint" }, p ? p.blurb || p.hint : fallback.hint),
    ),
    h(
      "span",
      { class: "pv-end" },
      p ? statusChip(p) : null,
      h("span", { class: "pv-change" }, t("common.replace")),
    ),
  );
}

export interface ModelPickerOptions {
  value: string;
  load(refresh: boolean): Promise<ModelList>;
  onChange(model: string): void;
  placeholder?: string;
}

/** A searchable model list; typing an id that is not in it offers it as a custom id. */
export function modelPicker(o: ModelPickerOptions): HTMLElement {
  let value = o.value;
  let models: ModelInfo[] = [];
  let note = "";
  let source = "";
  const search = h("input", {
    class: "cn-input pv-search",
    type: "search",
    placeholder: o.placeholder ?? t("desktop.modelPicker.searchModelsOrTypeA"),
    "aria-label": t("desktop.modelPicker.searchModels"),
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const listEl = h("div", { class: "pv-models", role: "listbox", "aria-label": t("common.model") });
  const foot = h("p", { class: "pv-models-foot" });
  const refresh = h(
    "button",
    { class: "lb-act", type: "button", onclick: () => void load(true) },
    t("desktop.modelPicker.refreshTheList"),
  ) as HTMLButtonElement;
  const pick = (id: string) => {
    value = id;
    o.onChange(id);
    render();
  };
  const option = (m: ModelInfo, custom = false, note = "") => {
    const ctx = contextWord(m.contextTokens);
    const price = priceWord(m);
    return h(
      "button",
      {
        class: "pv-model",
        type: "button",
        role: "option",
        "aria-selected": m.id === value ? "true" : "false",
        "data-id": m.id,
        title: m.id,
        onclick: () => pick(m.id),
      },
      h(
        "span",
        { class: "pv-model-id" },
        custom ? h("span", { class: "pv-model-new" }, t("desktop.modelPicker.useACustomId")) : null,
        h(
          "span",
          { class: "pv-model-name" },
          m.label && m.label !== m.id && !custom && !note ? m.label : m.id,
        ),
        note ? h("span", { class: "pv-model-label" }, note) : null,
      ),
      h(
        "span",
        { class: "pv-model-meta" },
        ctx ? h("span", { title: "context" }, ctx) : null,
        price ? h("span", { title: t("desktop.modelPicker.perMillionTokensInputOutput") }, price) : null,
      ),
    );
  };
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const shown = models.filter(
      (m) => !q || m.id.toLowerCase().includes(q) || m.label?.toLowerCase().includes(q),
    );
    const rows: HTMLElement[] = [];
    const typed = search.value.trim();
    if (typed && !/\s/.test(typed) && !models.some((m) => m.id === typed))
      rows.push(option({ id: typed }, true));
    if (value && !models.some((m) => m.id === value) && value !== typed)
      rows.push(option({ id: value }, false, t("desktop.modelPicker.currentSetting")));
    rows.push(...shown.slice(0, 200).map((m) => option(m)));
    listEl.replaceChildren(
      ...(rows.length
        ? rows
        : [
            h(
              "p",
              { class: "pv-empty" },
              models.length
                ? t("desktop.modelPicker.noMatchingModels")
                : t("desktop.modelPicker.theListIsEmptyType"),
            ),
          ]),
    );
    const src =
      source === "api"
        ? t("desktop.modelPicker.liveList")
        : source === "cli"
          ? t("desktop.modelPicker.listFromTheCli")
          : source
            ? t("desktop.modelPicker.builtInList")
            : "";
    foot.replaceChildren(
      h(
        "span",
        {},
        [src && t("desktop.modelPicker.text", { src, modelsCount: models.length }), note]
          .filter(Boolean)
          .join(t("common.joinComma")),
      ),
      refresh,
    );
  };
  const load = async (fresh: boolean) => {
    refresh.disabled = true;
    listEl.replaceChildren(h("p", { class: "pv-empty" }, t("desktop.modelPicker.loadingTheModelList")));
    try {
      const r = await o.load(fresh);
      models = r.models;
      note = r.note ?? "";
      source = r.source;
    } catch (e) {
      note = String((e as Error)?.message ?? e);
    }
    refresh.disabled = false;
    render();
  };
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const typed = search.value.trim();
      if (typed && !/\s/.test(typed)) pick(typed);
    }
  });
  void load(false);
  return h("div", { class: "pv-picker" }, search, listEl, foot);
}
