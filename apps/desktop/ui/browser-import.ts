import type { Api, Space } from "./api.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { icon } from "./icons.ts";

// 從 Chrome 匯入登入 (P13, macOS, opt-in): a sheet that lists the sites in the
// person's Chrome profile, lets them tick the ones to bring over, and imports
// them into ONE persistent isolated Space. Nothing is read until the sheet is
// opened, and the Keychain prompt appears only on 匯入. Built from DOM nodes.

interface ProfileView {
  name: string;
  domains: Array<{ domain: string; cookies: number }>;
  error?: string;
}

/** Can this Space take an import? (persistent isolated only) */
export function canImport(s: Space): boolean {
  return s.profile === "isolated" && s.persistent;
}

export function importButton(api: Api, s: Space, onError: (e: unknown) => void): HTMLElement {
  return h(
    "button",
    {
      class: "bp-link",
      type: "button",
      title: t("desktop.browserImport.copyYourChromeSignIns"),
      onclick: () => void openImport(api, s).catch(onError),
    },
    t("desktop.browserImport.importSignInsFromChrome"),
  );
}

async function openImport(api: Api, s: Space): Promise<void> {
  const { profiles } = await api.call<{ profiles: ProfileView[] }>("GET", "/api/browser/chrome-import");
  const body = h("div", { class: "lk-body bi-body" });
  const dialog = h(
    "dialog",
    { class: "lk-dialog bi-dialog", "aria-label": t("desktop.browserImport.importSignInsFromChrome2") },
    h(
      "header",
      { class: "lk-head" },
      h("h2", {}, t("desktop.browserImport.importSignInsFromChrome2")),
      h(
        "button",
        { class: "tool-btn", type: "button", "aria-label": t("common.close"), onclick: () => dialog.close() },
        icon("cross"),
      ),
    ),
    body,
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);

  let profile = profiles[0]?.name ?? "Default";
  const picked = new Set<string>();
  const status = h("p", { class: "bi-status", role: "status" });
  const paint = () => {
    const p = profiles.find((x) => x.name === profile);
    const filter = h("input", {
      class: "field",
      type: "search",
      placeholder: t("desktop.browserImport.filterSitesEGGithub"),
      "aria-label": t("desktop.browserImport.filterSites"),
    }) as HTMLInputElement;
    const list = h("ul", { class: "bi-list" });
    const fill = () => {
      const q = filter.value.trim().toLowerCase();
      list.replaceChildren(
        ...(p?.domains ?? [])
          .filter((d) => !q || d.domain.includes(q))
          .slice(0, 300)
          .map((d) => {
            const box = h("input", { type: "checkbox", value: d.domain }) as HTMLInputElement;
            box.checked = picked.has(d.domain);
            box.addEventListener("change", () => {
              if (box.checked) picked.add(d.domain);
              else picked.delete(d.domain);
              go.disabled = picked.size === 0;
            });
            return h("li", {}, h("label", {}, box, h("span", {}, d.domain), h("small", {}, `${d.cookies}`)));
          }),
      );
    };
    filter.addEventListener("input", fill);
    const go = h(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: async () => {
          go.disabled = true;
          status.textContent = t("desktop.browserImport.macosWillAskWhetherTo");
          try {
            const r = await api.call<{ imported: number; skipped: number; expired: number }>(
              "POST",
              `/api/browser/spaces/${s.spaceId}/import-cookies`,
              { profile, domains: [...picked] },
            );
            status.textContent = t("desktop.browserImport.importedCookiesInto", {
              imported: r.imported,
              title: s.title,
              p2: r.skipped ? t("desktop.browserImport.couldntBeDecrypted", { skipped: r.skipped }) : "",
            });
          } catch (err) {
            status.textContent = t("desktop.browserImport.notImported", {
              message: String((err as Error)?.message ?? err),
            });
            go.disabled = picked.size === 0;
          }
        },
      },
      t("common.import"),
    ) as HTMLButtonElement;
    go.disabled = picked.size === 0;
    const select = h(
      "select",
      { class: "popup", "aria-label": t("desktop.browserImport.chromeProfile") },
      ...profiles.map((x) =>
        h("option", { value: x.name, ...(x.name === profile ? { selected: true } : {}) }, x.name),
      ),
    ) as HTMLSelectElement;
    select.addEventListener("change", () => {
      profile = select.value;
      picked.clear();
      paint();
    });
    body.replaceChildren(
      h("p", { class: "bi-note" }, t("desktop.browserImport.onlySignInsForThe", { title: s.title })),
      profiles.length ? select : h("p", {}, t("desktop.browserImport.noChromeProfileWasFound")),
      p?.error ? h("p", { class: "bi-status" }, p.error) : filter,
      list,
      h("div", { class: "bi-actions" }, go),
      status,
    );
    fill();
  };
  paint();
  dialog.showModal();
}
