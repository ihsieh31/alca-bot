// Next-round §5.4: a bot's OS sandbox in the editor's 進階 — mode (自動 = on at
// 自主 and 完全授權, the default; 一律開; 關), network (可連網 by default; 不連網),
// extra writable folders, and what this computer has (Seatbelt / bubblewrap /
// none). Loosening is checked by the server (approve key); the phone has none of this.
import type { TeamBot } from "./api-team.ts";
import { type SandboxDraft, sandboxBody, sandboxDraft } from "./bot-sandbox-model.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { popup } from "./popup.ts";

type Field = (label: string, control: HTMLElement, hint?: string, forId?: string) => HTMLElement;

export const SANDBOX_HINT = t("desktop.botSandbox.theSandboxOnlyLimitsCommands");

export function sandboxFields(bot: TeamBot | undefined, field: Field) {
  const start = sandboxDraft(bot?.sandbox);
  const d: SandboxDraft = { ...start };
  const seg = <T extends string>(
    id: string,
    get: () => T,
    set: (v: T) => void,
    options: Array<[T, string]>,
  ) => popup(id, get(), options, set).el;
  const mode = seg(
    "be-sandbox",
    () => d.mode,
    (v) => (d.mode = v),
    [
      ["auto", t("desktop.botSandbox.autoOnUnderAutonomousAnd")],
      ["on", t("desktop.botSandbox.alwaysOn")],
      ["off", t("desktop.botSandbox.off")],
    ],
  );
  const net = seg(
    "be-sandbox-net",
    () => d.network,
    (v) => (d.network = v),
    [
      ["open", t("desktop.botSandbox.networkAllowed")],
      ["none", t("desktop.botSandbox.noNetwork")],
    ],
  );
  const extra = h("textarea", {
    class: "cn-input be-sandbox-extra",
    id: "be-sandbox-extra",
    rows: "2",
    placeholder: t("desktop.botSandbox.extraWritableFoldersAbsolutePaths"),
    "aria-label": t("desktop.botSandbox.extraWritableFoldersForThe"),
  }) as HTMLTextAreaElement;
  extra.value = d.extra;
  extra.addEventListener("input", () => (d.extra = extra.value));
  const probe = bot?.sandboxProbe;
  const status = probe
    ? h(
        "p",
        { class: probe.ok ? "be-hint" : "be-warn", role: "status" },
        t("desktop.botSandbox.thisComputer", { text: probe.text }),
      )
    : null;
  return {
    elements: [
      field(
        t("desktop.botSandbox.sandbox"),
        h("div", { class: "be-stack" }, mode, net, extra, status),
        SANDBOX_HINT,
        "be-sandbox",
      ),
    ],
    values: () => {
      const body = sandboxBody(start, d);
      return body ? { sandbox: body } : {};
    },
  };
}
