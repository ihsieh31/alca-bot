// 連接: one connected account (label, rename, remove, per-bot access, triggers); split out of connect.ts (P13).
import type { Access, AccountView, AppCard, ConnectorsStatus } from "./api-connect.ts";
import { appMark, type ConnectView, STATUS } from "./connect.ts";
import { ago, h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { moreButton } from "./menu.ts";
import { popup } from "./popup.ts";

export function accountRow(view: ConnectView, a: AccountView, s: ConnectorsStatus): HTMLElement {
  const st = STATUS[a.status] ?? { label: a.status, tone: "" };
  const app = s.apps.find((x) => x.toolkit === a.toolkit);
  if (view.confirming === a.id)
    return h(
      "li",
      { class: "lb-row lb-confirm" },
      appMark(a.toolkit),
      h(
        "div",
        { class: "lb-main" },
        h("div", { class: "lb-body" }, tx("desktop.connectAccounts.disconnect", { label: a.label })),
        h(
          "div",
          { class: "lb-meta" },
          a.provider === "mcp"
            ? tx("desktop.connectAccounts.noBotCanUseThis2")
            : tx("desktop.connectAccounts.noBotCanUseThis3"),
        ),
      ),
      h(
        "div",
        { class: "lb-actions" },
        h(
          "button",
          {
            class: "btn btn-danger cn-btn",
            type: "button",
            onclick: () => void view.act(view.api.disconnect(a.id), () => (view.confirming = undefined)),
          },
          tx("common.disconnect2"),
        ),
        h(
          "button",
          {
            class: "btn btn-quiet cn-btn",
            type: "button",
            onclick: () => {
              view.confirming = undefined;
              view.render();
            },
          },
          tx("common.cancel"),
        ),
      ),
    );
  const label =
    view.renaming === a.id
      ? h(
          "form",
          {
            class: "cn-rename",
            onsubmit: (e: Event) => {
              e.preventDefault();
              const v = ((e.target as HTMLFormElement).elements.namedItem("label") as HTMLInputElement).value;
              void view.act(view.api.rename(a.id, v), () => (view.renaming = undefined));
            },
          },
          h("input", {
            class: "cn-input",
            name: "label",
            value: a.label,
            maxlength: "60",
            "aria-label": tx("desktop.connectAccounts.accountName"),
          }),
          h("button", { class: "lb-act", type: "submit" }, tx("common.save")),
        )
      : h("span", { class: "cn-label" }, a.label);
  // Who can use it: one row per bot with a popup (不能用 / 只讀 / 可操作), §3.8.
  const triggers = app?.triggers.length && a.status === "active" ? triggerChips(view, a, app, s) : null;
  // One inset group under the account: who can use it, then when it wakes a bot.
  const bots = h(
    "div",
    { class: "cn-bots" },
    h(
      "div",
      { role: "group", "aria-label": tx("desktop.connectAccounts.whoCanUseIt") },
      h("div", { class: "cn-sub" }, tx("desktop.connectAccounts.whoCanUseIt")),
      ...a.bots.map((b) => accessControl(view, a, b)),
    ),
    triggers,
  );
  const meta =
    a.status === "pending"
      ? tx("desktop.connectAccounts.onceYouFinishAuthorizingIn")
      : [a.identity, a.status === "active" ? "" : st.label].filter(Boolean).join(tx("common.joinComma")) ||
        tx("common.connected2", { createdAt: ago(a.createdAt) });
  return h(
    "li",
    {
      class: "lb-row cn-row",
      "data-status": a.status,
      title: tx("common.connected2", { createdAt: ago(a.createdAt) }),
    },
    appMark(a.toolkit),
    h(
      "div",
      { class: "lb-main" },
      h("div", { class: "lb-body cn-head" }, label),
      h("p", { class: "lb-meta", "data-status": a.status }, meta),
      a.status === "active" || a.status === "pending" ? bots : null,
    ),
    h(
      "div",
      { class: "lb-actions" },
      a.status === "pending"
        ? h(
            "button",
            { class: "lb-act", type: "button", onclick: () => void view.act(view.api.refresh()) },
            tx("desktop.connectAccounts.checkAgain"),
          )
        : null,
      moreButton(tx("common.more"), () => [
        {
          label: tx("desktop.connectAccounts.renameEllipsis"),
          run: () => {
            view.renaming = a.id;
            view.render();
          },
        },
        {
          label: tx("desktop.connectAccounts.disconnectEllipsis"),
          danger: true,
          run: () => {
            view.confirming = a.id;
            view.render();
          },
        },
      ]),
    ),
  );
}

export function accessControl(
  view: ConnectView,
  a: AccountView,
  b: { botId: string; name: string; access: Access },
): HTMLElement {
  const word = { none: tx("common.cantUse"), read: tx("common.readOnly"), act: tx("common.canAct") };
  const sel = popup(
    `cn-access-${a.id}-${b.botId}`,
    b.access ?? "none",
    [
      ["none", word.none],
      ["read", word.read],
      ["act", word.act],
    ],
    (v) => void view.act(view.api.grant(a.id, b.botId, v === "none" ? null : v)),
  ).el;
  sel.setAttribute("aria-label", tx("desktop.connectAccounts.canUse", { name: b.name, label: a.label }));
  sel.title =
    b.access === "act"
      ? tx("desktop.connectAccounts.canReadAndActSending")
      : b.access === "read"
        ? tx("desktop.connectAccounts.canOnlyReadSearchList")
        : tx("desktop.connectAccounts.thisBotCantSeeThis");
  return h("div", { class: "cn-bot" }, h("span", { class: "cn-bot-name" }, b.name), sel);
}

export function triggerChips(
  view: ConnectView,
  a: AccountView,
  app: AppCard,
  s: ConnectorsStatus,
): HTMLElement {
  // §3.8: each trigger is a row in the account's inset group, its state at the trailing edge
  // (已開啟 / a quiet 開啟 button / why it can't be on yet), never loose accent words.
  const relay = !!s.relay;
  return h(
    "div",
    { class: "cn-triggers", role: "group", "aria-label": tx("desktop.connectAccounts.wakeTheBot") },
    h("div", { class: "cn-sub" }, tx("desktop.connectAccounts.wakeTheBot")),
    ...app.triggers.map((t) => {
      const on = a.triggers.find((x) => x.slug === t.slug && x.status === "active");
      const trailing = on
        ? h(
            "span",
            { class: "cn-on", title: tx("desktop.connectAccounts.onEventsGoThroughCode") },
            tx("desktop.connectAccounts.triggerOn"),
          )
        : !relay
          ? h(
              "span",
              { class: "cn-off", title: tx("desktop.connectAccounts.triggersNeedYourOwnRelay") },
              tx("desktop.connectAccounts.needsYourOwnRelay"),
            )
          : h(
              "button",
              {
                class: "btn btn-quiet cn-btn",
                type: "button",
                disabled: !s.routinesOn,
                title: tx("desktop.connectAccounts.turnOnThisTrigger"),
                "aria-label": `${tx("desktop.connectAccounts.turnOn")} ${t.name}`,
                onclick: () => void view.act(view.api.trigger(a.id, t.slug)),
              },
              tx("desktop.connectAccounts.turnOn"),
            );
      return h("div", { class: "cn-bot cn-trigger" }, h("span", { class: "cn-bot-name" }, t.name), trailing);
    }),
  );
}
