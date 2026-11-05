import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { uiText } from "./ui-text.ts";

/** Words the mac test 2026-11-04b checked against what really happened (C1, B8). */
describe("settings words match the machine", () => {
  // G2: the words are in the string table; uiText shows each t("key") as its text.
  const settings = uiText("apps/desktop/ui/settings-system.ts");
  const panel = uiText("apps/desktop/ui/browser.ts");

  it("C1: the download is about 200 MB (mac-arm64 zip ≈ 197 MB), not 150", () => {
    for (const src of [settings, panel, readFileSync("docs/RUNNING.md", "utf8")]) {
      expect(src).not.toContain("150 MB");
      expect(src).toContain("200 MB");
    }
  });

  it("C1: the help says the download starts with Alca and that everyday Chrome is not used", () => {
    expect(settings).toContain("一啟動就在背景下載");
    expect(settings).toContain("平常用的 Google Chrome 不會被拿來用");
    expect(settings).not.toContain("第一次要用瀏覽器就自動下載");
  });

  it("B8: a backup's file name carries its whole name as a title", () => {
    expect(settings).toMatch(/class: "st-backup-name",\s*title: x\.name/);
    expect(readFileSync("apps/desktop/ui/settings.css", "utf8")).toMatch(
      /\.st-backup-name \{\s*user-select: all;/,
    );
  });
});
