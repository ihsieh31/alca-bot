// 設定 → 模型與供應商 (P11). Six providers pinned, the rest under 更多供應商;
// each shows 可用／需登入／需金鑰／未安裝 with a one-line fix. Opening one
// gives its key (saved to the local encrypted vault and never shown again),
// its command or base URL, and its default model. 新增自訂供應商 adds an ACP
// agent (command) or an OpenAI- / Anthropic-compatible API (base URL + key +
// models). Each bot picks its own provider and model in the bot editor.
import type { Api } from "./api.ts";
import {
  type ApiFamily,
  type CustomInput,
  type ProvidersClient,
  type ProviderView,
  providersApi,
} from "./api-providers.ts";
import { h, trapDialog } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { modelPicker, providerList } from "./model-picker.ts";
import { popup } from "./popup.ts";

export interface ProvidersHooks {
  changed(): void;
  error(err: unknown): void;
}

export class ProvidersView {
  private readonly client: ProvidersClient;
  private readonly hooks: ProvidersHooks;
  private overlay: HTMLElement | undefined;
  private untrap: (() => void) | undefined;
  private body: HTMLElement | undefined;
  private providers: ProviderView[] = [];
  private open: string | null = null;

  constructor(api: Api, hooks: ProvidersHooks) {
    this.client = providersApi(api);
    this.hooks = hooks;
  }

  get isOpen(): boolean {
    return !!this.overlay;
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = undefined;
    this.untrap?.();
    this.untrap = undefined;
  }

