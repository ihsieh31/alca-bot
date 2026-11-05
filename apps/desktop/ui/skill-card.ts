// A proposed skill, drawn as a card: in the chat right after the task it came
// from, and at the top of the 技能 tab. Saving it is the person's decision;
// a saved skill never changes what Alca asks before paying, sending,
// deleting or publishing.
import type { Skill, SkillVersionView } from "./api.ts";
import { plainStep } from "./approval-card.ts";
import { h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { icon as plainIcon } from "./icons.ts";

export const CLASS_LABEL: Record<string, string> = {
  payment: tx("common.pay"),
  send: tx("common.send"),
  delete: tx("common.delete"),
  publish: tx("common.publish2"),
  write: tx("common.write"),
  network: tx("common.network"),
  execute: tx("desktop.skillCard.run"),
  read: tx("common.read"),
};

export interface SkillCardActions {
  approve(id: string, edit?: { name?: string; triggers?: string[]; steps?: string[] }): Promise<void>;
  reject(id: string): Promise<void>;
  /** Open the 技能 tab on this skill (chat card only). */
  open?(id: string): void;
}

/** The steps of a version as a numbered list; a step Alca always asks about carries a lock (§3.5). */
export function stepList(v: SkillVersionView): HTMLElement {
  const always = new Set(v.alwaysConfirm);
  return h(
    "ol",
    { class: "sk-steps" },
    ...v.steps.map((s) => {
      const asks = Boolean(s.actionClass && always.has(s.actionClass));
      return h(
        "li",
        { "data-asks": asks ? "true" : undefined },
        h("span", { class: "sk-step-text", title: s.text }, plainStep(s.text)),
        asks
          ? h(
              "span",
              {
                class: "sk-lock",
                title: `${CLASS_LABEL[s.actionClass ?? ""] ?? s.actionClass}: ${tx("desktop.skillCard.alwaysAsks")}`,
                "aria-label": tx("desktop.skillCard.alwaysAsks"),
              },
              plainIcon("lock"),
            )
          : null,
      );
    }),
  );
}

/** 「說到「整理週報」或「週報」時會用這個做法」: one plain line, no chips. */
export function triggerLine(v: SkillVersionView): HTMLElement | null {
  if (!v.triggers.length) return null;
  return h(
    "p",
    { class: "sk-when" },
    tx("desktop.skillCard.triggerLine", { words: v.triggers.join(tx("desktop.skillCard.triggerJoin")) }),
  );
}

/** Inline editor: name, triggers (one per line or 、), steps (one per line). */
function editor(
  v: SkillVersionView,
  save: (e: { name: string; triggers: string[]; steps: string[] }) => void,
  cancel: () => void,
) {
  const name = h("input", {
    class: "field sk-field",
    value: v.name,
    "aria-label": tx("common.name"),
    maxlength: "40",
  });
  const triggers = h("input", {
    class: "field sk-field",
    value: v.triggers.join(tx("common.text")),
    "aria-label": tx("common.triggerWords"),
  });
  const steps = h("textarea", {
    class: "field sk-area",
    rows: String(Math.max(3, v.steps.length + 1)),
    "aria-label": tx("desktop.skillCard.steps"),
  });
  steps.value = v.steps.map((s) => s.text).join("\n");
  return h(
    "div",
    { class: "sk-edit" },
    h("label", { class: "sk-field" }, h("span", {}, tx("common.name")), name),
    h(
      "label",
      { class: "sk-field" },
      h("span", {}, tx("desktop.skillCard.triggerWordsSeparatedByCommas")),
      triggers,
    ),
    h("label", { class: "sk-field" }, h("span", {}, tx("desktop.skillCard.stepsOnePerLine")), steps),
    h(
      "div",
      { class: "card-actions" },
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: () =>
            save({
              name: name.value,
              triggers: triggers.value
                .split(/[、,，\n]/)
                .map((t) => t.trim())
                .filter(Boolean),
              steps: steps.value
                .split("\n")
                .map((t) => t.trim())
                .filter(Boolean),
            }),
        },
        tx("common.save"),
      ),
      h("button", { class: "btn btn-quiet", type: "button", onclick: cancel }, tx("common.cancel")),
    ),
  );
}

