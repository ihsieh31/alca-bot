// 連接 › 直接連線與 MCP (next round R8): the person's own MCP servers (Gmail /
// Calendar come through Composio only; Google direct was removed 2026-11-05). The
// accounts themselves (who may use them, triggers, disconnect) are ordinary
// rows in the groups above; this section sets them up. Adding or changing a
// server needs the approve key (Api.call opens a window that has it). The
// phone only sees these and can lower a bot's access; set-up is here.
import type { ConnectorsStatus, McpServerInput, McpServerView } from "./api-connect.ts";
import { appMark, type ConnectView } from "./connect.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";

/** What the section keeps between renders. */
const ui = {
  editing: undefined as string | undefined, // server id, or "" for a new one
  checked: new Map<string, string>(),
};

function lines(v: string): string[] {
  return v
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

function serverForm(view: ConnectView, srv: McpServerView | undefined): HTMLElement {
  const field = (name: string, label: string, value: string, attrs: Record<string, string> = {}) =>
    h(
      "label",
      { class: "cn-field" },
      h("span", {}, label),
      h("input", { class: "cn-input", name, value, "aria-label": label, ...attrs }),
    );
  const area = (name: string, label: string, value: string, placeholder: string) =>
    h(
      "label",
      { class: "cn-field" },
      h("span", {}, label),
      h("textarea", { class: "cn-input", name, rows: "3", placeholder, "aria-label": label }, value),
    );
  return h(
    "form",
    {
      class: "cn-mcp-form",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const f = (e.target as HTMLFormElement).elements;
        const v = (n: string) => ((f.namedItem(n) as HTMLInputElement | null)?.value ?? "").trim();
        const transport = v("transport") === "http" ? "http" : "stdio";
        const secrets: Record<string, string> = {};
        for (const l of lines(v("secrets"))) {
          const i = l.indexOf("=");
          if (i > 0) secrets[l.slice(0, i).trim()] = l.slice(i + 1);
        }
        const input: McpServerInput = {
          label: v("label"),
          transport,
          ...(transport === "stdio" ? { command: v("command"), args: lines(v("args")) } : { url: v("url") }),
          ...(v("cwd") ? { cwd: v("cwd") } : {}),
          secrets,
        };
        const id = srv?.id ?? v("id").toLowerCase();
        void view.act(
          view.api.saveServer(id, input).then((r) => {
            ui.checked.set(
              id,
              r.check.ok
                ? t("desktop.connectDirect.connectedTools", { tools: r.check.tools })
                : t("desktop.connectDirect.cantConnect", { error: r.check.error ?? "" }),
            );
          }),
          () => (ui.editing = undefined),
        );
      },
    },
    srv
      ? null
      : field("id", t("desktop.connectDirect.idLowercaseLettersDigitsAnd"), "", {
          pattern: "[a-z0-9][a-z0-9-]{0,39}",
          required: "",
        }),
    field("label", t("common.name"), srv?.label ?? "", { maxlength: "60", required: "" }),
    h(
      "label",
      { class: "cn-field" },
      h("span", {}, t("desktop.connectDirect.connectionType")),
      h(
        "select",
        { class: "cn-input", name: "transport", "aria-label": t("desktop.connectDirect.connectionType") },
        h(
          "option",
          { value: "stdio", ...(srv?.transport !== "http" ? { selected: "" } : {}) },
          t("desktop.connectDirect.localProgramStdio"),
        ),
        h(
          "option",
          { value: "http", ...(srv?.transport === "http" ? { selected: "" } : {}) },
          t("desktop.connectDirect.urlStreamableHttp"),
        ),
      ),
    ),
    field("command", t("desktop.connectDirect.programStdio"), srv?.command ?? "", {
      placeholder: t("desktop.connectDirect.eGNpxOrUsr"),
    }),
    area("args", t("desktop.connectDirect.argumentsStdioOnePerLine"), (srv?.args ?? []).join("\n"), ""),
    field("url", t("desktop.connectDirect.urlHttp"), srv?.url ?? "", { placeholder: "https://…/mcp" }),
    field("cwd", t("desktop.connectDirect.workFolderOptional"), srv?.cwd ?? ""),
    area(
      "secrets",
      t("desktop.connectDirect.secretsOneNameValuePer"),
      "",
      srv?.secretNames.length
        ? t("desktop.connectDirect.savedValuesArentShown", { p0: srv.secretNames.join(t("common.text")) })
        : t("desktop.connectDirect.eGApiToken"),
    ),
    h("p", { class: "cn-hint" }, t("desktop.connectDirect.aStdioServerRunsOn")),
    h(
      "div",
      { class: "lb-actions" },
      h(
        "button",
        { class: "btn cn-btn", type: "submit" },
        srv ? t("common.save") : t("desktop.connectDirect.addAndCheck"),
      ),
      h(
        "button",
        {
          class: "btn btn-quiet cn-btn",
          type: "button",
          onclick: () => {
            ui.editing = undefined;
            view.render();
          },
        },
        t("common.cancel"),
      ),
    ),
  );
}

