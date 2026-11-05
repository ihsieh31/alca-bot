// P13 settings in a bot's 進階: its working folder, the optional shell review
// (off by default) and 提前做 with quiet hours. Kept apart from bot-edit.ts so
// the editor stays small; the server checks every value again.
// P14: for a bot that exists, 指令審查 and 提前做 are add-ons in the 擴充 tab
// (same columns, same meaning); only a new bot sets them here.
import type { BotInput, Team, TeamBot } from "./api-team.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";

type Field = (label: string, control: HTMLElement, hint?: string, forId?: string) => HTMLElement;

const toggle = (id: string, on: boolean, label: string) => {
  const box = h("input", { type: "checkbox", id, ...(on ? { checked: true } : {}) }) as HTMLInputElement;
  return { el: h("label", { class: "be-toggle", for: id }, box, h("span", {}, label)), box };
};

export function p13Fields(
  bot: TeamBot | undefined,
  team: Team,
  field: Field,
): { elements: HTMLElement[]; values(): Partial<BotInput> } {
  const folder = h("input", {
    class: "cn-input",
    id: "be-workdir",
    value: bot?.workDir ?? "",
    maxlength: "1000",
    placeholder: bot?.workDirNow ?? t("desktop.botP13.defaultThisBotsOwnWork"),
  }) as HTMLInputElement;
  const review = toggle(
    "be-review",
    bot?.shellReview === "on",
    t("desktop.botP13.underAutonomousHaveAModel"),
  );
  const reviewEngine = h(
    "select",
    { class: "cn-input", id: "be-review-engine" },
    h("option", { value: "" }, t("desktop.botP13.useThisBotsOwnModel")),
    ...team.engines
      .filter((e) => e.id !== "default")
      .map((e) =>
        h("option", { value: e.id, ...(bot?.shellReviewEngine === e.id ? { selected: true } : {}) }, e.label),
      ),
  ) as HTMLSelectElement;
  const reviewModel = h("input", {
    class: "cn-input",
    id: "be-review-model",
    value: bot?.shellReviewModel ?? "",
    maxlength: "200",
    placeholder: t("desktop.botP13.modelOptionalEGA"),
  }) as HTMLInputElement;
  // A model only means something with a picked engine (the server ignores it otherwise).
  const syncModel = () => {
    reviewModel.disabled = !reviewEngine.value;
  };
  reviewEngine.addEventListener("change", syncModel);
  syncModel();
  const early = toggle("be-early", bot?.earlyWork === "on", t("desktop.botP13.prepareDraftsInTheBackground"));
  const quiet = h("input", {
    class: "cn-input",
    id: "be-quiet",
    value: bot?.quietHours ?? "",
    maxlength: "11",
    placeholder: t("desktop.botP13.quietHoursEG22"),
  }) as HTMLInputElement;
  const folderField = field(
    t("desktop.botP13.workFolder"),
    folder,
    bot?.workDirProblem
      ? t("desktop.botP13.thisSettingIsntInUse", { workDirProblem: bot.workDirProblem })
      : t("desktop.botP13.theEngineAndFileTools"),
    "be-workdir",
  );
  const elements = [
    folderField,
    field(
      t("desktop.botP13.commandReview"),
      h("div", { class: "be-stack" }, review.el, reviewEngine, reviewModel),
      t("desktop.botP13.optionalOffByDefaultWhen"),
    ),
    field(
      t("common.workAhead"),
      h("div", { class: "be-stack" }, early.el, quiet),
      t("desktop.botP13.thingsPreparedInTheBackground"),
    ),
  ];
  if (bot)
    return {
      elements: [folderField, h("p", { class: "be-hint" }, t("desktop.botP13.commandReviewAndWorkAhead"))],
      values: () => ({ workDir: folder.value.trim() || null }),
    };
  return {
    elements,
    values: () => ({
      workDir: folder.value.trim() || null,
      shellReview: review.box.checked ? "on" : "off",
      shellReviewEngine: reviewEngine.value || null,
      shellReviewModel: (reviewEngine.value && reviewModel.value.trim()) || null,
      earlyWork: early.box.checked ? "on" : "off",
      quietHours: quiet.value.trim() || null,
    }),
  };
}