export { editor as skillEditor };

/** The proposal card (§3.5 visual language, routine tier). `compact`: the chat version (steps folded to three). */
export function proposalCard(s: Skill, act: SkillCardActions, compact = false): HTMLElement {
  const v = s.pending;
  const el = h("article", { class: "item card sk-card", "data-skill": s.id });
  if (!v) return el;
  const danger = v.alwaysConfirm.length > 0;
  const revision = s.version > 0;
  const shown: SkillVersionView = compact && v.steps.length > 3 ? { ...v, steps: v.steps.slice(0, 3) } : v;
  const steps = tx("common.steps", { stepsCount: v.steps.length });
  const sub = revision
    ? tx("desktop.skillCard.skillUpdateProposalVV", { version: s.version, version2: v.version })
    : s.source.threadTitle
      ? tx("desktop.skillCard.learnedFrom", { steps, threadTitle: s.source.threadTitle })
      : steps;
  const body = h(
    "div",
    { class: "sk-body" },
    h(
      "div",
      { class: "ap-head" },
      h("span", { class: "ap-icon", "aria-hidden": "true" }, plainIcon("book")),
      h(
        "div",
        { class: "ap-titles" },
        h("p", { class: "card-eyebrow" }, tx("common.learnedAMethod")),
        h("h3", { class: "ap-title", title: s.botName }, v.name),
        h("p", { class: "ap-sub" }, sub),
      ),
    ),
    stepList(shown),
    compact && v.steps.length > 3
      ? h("p", { class: "sk-more" }, tx("desktop.skillCard.moreSteps", { p0: v.steps.length - 3 }))
      : null,
    triggerLine(v),
    v.note ? h("p", { class: "sk-note" }, v.note) : null,
    h(
      "p",
      { class: "ap-lock sk-assure" },
      plainIcon("lock"),
      h("span", {}, danger ? tx("common.onceSavedAsASkill") : tx("desktop.skillCard.onceSavedAsASkill")),
    ),
  );
  const done = (text: string) => {
    el.dataset.state = "done";
    actions.replaceChildren(h("span", { class: "sk-done" }, text));
  };
  const save = h(
    "button",
    {
      class: "btn btn-primary",
      type: "button",
      onclick: () =>
        void act
          .approve(s.id)
          .then(() =>
            done(revision ? tx("desktop.skillCard.skillUpdated") : tx("desktop.skillCard.savedAsASkill")),
          ),
    },
    revision ? tx("common.applyUpdate") : tx("common.saveAsSkill"),
  );
  const edit = h(
    "button",
    {
      class: "btn btn-quiet",
      type: "button",
      onclick: () => {
        body.replaceWith(
          editor(
            v,
            (e) =>
              void act.approve(s.id, e).then(() => {
                el.querySelector(".sk-edit")?.replaceWith(body);
                actions.hidden = false;
                done(tx("desktop.skillCard.savedAsASkillWith"));
              }),
            () => {
              el.querySelector(".sk-edit")?.replaceWith(body);
              actions.hidden = false;
            },
          ),
        );
        actions.hidden = true;
      },
    },
    tx("desktop.skillCard.editEllipsis"),
  );
  const dont = h(
    "button",
    {
      class: "btn btn-quiet",
      type: "button",
      title: tx("desktop.skillCard.dontSaveWontAskAgain"),
      onclick: () => void act.reject(s.id).then(() => done(tx("desktop.skillCard.dontSaveWontAskAgain"))),
    },
    tx("desktop.approval.dont"),
  );
  const actions = h(
    "div",
    { class: "ap-foot" },
    compact && act.open
      ? h(
          "button",
          { class: "btn-link sk-open", type: "button", onclick: () => act.open?.(s.id) },
          tx("desktop.skillCard.seeItInSkills"),
        )
      : h("span"),
    h("div", { class: "ap-actions" }, dont, edit, save),
  );
  el.append(body, actions);
  return el;
}
