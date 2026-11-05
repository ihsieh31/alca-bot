import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Pane, Panes } from "../ui/panes.ts";

/** A pane like Library / ConnectView / TeamView: sets isOpen, then calls its changed hook. */
class FakePane implements Pane {
  isOpen = false;
  private readonly name: string;
  private readonly panes: Panes;
  constructor(name: string, panes: Panes) {
    this.name = name;
    this.panes = panes;
  }
  open(): void {
    this.isOpen = true;
    this.panes.changed(this.name, true);
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panes.changed(this.name, false);
  }
}

describe("desktop panes: one at a time, the chat shows only when none is open (mac test #6)", () => {
  function setup() {
    const state = { chatHidden: false };
    const panes = new Panes((on) => {
      state.chatHidden = on;
    });
    const library = new FakePane("library", panes);
    const connect = new FakePane("connect", panes);
    const team = new FakePane("team", panes);
    panes.add("library", library);
    panes.add("connect", connect);
    panes.add("team", team);
    return { state, library, connect, team };
  }

  it("記憶與技能 → 例行工作: the library closes and the chat stays hidden", () => {
    const { state, library, connect } = setup();
    library.open();
    expect(state.chatHidden).toBe(true);
    connect.open(); // the bug: library's close showed the chat again next to the routines pane
    expect(library.isOpen).toBe(false);
    expect(connect.isOpen).toBe(true);
    expect(state.chatHidden).toBe(true);
  });

  it("every order of switching ends with exactly one pane and a hidden chat; closing it shows the chat", () => {
    const { state, library, connect, team } = setup();
    const all = [library, connect, team];
    for (const a of all)
      for (const b of all) {
        if (a === b) continue;
        a.open();
        b.open();
        expect(all.filter((p) => p.isOpen)).toEqual([b]);
        expect(state.chatHidden).toBe(true);
        b.close();
        expect(state.chatHidden).toBe(false);
      }
  });

  it("app.ts routes every pane's hook through Panes (no hand-written main.hidden left)", () => {
    const src = readFileSync(fileURLToPath(new URL("../ui/app.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/\$\("main"\)\.hidden\s*=\s*isOpen/);
    for (const n of ["library", "connect", "team"]) expect(src).toContain(`panes.changed("${n}", isOpen)`);
  });
});

describe("desktop sidebar: every button has an accessible name (mac test #6)", () => {
  it("each <button> in index.html carries aria-label (the sidebar collapses to icons)", () => {
    const html = readFileSync(fileURLToPath(new URL("../ui/index.html", import.meta.url)), "utf8");
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(6);
    expect(buttons.filter((b) => !/\saria-label="[^"]+"/.test(b))).toEqual([]);
  });
});
