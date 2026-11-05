// P13: 新增例行工作 on the phone (§4.1 phone-routine-form) — a form sheet:
// 名稱, which app (and account) to check, 「什麼時候」 as a menu row with the
// matching picker under it (every N minutes / hours, daily at a time in this
// phone's zone, once), 「要做什麼」 as a text area, 「誰來做」 as a menu row and
// 提前做 as a switch. Needs `approve`; the core runs the same checks as the
// desktop (interval ≥ 60 s, a valid zone, a future time).
import type { ConnectStatus, RoutineList } from "./connect-view.ts";
import { h, haptic } from "./dom.ts";
import { areaRow, fieldRow, formSheet, menuRow } from "./form-kit.ts";
import { phoneZone, type RoutineDraft, routineArgs, routineDraft, type ScheduleKind } from "./forms-view.ts";
import { t as tx } from "./i18n/index.ts";
import type { Session } from "./session.ts";
import type { Sheet } from "./sheet.ts";
import { group, switchEl, switchRow } from "./ui.ts";

export function openRoutineForm(
  s: Session,
  list: RoutineList,
  st: ConnectStatus | undefined,
  onSaved?: () => void,
): Sheet {
  const apps = list.apps ?? [];
  const d: RoutineDraft = routineDraft(apps[0]?.toolkit ?? "");
  const tz = phoneZone();
  const name = h("input", {
    type: "text",
    maxlength: "80",
    placeholder: tx("phone.routineForm.eGWorkMail"),
    autocomplete: "off",
    "data-autofocus": "",
  });
  name.addEventListener("input", () => (d.name = name.value));

  const accountCell = h("div", { class: "cells-part" });
  const paintAccounts = () => {
    const accounts = st?.groups.find((g) => g.toolkit === d.app)?.accounts ?? [];
    if (d.account && !accounts.some((a) => a.label === d.account)) d.account = null;
    accountCell.replaceChildren(
      ...(accounts.length
        ? [
            menuRow<string>({
              title: tx("common.account"),
              options: [
                ["", tx("phone.routineForm.anyConnectedAccount")],
                ...accounts.map((a): [string, string] => [a.label, a.label]),
              ],
              value: d.account ?? "",
              onPick: (v) => (d.account = v || null),
            }),
          ]
        : []),
    );
  };
  const appRow = menuRow<string>({
    title: tx("phone.routineForm.appToCheck"),
    options: apps.length
      ? apps.map((a): [string, string] => [a.toolkit, a.name])
      : [["", tx("phone.routineForm.noAppsToCheckYet")]],
    value: d.app,
    onPick: (v) => {
      d.app = v;
      paintAccounts();
    },
    disabled: apps.length < 2,
  });

  const when = h("div", { class: "cells-part" });
  const paintWhen = () => {
    const kinds: Array<[ScheduleKind, string]> = [
      ["every", tx("phone.routineForm.every")],
      ["daily", tx("phone.routineForm.daily")],
      ["once", tx("phone.routineForm.once")],
    ];
    const picker: HTMLElement[] = [];
    if (d.schedule === "every") {
      const n = h("input", { type: "number", min: "1", max: "999", inputmode: "numeric" });
      n.value = String(d.everyN);
      n.addEventListener("input", () => (d.everyN = Number(n.value)));
      picker.push(
        fieldRow(tx("phone.routineForm.everyHowMany"), n),
        menuRow<"min" | "hour">({
          title: tx("phone.routineForm.unit"),
          options: [
            ["min", tx("phone.routineForm.minutes")],
            ["hour", tx("phone.routineForm.hours")],
          ],
          value: d.everyUnit,
          onPick: (v) => (d.everyUnit = v),
        }),
      );
    } else if (d.schedule === "daily") {
      const at = h("input", { type: "time", step: "60" });
      at.value = d.at;
      at.addEventListener("input", () => (d.at = at.value));
      picker.push(fieldRow(tx("phone.routineForm.time"), at));
    } else {
      const at = h("input", { type: "datetime-local", step: "60" });
      at.value = d.onceAt;
      at.addEventListener("input", () => (d.onceAt = at.value));
      picker.push(fieldRow(tx("phone.routineForm.time"), at));
    }
    when.replaceChildren(
      menuRow<ScheduleKind>({
        title: tx("phone.routineForm.when"),
        options: kinds,
        value: d.schedule,
        onPick: (k) => {
          haptic("tap");
          d.schedule = k;
          paintWhen();
        },
      }),
      ...picker,
    );
  };

  const instructions = h("textarea", {
    rows: 4,
    maxlength: "4000",
    placeholder: tx("phone.routineForm.whatToDoWithSomething"),
    "aria-label": tx("phone.routineForm.whenSomethingNewArrives"),
  });
  instructions.addEventListener("input", () => (d.instructions = instructions.value));
  const bots = s.team?.bots ?? [];
  const early = switchEl(false, tx("common.workAhead"), (on) => {
    haptic("tap");
    d.speculative = on;
  });
  paintAccounts();
  paintWhen();

  const { sheet } = formSheet({
    label: tx("common.newRoutine"),
    title: tx("common.newRoutine"),
    action: tx("common.add2"),
    valid: () => d.name.trim().length > 0 && !!d.app,
    body: [
      group({ rows: [fieldRow(tx("common.name2"), name), appRow, accountCell] }),
      group({
        rows: [when],
        footer: d.schedule === "daily" ? tx("phone.routineForm.text", { tz }) : null,
      }),
      group({ header: tx("phone.routineForm.whenSomethingNewArrives"), rows: [areaRow(instructions)] }),
      group({
        rows: [
          menuRow<string>({
            title: tx("phone.routineForm.handledBy"),
            options: [
              ["", tx("phone.routineForm.leadOrTheDefaultBot")],
              ...bots.map((b): [string, string] => [b.id, b.name]),
            ],
            value: "",
            onPick: (v) => (d.botId = v || null),
          }),
          switchRow({
            title: tx("common.workAhead"),
            sub: tx("phone.routineForm.prepareDraftsFirstWithoutDisturbing"),
            sw: early,
          }),
        ],
        footer: tx("phone.routineForm.eachTimeCodeChecksFor"),
      }),
    ],
    submit: async () => {
      const r = routineArgs(d, { tz });
      if (!r.ok) return r.error;
      try {
        await s.client.request("routines.create", r.args);
        onSaved?.();
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : tx("phone.routineForm.notCreated");
      }
    },
  });
  return sheet;
}
