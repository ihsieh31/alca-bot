// P13: 新增 bot / 編輯 bot on the phone (§4.1 phone-bot-form) — a form sheet:
// 〔取消〕 title 〔新增〕, the simple fields as rows (name, role, avatar glyph,
// instructions) and 權限 as a menu row. No colour swatches: a bot is told
// apart by its name (§2.3). Provider, model, browser profile and memory stay
// on the computer. Needs `approve`; the core applies the desktop's rules again.
import { h, haptic } from "./dom.ts";
import { areaRow, fieldRow, formSheet, menuRow } from "./form-kit.ts";
import { type BotDraft, botArgs, botDraft, fullAccessOff, type Level } from "./forms-view.ts";
import { t } from "./i18n/index.ts";
import type { Session } from "./session.ts";
import type { Sheet } from "./sheet.ts";
import { LEVEL_WORD, type TeamBot } from "./team-view.ts";
import { group, row } from "./ui.ts";

const LEVELS: readonly Level[] = ["team", "autonomous", "confirm_each_step"];

export function showBotForm(s: Session, bot: TeamBot | undefined, onSaved?: (b: TeamBot) => void): Sheet {
  const d: BotDraft = botDraft(bot);
  const input = (k: "name" | "avatar" | "role", max: number, placeholder: string) => {
    const el = h("input", {
      type: "text",
      maxlength: String(max),
      placeholder,
      autocomplete: "off",
      ...(k === "name" ? { "data-autofocus": "" } : {}),
    });
    el.value = d[k];
    el.addEventListener("input", () => (d[k] = el.value));
    return el;
  };
  const instructions = h("textarea", {
    rows: 4,
    maxlength: "4000",
    placeholder: t("phone.botForm.thingsThisBotShouldKeep"),
    "aria-label": t("common.instructions"),
  });
  instructions.value = d.instructions;
  instructions.addEventListener("input", () => (d.instructions = instructions.value));
  // Phase 6: a bot at 完全授權 shows it, with a way to turn it off (never on, here).
  const level = h("div", { class: "cells" });
  const paintLevel = () =>
    level.replaceChildren(
      d.approvalLevel === "full_access"
        ? row({ title: t("common.permissions"), value: t("common.fullAccess") })
        : menuRow<Level>({
            title: t("common.permissions"),
            options: LEVELS.map((l) => [l, LEVEL_WORD[l] ?? l]),
            value: d.approvalLevel,
            onPick: (l) => {
              haptic("tap");
              d.approvalLevel = l;
            },
          }),
      ...(d.approvalLevel === "full_access"
        ? [
            row({
              title: t("phone.botForm.turnOffFullAccess"),
              tone: "danger",
              onclick: () => {
                Object.assign(d, fullAccessOff(d));
                paintLevel();
              },
            }),
          ]
        : []),
    );
  paintLevel();
  const { sheet } = formSheet({
    label: bot ? t("phone.botForm.edit", { name: bot.name }) : t("common.newBot"),
    title: bot ? t("common.edit2") : t("common.newBot"),
    action: bot ? t("common.save") : t("common.add2"),
    valid: () => d.name.trim().length > 0,
    body: [
      group({
        rows: [
          fieldRow(t("common.name2"), input("name", 40, t("common.eGResearcher"))),
          fieldRow(t("common.role"), input("role", 120, t("phone.botForm.eGResearchPriceComparisons"))),
          fieldRow(t("common.avatar"), input("avatar", 4, t("phone.botForm.defaultsToTheFirstLetter"))),
        ],
      }),
      group({ header: t("common.instructions"), rows: [areaRow(instructions)] }),
      h(
        "section",
        { class: "group" },
        level,
        h(
          "p",
          { class: "group-f" },
          d.approvalLevel === "full_access"
            ? t("phone.botForm.canOnlyBeTurnedOn")
            : t("phone.botForm.paymentsSendingDeletingAndPublishing"),
        ),
      ),
    ],
    submit: async () => {
      const r = botArgs(d, bot);
      if (!r.ok) return r.error;
      try {
        const saved = bot
          ? await s.client.request<TeamBot>("team.bots.update", { botId: bot.id, ...r.args })
          : await s.client.request<TeamBot>("team.bots.create", r.args);
        void s.loadTeam().catch(() => undefined);
        onSaved?.(saved);
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : t("common.notSaved2");
      }
    },
  });
  return sheet;
}
