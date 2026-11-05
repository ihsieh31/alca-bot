// 連接 → 網站登入 (design §0.2.7): keep a website password for the general
// harness's browser. Saving and removing ask for the approve key (the person's
// own act); the list never carries a password. The password field is cleared
// as soon as the request is sent, success or not.
import type { ConnectorsStatus } from "./api-connect.ts";
import type { ConnectView } from "./connect.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { loginBody, loginLine, type SiteLoginView } from "./site-logins-model.ts";

export function siteLoginsSection(
  view: ConnectView,
  logins: SiteLoginView[] | undefined,
  s: ConnectorsStatus,
): HTMLElement {
  const rows = (logins ?? []).map((l) => loginRow(view, l));
  return h(
    "section",
    { class: "cn-group cn-logins" },
    h(
      "h2",
      { class: "lb-h2" },
      t("common.siteLogins"),
      h("span", { class: "lb-count" }, String(logins?.length ?? 0)),
      h("span", { class: "cn-sub" }, t("desktop.siteLoginsView.letBotsSignInTo")),
    ),
    rows.length ? h("ul", { class: "lb-list" }, ...rows) : null,
    view.loginAdding ? loginForm(view, s) : addButton(view),
  );
}

function addButton(view: ConnectView): HTMLElement {
  return h(
    "button",
    {
      class: "lb-act cn-login-add",
      type: "button",
      onclick: () => {
        view.loginAdding = true;
        view.render();
      },
    },
    t("desktop.siteLoginsView.addASiteLogin"),
  );
}

function loginRow(view: ConnectView, l: SiteLoginView): HTMLElement {
  const line = loginLine(l);
  const confirming = view.loginRemoving === l.id;
  return h(
    "li",
    { class: confirming ? "lb-row lb-confirm" : "lb-row" },
    h(
      "div",
      { class: "lb-main" },
      h(
        "div",
        { class: "lb-body" },
        confirming ? t("desktop.siteLoginsView.removeTheLoginFor", { title: line.title }) : line.title,
      ),
      h(
        "div",
        { class: "lb-meta" },
        confirming
          ? t("desktop.siteLoginsView.botsWillNoLongerBe")
          : `${line.account}${t("common.joinComma")}${line.who}`,
      ),
    ),
    h(
      "div",
      { class: "lb-actions" },
      confirming
        ? h(
            "button",
            {
              class: "btn btn-danger cn-btn",
              type: "button",
              onclick: () =>
                void view.act(view.api.removeLogin(l.id), () => (view.loginRemoving = undefined)),
            },
            t("common.remove"),
          )
        : null,
      h(
        "button",
        {
          class: confirming ? "btn btn-quiet cn-btn" : "lb-act",
          "data-tone": confirming ? undefined : "danger",
          type: "button",
          onclick: () => {
            view.loginRemoving = confirming ? undefined : l.id;
            view.render();
          },
        },
        confirming ? t("common.cancel") : t("common.remove"),
      ),
    ),
  );
}

function loginForm(view: ConnectView, s: ConnectorsStatus): HTMLElement {
  const input = (name: string, placeholder: string, type = "text", max = "200") =>
    h("input", {
      class: "cn-input",
      name,
      type,
      placeholder,
      maxlength: max,
      autocomplete: type === "password" ? "new-password" : "off",
      spellcheck: "false",
      "aria-label": placeholder,
    });
  const origin = input("origin", t("desktop.siteLoginsView.addressEGHttpsExample"), "text", "500");
  const username = input("username", t("desktop.siteLoginsView.usernameOptional"));
  const password = input("password", t("desktop.siteLoginsView.password"), "password", "1024");
  const label = input("label", t("desktop.siteLoginsView.nameEGCompanyHr"), "text", "80");
  const boxes = s.bots.map((b) => ({ b, el: h("input", { type: "checkbox", value: b.id }) }));
  const error = h("p", { class: "cn-hint", role: "alert", hidden: true });
  const submit = (e: Event) => {
    e.preventDefault();
    const r = loginBody({
      origin: origin.value,
      username: username.value,
      password: password.value,
      label: label.value,
      botIds: boxes.filter((x) => x.el.checked).map((x) => x.b.id),
    });
    if ("error" in r) {
      error.textContent = r.error;
      error.hidden = false;
      return;
    }
    password.value = ""; // the field never outlives the request
    void view.act(view.api.saveLogin(r.body), () => (view.loginAdding = false));
  };
  return h(
    "form",
    { class: "cn-login-form", onsubmit: submit },
    h("div", { class: "cn-key-row" }, origin, label),
    h("div", { class: "cn-key-row" }, username, password),
    boxes.length
      ? h(
          "div",
          { class: "cn-login-bots" },
          h("span", { class: "cn-hint" }, t("desktop.siteLoginsView.onlyTheseBotsCanUse")),
          ...boxes.map((x) => h("label", { class: "cn-login-bot" }, x.el, x.b.name)),
        )
      : null,
    error,
    h(
      "div",
      { class: "cn-key-row" },
      h("button", { class: "btn btn-primary cn-btn", type: "submit" }, t("common.save")),
      h(
        "button",
        {
          class: "btn btn-quiet cn-btn",
          type: "button",
          onclick: () => {
            view.loginAdding = false;
            view.render();
          },
        },
        t("common.cancel"),
      ),
    ),
  );
}
