// 素 Plain §3.8: one value from three or more options is a popup button (a native
// <select> drawn as a push button with a ⌄), never a segmented control in a form.
import { h } from "./dom.ts";

export interface Popup<T extends string> {
  el: HTMLSelectElement;
  get(): T;
}

export function popup<T extends string>(
  id: string,
  value: T,
  options: ReadonlyArray<readonly [T, string]>,
  onChange?: (v: T) => void,
): Popup<T> {
  let v = value;
  const el = h(
    "select",
    {
      class: "popup",
      id,
      onchange: (e: Event) => {
        v = (e.target as HTMLSelectElement).value as T;
        onChange?.(v);
      },
    },
    ...options.map(([val, text]) => h("option", { value: val, selected: val === value }, text)),
  ) as HTMLSelectElement;
  return { el, get: () => v };
}
