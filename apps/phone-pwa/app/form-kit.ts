// Form sheets (§3.14): a nav bar with 〔取消〕 title 〔新增〕, fields as inset
// grouped rows (label left, value right), a text area in its own cell, value
// menus instead of segmented controls, validation inline in red under the form.
import { h, haptic, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { pick, Sheet } from "./sheet.ts";
import { row } from "./ui.ts";

/** A one-line field: label on the left, the input filling the rest, right-aligned. */
export function fieldRow(label: string, input: HTMLElement): HTMLElement {
  input.classList.add("field-input", "field-end");
  if (!input.getAttribute("aria-label")) input.setAttribute("aria-label", label);
  return h("label", { class: "row field-row field-pair" }, h("span", { class: "field-label" }, label), input);
}

/** A multi-line field in its own cell (4 lines at least). */
export function areaRow(area: HTMLTextAreaElement): HTMLElement {
  area.classList.add("field-area");
  return h("div", { class: "row field-row" }, area);
}

/** One value from a short list: the row shows it, a tap opens the choices (§3.8). */
export function menuRow<K extends string>(o: {
  title: string;
  options: Array<[K, string]>;
  value: K;
  onPick(k: K): void;
  disabled?: boolean;
}): HTMLElement {
  let cur = o.value;
  const value = h("span", {}, o.options.find((x) => x[0] === cur)?.[1] ?? "");
  const r = row({
    title: o.title,
    value,
    chevron: !o.disabled,
    ...(o.disabled
      ? {}
      : {
          onclick: () =>
            pick({
              label: o.title,
              title: o.title,
              options: o.options,
              current: cur,
              onPick: (k) => {
                cur = k;
                value.textContent = o.options.find((x) => x[0] === k)?.[1] ?? "";
                o.onPick(k);
              },
            }),
        }),
  });
  r.classList.add("menu-row");
  return r;
}

/**
 * A form sheet. `submit` returns an error message to show (or nothing when it
 * worked; the sheet then closes). The action is disabled while it runs.
 */
export function formSheet(o: {
  label: string;
  title: string;
  action: string;
  body: Node[];
  submit(): Promise<string | undefined> | string | undefined;
  valid?: () => boolean;
}): { sheet: Sheet; recheck(): void } {
  const error = h("p", { class: "inline-error form-error", role: "alert", hidden: true });
  const go = h("button", { class: "text-btn strong", type: "submit", form: "" }, o.action);
  let sheet!: Sheet;
  const recheck = () => {
    go.disabled = o.valid ? !o.valid() : false;
  };
  const run = async () => {
    if (go.disabled) return;
    go.disabled = true;
    error.hidden = true;
    try {
      const msg = await o.submit();
      if (msg) {
        error.replaceChildren(icon("alert", 16), h("span", {}, msg));
        error.hidden = false;
        haptic("warn");
        return;
      }
      haptic("success");
      sheet.close();
    } finally {
      recheck();
    }
  };
  go.addEventListener("click", (e) => {
    e.preventDefault();
    void run();
  });
  const form = h(
    "form",
    {
      class: "form-body",
      novalidate: true,
      onsubmit: (e: Event) => {
        e.preventDefault();
        void run();
      },
      oninput: () => recheck(),
    },
    ...o.body,
    error,
  );
  sheet = new Sheet(form, {
    label: o.label,
    size: "tall",
    className: "form-sheet",
    nav: {
      title: o.title,
      leading: h(
        "button",
        { class: "text-btn", type: "button", onclick: () => sheet.close() },
        t("common.cancel"),
      ),
      trailing: go,
    },
  });
  recheck();
  return { sheet, recheck };
}
