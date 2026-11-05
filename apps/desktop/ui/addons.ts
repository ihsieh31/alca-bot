// P14: the bot editor's 擴充 tab — one row per built-in add-on: its name and
// one line, a vermilion 「會自己消耗額度」 for the ones that spend on their own,
// the switch, today's usage against the cap, and its settings folded away.
// A switch or a saved setting goes to the server at once (it checks every
// value again); the editor's own 儲存 is for the bot's profile.
import type { AddonView, ModelChoice, TeamClient } from "./api-team.ts";
import { h } from "./dom.ts";
import { locale, t } from "./i18n/index.ts";

const LABEL: Record<string, string> = {
  maxPerDay: t("desktop.addons.maxPushesPerDay"),
  quietHours: t("desktop.addons.quietHours"),
  minIntervalHours: t("desktop.addons.minimumGapBetweenPushesHours"),
  scanMinutes: t("desktop.addons.checkEveryMinutes"),
  sources: t("desktop.addons.sourcesToWatch"),
  calendar: t("desktop.addons.calendar"),
  mail: t("desktop.addons.mail"),
  alca: t("desktop.addons.alcasOwnStatus"),
  deadlines: t("desktop.addons.deadlinesMentionedInChats"),
  dailyTokenCap: t("desktop.addons.dailyTokenCap"),
  dailyRunCap: t("desktop.addons.dailyRunCap"),
  timeoutSec: t("desktop.addons.checkTimeoutSeconds"),
  engine: t("desktop.addons.modelServiceForReview"),
  model: t("common.model"),
  checkModel: t("common.modelForChecks"),
};

const COST: Record<AddonView["costClass"], string> = {
  proactive: t("common.usesCreditsOnItsOwn"),
  on_use: t("desktop.addons.usesCreditsOnlyWhenUsed"),
  none: "",
};

const fmt = (n: number) => n.toLocaleString(locale());

export function usageLine(a: AddonView): string {
  const u = a.usage;
  if (!u) return "";
  if (u.capped) return t("desktop.addons.todaysAllowanceIsUsedUp");
  const parts: string[] = [];
  if (u.tokenCap !== null)
    parts.push(t("common.tokens", { tokens: fmt(u.tokens), tokenCap: fmt(u.tokenCap) }));
  if (u.runCap !== null) parts.push(t("common.runs", { runs: u.runs, runCap: u.runCap }));
  return parts.length ? t("common.today", { p0: parts.join(t("common.joinComma")) }) : "";
}

type Read = () => unknown;

const choiceKey = (c: { engine: string | null; model: string | null }) =>
  c.engine === null ? "" : `${c.engine}\u0000${c.model ?? ""}`;

/**
 * 回覆檢查's model: one list of the bot's configured models, its own router
 * model first (the default). A stored pick that is no longer configured
 * shows as such (the check then runs on the router model).
 */
export function modelPicker(
  choices: readonly ModelChoice[],
  current: { engine: string | null; model: string | null },
  id: string,
): { el: HTMLSelectElement; read: () => { engine: string | null; model: string | null } } {
  const now = choiceKey(current);
  const list = [...choices];
  if (!list.some((c) => choiceKey(c) === now))
    list.push({
      ...current,
      label: t("desktop.addons.noLongerAvailableUsingThe", {
        engine: current.engine,
        model: current.model ?? t("common.defaultModel"),
      }),
    });
  const el = h(
    "select",
    { class: "cn-input", id },
    ...list.map((c) =>
      h("option", { value: choiceKey(c), ...(choiceKey(c) === now ? { selected: true } : {}) }, c.label),
    ),
  ) as HTMLSelectElement;
  return {
    el,
    read: () => {
      const c = list.find((x) => choiceKey(x) === el.value);
      return c ? { engine: c.engine, model: c.model } : { engine: null, model: null };
    },
  };
}

function control(key: string, value: unknown, id: string): { el: HTMLElement; read: Read } {
  if (typeof value === "boolean") {
    const box = h("input", { type: "checkbox", id, ...(value ? { checked: true } : {}) }) as HTMLInputElement;
    return {
      el: h("label", { class: "be-toggle", for: id }, box, h("span", {}, LABEL[key] ?? key)),
      read: () => box.checked,
    };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const subs = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => [k, control(k, v, `${id}-${k}`)] as const,
    );
    return {
      el: h("div", { class: "ad-group" }, ...subs.map(([, c]) => c.el)),
      read: () => Object.fromEntries(subs.map(([k, c]) => [k, c.read()])),
    };
  }
  if (typeof value === "number") {
    const input = h("input", {
      class: "cn-input",
      type: "number",
      id,
      value: String(value),
      step: "any",
    }) as HTMLInputElement;
    return { el: input, read: () => Number(input.value) };
  }
  const input = h("input", {
    class: "cn-input",
    id,
    value: typeof value === "string" ? value : "",
    maxlength: "200",
    placeholder: key === "quietHours" ? t("desktop.addons.eG220008") : t("desktop.addons.blankUseTheDefault"),
  }) as HTMLInputElement;
  return { el: input, read: () => input.value.trim() || null };
}

