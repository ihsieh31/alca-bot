// Telegram dialog (P13): a minimal form. Paste the bot token from BotFather
// (checked with Telegram, then sealed in the local vault; never shown again),
// list the private chat ids that may talk to Alca (a chat that tried shows up
// here to add with one click), pick which bot answers, turn it on. Approvals
// are never possible from Telegram; the dialog says so, and says next to the
// switch that Telegram sees the content (L11).
import type { Api, Bot } from "./api.ts";
import { h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { icon } from "./icons.ts";

interface TelegramView {
  enabled: boolean;
  botId: string | null;
  allowChatIds: number[];
  tokenSet: boolean;
  botUsername: string | null;
  running: boolean;
  lastError: string | null;
  unknown: Array<{ chatId: number; name: string; at: string }>;
  chats: number;
}

const parseIds = (s: string): number[] =>
  s
    .split(/[\s,，、]+/)
    .filter(Boolean)
    .map((x) => Number(x));

export function setupTelegramDialog(api: Api): { open(): void } {
  const body = h("div", { class: "lk-body lc-body" });
  const dialog = h(
    "dialog",
    { class: "lk-dialog lc-dialog", "aria-label": "Telegram" },
    h(
      "header",
      { class: "lk-head" },
      h("h2", { tabindex: "-1", autofocus: true }, "Telegram"),
      h(
        "button",
        {
          class: "tool-btn",
          type: "button",
          "aria-label": tx("common.close"),
          onclick: () => dialog.close(),
        },
        icon("cross"),
      ),
    ),
    body,
  );
  document.body.append(dialog);

  const paint = (t: TelegramView, bots: Bot[], msg?: { text: string; tone: string }) => {
    const token = h("input", {
      class: "field",
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: t.tokenSet ? tx("desktop.telegram.setPastingANewOne") : "123456789:AA…",
      "aria-label": tx("desktop.telegram.botToken"),
    });
    const ids = h("input", {
      class: "field",
      inputmode: "numeric",
      value: t.allowChatIds.join(", "),
      placeholder: tx("desktop.telegram.eG123456789"),
      "aria-label": tx("desktop.telegram.allowedChatIds"),
    });
    const pick = h("select", { class: "popup", "aria-label": tx("desktop.telegram.whichBotReplies") });
    for (const b of bots) {
      const o = h("option", { value: b.id }, b.name);
      if (b.id === (t.botId ?? bots[0]?.id)) o.selected = true;
      pick.append(o);
    }
    const on = h("input", { type: "checkbox", role: "switch", ...(t.enabled ? { checked: true } : {}) });
    const act = async (fn: () => Promise<TelegramView>, ok: string) => {
      try {
        paint(await fn(), bots, { text: ok, tone: "ok" });
      } catch (e) {
        paint(t, bots, { text: (e as Error).message, tone: "warn" });
      }
    };
    const save = () =>
      act(async () => {
        if (token.value.trim()) await api.call("PUT", "/api/telegram/token", { token: token.value.trim() });
        return api.call<TelegramView>("PUT", "/api/telegram", {
          enabled: on.checked,
          botId: pick.value || null,
          allowChatIds: parseIds(ids.value),
        });
      }, tx("common.saved"));
    const state = t.running
      ? tx("desktop.telegram.running", {
          p0: t.botUsername ? `${tx("common.joinComma")}@${t.botUsername}` : "",
        })
      : !t.tokenSet
        ? tx("desktop.telegram.noTokenYet")
        : !t.enabled
          ? tx("common.off")
          : t.allowChatIds.length
            ? tx("desktop.telegram.notRunning")
            : tx("desktop.telegram.noChatsAllowedYet");
    const parts: Array<HTMLElement | null> = [
      h(
        "div",
        { class: "lc-state", "data-tone": t.running ? "ok" : "warn" },
        h("span", { class: "lc-dot", "aria-hidden": "true" }, icon(t.running ? "check" : "alert")),
        h("p", { class: "lk-note" }, state),
      ),
      t.lastError ? h("p", { class: "lc-msg", "data-tone": "warn" }, t.lastError) : null,
      h("p", { class: "lk-note lc-why" }, tx("desktop.telegram.talkToAlcaOnTelegram")),
      h(
        "label",
        { class: "lc-field" },
        h("span", { class: "lc-label" }, tx("desktop.telegram.botToken")),
        token,
      ),
      h(
        "label",
        { class: "lc-field" },
        h("span", { class: "lc-label" }, tx("desktop.telegram.allowedPrivateChatIds")),
        ids,
        h("span", { class: "lc-help" }, tx("desktop.telegram.onlyTheseChatsGetReplies")),
      ),
      t.unknown.length
        ? h(
            "div",
            { class: "lc-field" },
            h("span", { class: "lc-label" }, tx("desktop.telegram.chatsThatRecentlyTriedTo")),
            ...t.unknown.map((u) =>
              h(
                "div",
                { class: "tg-row" },
                h("span", { class: "lk-note" }, `${u.name}${tx("common.joinComma")}${u.chatId}`),
                h(
                  "button",
                  {
                    class: "btn btn-quiet lc-btn",
                    type: "button",
                    onclick: () => {
                      ids.value = [...parseIds(ids.value), u.chatId].join(", ");
                    },
                  },
                  tx("common.add"),
                ),
              ),
            ),
          )
        : null,
      h(
        "label",
        { class: "lc-field" },
        h("span", { class: "lc-label" }, tx("desktop.telegram.whichBotReplies")),
        pick,
      ),
      // L11: said where the switch is, not only in the intro: turning it on hands the replies to Telegram.
      h(
        "p",
        { class: "tg-warn", role: "note" },
        h("b", {}, tx("desktop.telegram.telegramCanSeeTheContent")),
        tx("desktop.telegram.onceEnabledYourMessagesOn"),
      ),
      h("label", { class: "st-line tg-enable" }, on, h("span", {}, tx("desktop.telegram.enable"))),
      h(
        "div",
        { class: "lc-foot" },
        msg ? h("p", { class: "lc-msg", "data-tone": msg.tone }, msg.text) : h("span", {}),
        h(
          "span",
          { class: "tg-actions" },
          t.tokenSet
            ? h(
                "button",
                {
                  class: "btn btn-quiet lc-btn",
                  type: "button",
                  onclick: () =>
                    act(
                      () => api.call<TelegramView>("DELETE", "/api/telegram/token"),
                      tx("desktop.telegram.tokenRemoved"),
                    ),
                },
                tx("desktop.telegram.removeToken"),
              )
            : null,
          h(
            "button",
            { class: "btn btn-primary lc-btn", type: "button", onclick: () => void save() },
            tx("common.save"),
          ),
        ),
      ),
    ];
    body.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
  };

  const open = async () => {
    dialog.showModal();
    body.replaceChildren(h("p", { class: "lk-note" }, tx("common.loading")));
    try {
      const [t, bots] = await Promise.all([
        api.call<TelegramView>("GET", "/api/telegram"),
        api.call<Bot[]>("GET", "/api/bots").catch(() => [] as Bot[]),
      ]);
      paint(t, bots);
    } catch (e) {
      body.replaceChildren(h("p", { class: "lk-note" }, (e as Error).message));
    }
  };
  return { open: () => void open() };
}
