import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { findNames, scanFile } from "../../../scripts/check-names.ts";

const names = (t: string) => findNames(t).map((h) => h.name);

describe("check:names (CLEANROOM rule 2, review L8)", () => {
  it("catches compound names where an identifier word starts, in any case", () => {
    expect(names("export function openBotForm() {}")).toEqual(["OpenBot"]);
    expect(names("showOpenBot(); OPENBOT; open-bot; open_bot")).toEqual([
      "OpenBot",
      "OpenBot",
      "OpenBot",
      "OpenBot",
    ]);
    expect(names("const x = new MausBot()")).toEqual(["MausBot"]);
    expect(names("OpenMausBot")).toEqual(["OpenMausBot"]);
    expect(names("import { CopilotKit } from 'x'; copilot-kit")).toEqual(["CopilotKit", "CopilotKit"]);
    expect(names("reopenBottom(); popenbot")).toEqual([]);
  });

  it("matches short names only as a whole identifier word (no 'ego' false positives)", () => {
    expect(names("the Hermes agent; hermes_mode; useHermes")).toEqual(["Hermes", "Hermes", "Hermes"]);
    expect(names("hermetic seal")).toEqual([]);
    expect(names("AG-UI events; agui; ag_ui")).toEqual(["AG-UI", "AG-UI", "AG-UI"]);
    expect(names("drag-ui flagui")).toEqual([]);
    expect(names("Ego; ego-mode; egoMode")).toEqual(["Ego", "Ego", "Ego"]);
    expect(names("category negotiate Diego lego Egon egotistic allegory")).toEqual([]);
  });

  it("checks file names too, and the repo is clean", () => {
    expect(scanFile("apps/x/open-bot.ts", "")).toEqual(["apps/x/open-bot.ts: file name: OpenBot (open-bot)"]);
    const out = execFileSync(process.execPath, ["scripts/check-names.ts"], { encoding: "utf8" });
    expect(out).toMatch(/^names: clean/);
  });
});