function row(client: TeamClient, botId: string, start: AddonView, error: (e: unknown) => void): HTMLElement {
  let a = start;
  const el = h("li", { class: "ad-row", "data-addon": a.id });
  const render = () => {
    const sw = h("input", {
      type: "checkbox",
      role: "switch",
      class: "ad-switch",
      id: `ad-${a.id}`,
      "aria-label": t("desktop.addons.text", {
        name: a.name,
        p1: a.enabled ? t("common.on") : t("common.off"),
      }),
      ...(a.enabled ? { checked: true } : {}),
      ...(!a.enabled && a.unmet.length ? { disabled: true } : {}),
      onchange: () => {
        sw.disabled = true;
        void client.setAddon(botId, a.id, { enabled: sw.checked }).then(
          (v) => {
            a = v;
            render();
          },
          (e) => {
            sw.checked = a.enabled;
            sw.disabled = false;
            error(e);
          },
        );
      },
    }) as HTMLInputElement;
    const picks = a.modelChoices;
    const fields: Array<readonly [string, { el: HTMLElement; read: Read }]> = Object.entries(a.settings)
      .filter(([k]) => !(picks && (k === "engine" || k === "model")))
      .map(([k, v]) => [k, control(k, v, `ad-${a.id}-${k}`)] as const);
    const picker = picks
      ? modelPicker(
          picks,
          {
            engine: (a.settings.engine as string | null) ?? null,
            model: (a.settings.model as string | null) ?? null,
          },
          `ad-${a.id}-checkModel`,
        )
      : undefined;
    if (picker) fields.unshift(["checkModel", picker]);
    const msg = h("p", { class: "ad-msg", role: "status" });
    const save = h(
      "button",
      {
        class: "btn btn-quiet",
        type: "button",
        onclick: () => {
          save.disabled = true;
          const settings = Object.fromEntries(
            fields.filter(([k]) => k !== "checkModel").map(([k, c]) => [k, c.read()]),
          );
          if (picker) Object.assign(settings, picker.read());
          void client.setAddon(botId, a.id, { settings }).then(
            (v) => {
              a = v;
              render();
            },
            (e) => {
              save.disabled = false;
              msg.textContent = String((e as Error)?.message ?? e);
            },
          );
        },
      },
      t("desktop.addons.saveSettings"),
    ) as HTMLButtonElement;
    const usage = usageLine(a);
    el.dataset.enabled = a.enabled ? "true" : "false";
    const more = fields.length
      ? [
          h(
            "details",
            { class: "ad-more" },
            h("summary", {}, t("common.settings")),
            h(
              "div",
              { class: "ad-fields" },
              ...fields.map(([k, c]) =>
                typeof a.settings[k] === "boolean"
                  ? c.el
                  : h(
                      "div",
                      { class: "be-field" },
                      h("label", { class: "be-label", for: `ad-${a.id}-${k}` }, LABEL[k] ?? k),
                      c.el,
                    ),
              ),
              picker
                ? h("p", { class: "be-hint ad-note" }, t("desktop.addons.checksAndRewritesBothUse"))
                : null,
              ...a.notes.map((n) => h("p", { class: "be-hint ad-note" }, n)),
              h("div", { class: "ad-actions" }, msg, save),
            ),
          ),
        ]
      : [];
    el.replaceChildren(
      h(
        "div",
        { class: "ad-head" },
        h(
          "div",
          { class: "ad-text" },
          h("label", { class: "ad-name", for: `ad-${a.id}` }, a.name),
          COST[a.costClass]
            ? h("span", { class: "ad-cost", "data-cost": a.costClass }, COST[a.costClass])
            : null,
          h("p", { class: "ad-desc" }, a.description),
          usage
            ? h("p", { class: "ad-usage", "data-capped": a.usage?.capped ? "true" : "false" }, usage)
            : null,
          ...a.unmet.map((u) => h("p", { class: "ad-unmet" }, t("common.cantTurnOnYet", { u }))),
        ),
        sw,
      ),
      ...more,
    );
  };
  render();
  return el;
}

/** The 擴充 pane for one bot: loads the list, then each row talks to the server on its own. */
export function addonsPane(client: TeamClient, botId: string, error: (e: unknown) => void): HTMLElement {
  const list = h(
    "ul",
    { class: "ad-list", "aria-label": t("common.addOns") },
    h("li", { class: "pv-empty" }, t("common.loadingAddOns")),
  );
  void client.addons(botId).then(
    (r) => list.replaceChildren(...r.addons.map((a) => row(client, botId, a, error))),
    (e) => {
      list.replaceChildren(h("li", { class: "tm-err" }, String((e as Error)?.message ?? e)));
    },
  );
  return h(
    "div",
    { class: "ad-pane" },
    h("p", { class: "be-hint" }, t("desktop.addons.addOnsAreOffBy")),
    list,
  );
}
