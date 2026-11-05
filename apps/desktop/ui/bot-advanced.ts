// Phase 6: a bot's 進階 harness settings in the editor — default harness
// (自動 / 程式 / 一般), the independent reviewer (off by default), the 完全授權
// switch (a warning and a second confirm before it is on) and the budget caps
// per harness. The wording and rules are in bot-advanced-model.ts.
import type { TeamBot } from "./api-team.ts";
import {
  type DefaultHarness,
  FULL_ACCESS_WARNING,
  type FullAccessStep,
  fullAccessNext,
  HARNESS_CAPS,
  type HarnessBody,
  type HarnessDraft,
  type HarnessKind,
  harnessBody,
  harnessDraft,
  REVIEWER_NOTE,
  TOKEN_CAP_PLACEHOLDER,
} from "./bot-advanced-model.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { popup } from "./popup.ts";

type Field = (label: string, control: HTMLElement, hint?: string, forId?: string) => HTMLElement;

export interface AdvancedHarness {
  elements: HTMLElement[];
  /** The switch, confirmed on or not (a warning still open counts as off). */
  fullAccess(): FullAccessStep;
  harness(): HarnessBody;
}

export function harnessFields(
  bot: TeamBot | undefined,
  startFull: FullAccessStep,
  field: Field,
): AdvancedHarness {
  const d: HarnessDraft = harnessDraft(bot?.harness);
  let full: FullAccessStep = startFull;

  const pick = popup(
    "be-harness",
    d.default,
    [
      ["auto", t("common.auto")],
      ["coding", t("common.code")],
      ["general", t("common.general")],
    ] as Array<[DefaultHarness, string]>,
    (v) => (d.default = v),
  ).el;

  const reviewBox = h("input", {
    type: "checkbox",
    id: "be-reviewer",
    ...(d.reviewer ? { checked: true } : {}),
  }) as HTMLInputElement;
  reviewBox.addEventListener("change", () => (d.reviewer = reviewBox.checked));

  // 完全授權: off → warning (confirm / cancel) → on; on → off at once.
  const fullBox = h("input", {
    type: "checkbox",
    id: "be-full",
    role: "switch",
    ...(full === "on" ? { checked: true } : {}),
  }) as HTMLInputElement;
  const fullHost = h("div", { class: "be-full-host" });
  const paintFull = () => {
    fullBox.checked = full === "on";
    fullBox.setAttribute("aria-checked", String(full === "on"));
    if (full !== "warn") {
      fullHost.replaceChildren(
        full === "on" ? h("p", { class: "be-warn", role: "status" }, FULL_ACCESS_WARNING) : "",
      );
      return;
    }
    const no = h(
      "button",
      { class: "btn btn-quiet", type: "button", onclick: () => step("cancel") },
      t("common.notNow2"),
    );
    const yes = h(
      "button",
      { class: "btn btn-danger", type: "button", onclick: () => step("confirm") },
      t("desktop.botAdvanced.iUnderstandTurnOnFull"),
    );
    fullHost.replaceChildren(
      h(
        "div",
        {
          class: "be-confirm-box",
          role: "alertdialog",
          "aria-label": t("desktop.botAdvanced.confirmFullAccess"),
        },
        h("b", {}, t("desktop.botAdvanced.turnOnFullAccess")),
        h("p", {}, FULL_ACCESS_WARNING),
        h("div", { class: "be-confirm-actions" }, no, yes),
      ),
    );
    no.focus();
  };
  const step = (action: "toggle" | "confirm" | "cancel") => {
    full = fullAccessNext(full, action, "desktop").step;
    paintFull();
  };
  fullBox.addEventListener("click", (e) => {
    e.preventDefault();
    step("toggle");
  });
  paintFull();

  const capInput = (k: HarnessKind, key: "maxSteps" | "maxMinutes" | "maxTokens", ph: string, name = ph) => {
    const el = h("input", {
      class: "cn-input",
      inputmode: "numeric",
      id: `be-cap-${k}-${key}`,
      value: d.caps[k][key],
      placeholder: ph,
      "aria-label": `${k === "coding" ? t("common.code") : t("common.general")} ${name}`,
    }) as HTMLInputElement;
    el.addEventListener("input", () => (d.caps[k][key] = el.value));
    return el;
  };
  const caps = h(
    "div",
    { class: "be-caps" },
    ...(["coding", "general"] as const).map((k) =>
      h(
        "div",
        { class: "be-cap-row" },
        h("span", { class: "be-label" }, k === "coding" ? t("common.code") : t("common.general")),
        capInput(
          k,
          "maxSteps",
          t("desktop.botAdvanced.stepsDefault", { maxSteps: HARNESS_CAPS[k].maxSteps }),
        ),
        capInput(
          k,
          "maxMinutes",
          t("desktop.botAdvanced.minutesDefault", { maxMinutes: HARNESS_CAPS[k].maxMinutes }),
        ),
        capInput(
          k,
          "maxTokens",
          TOKEN_CAP_PLACEHOLDER,
          t("desktop.botAdvanced.tokensDefaultFollowsTheSystem"),
        ),
      ),
    ),
  );

  return {
    elements: [
      field(
        t("desktop.botAdvanced.defaultHarness"),
        pick,
        t("desktop.botAdvanced.whichOneWhenTheRouter"),
        "be-harness",
      ),
      field(
        t("desktop.botAdvanced.independentReview"),
        h(
          "label",
          { class: "be-toggle", for: "be-reviewer" },
          reviewBox,
          h("span", {}, t("desktop.botAdvanced.whenAWorkerSaysIts")),
        ),
        t("desktop.botAdvanced.optionalOffByDefaultUses", { REVIEWER_NOTE }),
      ),
      field(
        t("common.fullAccess"),
        h(
          "div",
          { class: "be-stack" },
          h(
            "label",
            { class: "be-toggle", for: "be-full" },
            fullBox,
            h("span", {}, t("desktop.botAdvanced.thisBotNoLongerAsks")),
          ),
          fullHost,
        ),
        t("desktop.botAdvanced.canOnlyBeTurnedOn"),
      ),
      field(t("desktop.botAdvanced.budgetLimits"), caps, t("desktop.botAdvanced.blankUseTheDefaultCan")),
    ],
    fullAccess: () => full,
    harness: () => harnessBody(d),
  };
}
