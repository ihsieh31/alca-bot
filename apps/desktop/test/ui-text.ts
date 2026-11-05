// G2 (R9): UI words moved from the sources into the string table. Tests that
// read a UI file's text read it through here: every t("key") / tx("key") /
// tKey("key") call is shown as its Chinese text, so a test about the words
// still sees them where they are used.
import { readFileSync } from "node:fs";
import { zhHantTW } from "../../../packages/design/src/i18n/zh-Hant-TW.ts";

const TABLE: Readonly<Record<string, string>> = zhHantTW;

/** `src` with each table call shown as its text: `t("k")` → `"<中文>"`, `t("k", {…})` → `("<中文>", {…})`. */
export function withWords(src: string): string {
  return src
    .replace(/\b(?:t|tx|tKey)\(\s*"([\w.-]+)"\s*\)/g, (m, key: string) =>
      key in TABLE ? JSON.stringify(TABLE[key]) : m,
    )
    .replace(/\b(?:t|tx|tKey)\(\s*"([\w.-]+)"/g, (m, key: string) =>
      key in TABLE ? `(${JSON.stringify(TABLE[key])}` : m,
    );
}

/** A UI file (path from the repo root), with its words filled in. */
export function uiText(path: string): string {
  return withWords(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));
}