function mcpCard(view: ConnectView, s: ConnectorsStatus): HTMLElement {
  const servers = s.integrations?.mcp.servers ?? [];
  return h(
    "div",
    { class: "cn-direct" },
    h("p", { class: "lb-hint cn-section-hint" }, t("desktop.connectDirect.toolsFromYourOwnMcp")),
    h(
      "ul",
      { class: "lb-list" },
      ...servers.map((srv) =>
        ui.editing === srv.id
          ? h("li", { class: "lb-row" }, serverForm(view, srv))
          : h(
              "li",
              { class: "lb-row cn-row", title: `mcp:${srv.id}` },
              appMark("mcp"),
              h(
                "div",
                { class: "lb-main" },
                h(
                  "div",
                  { class: "lb-body cn-head" },
                  h("span", { class: "cn-label" }, srv.label),
                  srv.enabled ? null : h("span", { class: "lb-pill" }, t("common.disabled2")),
                ),
                h(
                  "div",
                  { class: "lb-meta" },
                  srv.transport === "http" ? srv.url : [srv.command, ...srv.args].join(" "),
                  srv.secretNames.length
                    ? t("desktop.connectDirect.secrets", { p0: srv.secretNames.join(t("common.text")) })
                    : "",
                ),
                ui.checked.get(srv.id) ? h("div", { class: "cn-hint" }, ui.checked.get(srv.id)) : null,
              ),
              h(
                "div",
                { class: "lb-actions" },
                h(
                  "button",
                  {
                    class: "lb-act",
                    type: "button",
                    onclick: () =>
                      void view.act(
                        view.api.checkServer(srv.id).then((r) => {
                          ui.checked.set(
                            srv.id,
                            r.ok
                              ? t("desktop.connectDirect.connectedTools", { tools: r.tools })
                              : t("desktop.connectDirect.cantConnect", { error: r.error ?? "" }),
                          );
                        }),
                      ),
                  },
                  t("desktop.connectDirect.check"),
                ),
                h(
                  "button",
                  {
                    class: "lb-act",
                    type: "button",
                    onclick: () => {
                      ui.editing = srv.id;
                      view.render();
                    },
                  },
                  t("desktop.connectDirect.edit"),
                ),
                h(
                  "button",
                  {
                    class: "lb-act",
                    "data-tone": "danger",
                    type: "button",
                    onclick: () => void view.act(view.api.removeServer(srv.id)),
                  },
                  t("common.remove"),
                ),
              ),
            ),
      ),
      ui.editing === "" ? h("li", { class: "lb-row" }, serverForm(view, undefined)) : null,
    ),
    ui.editing === undefined
      ? h(
          "button",
          {
            class: "lb-act cn-add-link",
            type: "button",
            onclick: () => {
              ui.editing = "";
              view.render();
            },
          },
          t("desktop.connectDirect.addAnMcpServer"),
        )
      : null,
  );
}

/** The section under the connected accounts: the person's MCP servers. */
export function directSection(view: ConnectView, s: ConnectorsStatus): HTMLElement | null {
  if (!s.integrations) return null;
  return h(
    "section",
    { class: "lb-section cn-group" },
    h("h3", { class: "lb-h2" }, t("desktop.connectDirect.myMcpServers")),
    mcpCard(view, s),
  );
}