  async show(o: { open?: string; custom?: boolean } = {}): Promise<void> {
    this.close();
    this.open = o.open ?? null;
    const body = h(
      "div",
      { class: "pv-body" },
      h("p", { class: "pv-empty" }, t("desktop.providers.detecting")),
    );
    this.body = body;
    const refresh = h(
      "button",
      {
        class: "lb-act",
        type: "button",
        onclick: () => void this.load(true),
      },
      t("desktop.providers.detectAgain"),
    );
    const sheet = h(
      "section",
      { class: "sheet pv-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "pv-title" },
      h(
        "header",
        { class: "pv-head" },
        h(
          "div",
          {},
          h("h2", { id: "pv-title" }, t("common.modelsAndProviders")),
          h("p", { class: "be-hint" }, t("desktop.providers.keysAreStoredOnlyIn")),
        ),
        refresh,
        h(
          "button",
          { class: "btn btn-quiet", type: "button", onclick: () => this.close() },
          t("common.done2"),
        ),
      ),
      body,
    );
    const overlay = h("div", { class: "overlay pv-overlay" }, sheet);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });
    document.body.append(overlay);
    this.overlay = overlay;
    this.untrap = trapDialog(sheet, () => this.close());
    await this.load(false);
    if (o.custom) this.customForm();
  }

  private async load(fresh: boolean): Promise<void> {
    try {
      this.providers = await this.client.list(fresh);
      this.render();
    } catch (e) {
      this.hooks.error(e);
    }
  }

  private replace(p: ProviderView): void {
    this.providers = this.providers.map((x) => (x.id === p.id ? p : x));
    this.render();
    this.hooks.changed();
  }

  private render(): void {
    if (!this.body) return;
    this.body.replaceChildren(
      providerList({
        providers: this.providers,
        selected: this.open,
        compact: true,
        onPick: (id) => {
          this.open = this.open === id ? null : id;
          this.render();
        },
        detail: (p) => (p.id === this.open ? this.detail(p) : null),
      }),
      h(
        "div",
        { class: "pv-add" },
        h(
          "button",
          { class: "lb-act", type: "button", onclick: () => this.customForm() },
          t("desktop.providers.addACustomProvider"),
        ),
        h("span", { class: "be-hint" }, t("desktop.providers.acpAgentCommandOrOpenai")),
      ),
    );
  }

  private detail(p: ProviderView): HTMLElement {
    const err = h("p", { class: "tm-err", role: "alert", hidden: true });
    const fail = (e: unknown) => {
      err.hidden = false;
      err.textContent = String((e as Error)?.message ?? e);
    };
    const parts: Array<HTMLElement | null> = [];
    // The key field below says where to get a key; the fix box is for installing or signing in.
    if (
      p.status === "not_installed" ||
      p.status === "needs_login" ||
      (p.status === "ready" && p.kind !== "api")
    )
      parts.push(h("p", { class: "pv-fix", "data-status": p.status }, p.hint));
    if (p.kind === "api" && (p.keyRequired || p.hasKey)) parts.push(this.keyField(p, fail));
    if (p.kind === "acp" && p.custom && p.keyRequired) parts.push(this.keyField(p, fail));
    if (!p.custom) {
      if (p.kind === "api")
        parts.push(this.textField(p, t("common.address"), p.baseUrl ?? "", "baseUrl", fail));
      else
        parts.push(
          this.textField(p, t("desktop.providers.command"), (p.command ?? []).join(" "), "command", fail),
        );
    }
    if (p.families?.length)
      parts.push(
        h(
          "div",
          { class: "be-field" },
          h("span", { class: "be-label" }, t("desktop.providers.interface")),
          popup<ApiFamily>(
            `pv-family-${p.id}`,
            p.family ?? "openai-responses",
            [
              ["openai-responses", "Responses"],
              ["openai-chat", "Chat Completions"],
            ],
            (family) => void this.client.update(p.id, { family }).then((v) => this.replace(v), fail),
          ).el,
        ),
      );
    if (!p.custom)
      parts.push(
        h(
          "div",
          { class: "be-field" },
          h(
            "span",
            { class: "be-label" },
            t("common.defaultModel"),
            h("span", { class: "pv-cur" }, p.defaultModel ?? t("desktop.providers.providersOwnDefault")),
          ),
          modelPicker({
            value: p.defaultModel ?? "",
            load: (refresh) => this.client.models(p.id, refresh),
            onChange: (m) =>
              void this.client.update(p.id, { defaultModel: m }).then((v) => this.replace(v), fail),
          }),
        ),
      );
    parts.push(
      h("p", { class: "pv-native" }, h("b", {}, t("desktop.providers.permissions")), p.nativeApproval),
    );
    if (p.custom)
      parts.push(
        h(
          "div",
          { class: "pv-actions" },
          h(
            "button",
            {
              class: "lb-act",
              "data-tone": "danger",
              type: "button",
              onclick: () =>
                void this.client.remove(p.id).then(() => {
                  this.open = null;
                  this.hooks.changed();
                  void this.load(false);
                }, fail),
            },
            t("desktop.providers.removeThisCustomProvider"),
          ),
        ),
      );
    parts.push(err);
    return h("div", { class: "pv-detail" }, ...parts);
  }

  private keyField(p: ProviderView, fail: (e: unknown) => void): HTMLElement {
    const input = h("input", {
      class: "cn-input",
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: p.hasKey ? t("desktop.providers.aKeyIsSavedPasting") : t("desktop.providers.pasteApiKey"),
      "aria-label": "API key",
    }) as HTMLInputElement;
    const save = h(
      "button",
      {
        class: "btn btn-primary",
        type: "button",
        onclick: () => {
          if (!input.value.trim()) return input.focus();
          void this.client.setKey(p.id, input.value).then((v) => {
            input.value = "";
            this.replace(v);
          }, fail);
        },
      },
      t("common.save"),
    );
    return h(
      "div",
      { class: "be-field" },
      h(
        "span",
        { class: "be-label" },
        t("desktop.providers.key"),
        p.hasKey
          ? h("span", { class: "pv-cur", "data-tone": "ok" }, t("desktop.providers.savedOnThisComputerWont"))
          : null,
      ),
      h("div", { class: "pv-inline" }, input, save),
      h(
        "span",
        { class: "be-hint" },
        p.keyUrl ? t("desktop.providers.getOneAt", { host: new URL(p.keyUrl).host }) : "",
        t("desktop.providers.theModelPhonesAndLogs"),
        p.hasKey
          ? h(
              "button",
              {
                class: "lb-act pv-clear",
                type: "button",
                onclick: () => void this.client.clearKey(p.id).then((v) => this.replace(v), fail),
              },
              t("desktop.providers.removeKey"),
            )
          : null,
      ),
    );
  }

  private textField(
    p: ProviderView,
    label: string,
    value: string,
    field: "baseUrl" | "command",
    fail: (e: unknown) => void,
  ): HTMLElement {
    const input = h("input", {
      class: "cn-input pv-mono",
      value,
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": label,
    }) as HTMLInputElement;
    const save = h(
      "button",
      {
        class: "btn btn-quiet",
        type: "button",
        onclick: () =>
          void this.client
            .update(p.id, { [field]: input.value.trim() || null })
            .then((v) => this.replace(v), fail),
      },
      t("common.save"),
    );
    return h(
      "div",
      { class: "be-field" },
      h("span", { class: "be-label" }, label),
      h("div", { class: "pv-inline" }, input, save),
    );
  }

  /** 新增自訂供應商. */
  customForm(): void {
    if (!this.body) return;
    let kind: CustomInput["kind"] = "acp";
    const err = h("p", { class: "tm-err", role: "alert", hidden: true });
    const input = (placeholder: string, o: Record<string, string> = {}) =>
      h("input", {
        class: "cn-input",
        placeholder,
        autocomplete: "off",
        spellcheck: "false",
        ...o,
      }) as HTMLInputElement;
    const label = input(t("desktop.providers.eGMyAgent"), {
      maxlength: "60",
      "aria-label": t("common.name"),
    });
    const command = input("my-agent --acp", {
      class: "cn-input pv-mono",
      "aria-label": t("desktop.providers.command"),
    });
    const baseUrl = input("https://api.example.com/v1", {
      class: "cn-input pv-mono",
      "aria-label": t("common.address"),
    });
    const key = input(t("desktop.providers.apiKeyOptional"), {
      type: "password",
      "aria-label": t("desktop.providers.key"),
    });
    const apiKey = input(t("desktop.providers.apiKeyCanBeBlank"), {
      type: "password",
      "aria-label": t("desktop.providers.key"),
    });
    const keyEnv = input("MY_AGENT_API_KEY", {
      class: "cn-input pv-mono",
      "aria-label": t("desktop.providers.keyEnvironmentVariable"),
    });
    const models = h("textarea", {
      class: "cn-input be-area pv-mono",
      rows: "2",
      placeholder: t("desktop.providers.modelIdsOnePerLine"),
      "aria-label": t("desktop.providers.modelList"),
    }) as HTMLTextAreaElement;
    const field = (name: string, control: HTMLElement, hint?: string) =>
      h(
        "div",
        { class: "be-field" },
        h("span", { class: "be-label" }, name),
        control,
        hint ? h("span", { class: "be-hint" }, hint) : null,
      );
    const acpOnly = h(
      "div",
      { class: "pv-form-part" },
      field(t("desktop.providers.command"), command, t("desktop.providers.theExecutableAndArgumentsIt")),
      h(
        "div",
        { class: "be-row2" },
        field(t("desktop.providers.key"), key),
        field(t("desktop.providers.environmentVariableThatReceivesThe"), keyEnv),
      ),
    );
    const apiOnly = h(
      "div",
      { class: "pv-form-part", hidden: true },
      field(t("common.address"), baseUrl, t("desktop.providers.remoteServicesNeedHttpsLocal")),
      field(t("desktop.providers.key"), apiKey),
    );
    const kinds = popup<CustomInput["kind"]>(
      "pv-custom-kind",
      kind,
      [
        ["acp", t("desktop.providers.acpAgent")],
        ["openai", t("desktop.providers.openaiCompatible")],
        ["anthropic", t("desktop.providers.anthropicCompatible")],
      ],
      (v) => {
        kind = v;
        acpOnly.hidden = v !== "acp";
        apiOnly.hidden = v === "acp";
      },
    ).el;
    const save = h(
      "button",
      { class: "btn btn-primary", type: "submit" },
      t("common.add"),
    ) as HTMLButtonElement;
    const form = h(
      "form",
      {
        class: "pv-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const body: CustomInput = {
            kind,
            label: label.value.trim(),
            models: models.value,
            ...(kind === "acp"
              ? { command: command.value, ...(key.value ? { key: key.value, keyEnv: keyEnv.value } : {}) }
              : { baseUrl: baseUrl.value, ...(apiKey.value ? { key: apiKey.value } : {}) }),
          };
          save.disabled = true;
          void this.client.addCustom(body).then(
            (v) => {
              this.open = v.id;
              this.hooks.changed();
              void this.load(false);
            },
            (e2) => {
              save.disabled = false;
              err.hidden = false;
              err.textContent = String((e2 as Error)?.message ?? e2);
            },
          );
        },
      },
      h("h3", { class: "pv-form-title" }, t("desktop.providers.addACustomProvider2")),
      field(t("common.type"), kinds),
      field(t("common.name"), label),
      acpOnly,
      apiOnly,
      field(t("common.model"), models, t("desktop.providers.anAcpAgentCanBe")),
      h("p", { class: "be-hint" }, t("desktop.providers.theKeyGoesIntoThis")),
      err,
      h(
        "footer",
        { class: "be-foot" },
        h("span", { class: "lb-spacer" }),
        h(
          "button",
          { class: "btn btn-quiet", type: "button", onclick: () => this.render() },
          t("common.cancel"),
        ),
        save,
      ),
    );
    this.body.replaceChildren(form);
    setTimeout(() => label.focus(), 0);
  }
}
