// BUG-14: a chat-only phone stops offering 刪除 as soon as the computer takes approve away.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scopesEvent, scopesFrom } from "../app/scopes.ts";

describe("phone scopes", () => {
  it("reads a scope change from a Link event, and nothing else", () => {
    expect(scopesEvent("link", { type: "scopes", scopes: ["chat"] })).toEqual(["chat"]);
    expect(scopesEvent("link", { type: "scopes", scopes: ["chat", 3, null] })).toEqual(["chat"]);
    expect(scopesEvent("link", { type: "scopes", scopes: [] })).toEqual([]);
    expect(scopesEvent("link", { type: "devices.changed" })).toBeUndefined();
    expect(scopesEvent("link", { type: "scopes" })).toBeUndefined();
    expect(scopesEvent("alca", { type: "scopes", scopes: ["chat"] })).toBeUndefined();
    expect(scopesEvent("link", null)).toBeUndefined();
    expect(scopesFrom("chat")).toBeUndefined();
  });

  it("the session emits 'scopes' and the 對話 list (刪除) and other scoped views repaint on it", () => {
    const read = (f: string) => readFileSync(new URL(`../app/${f}`, import.meta.url), "utf8");
    const session = read("session.ts");
    expect(session).toMatch(/scopesEvent\(ch, e\)[\s\S]{0,120}this\.changed\("scopes"\)/);
    // The drawer became the 對話 tab (素 Plain §3.2): its swipe 刪除 follows the scope live.
    const list = read("threads-view.ts");
    expect(list).toMatch(/w === "scopes"[^;]*\) paint\(\)/);
    expect(list).toMatch(/s\.can\("approve"\)/);
    // Review #9: view_screen taken away hides 瀏覽器 in the chat bar; an open approval disarms.
    expect(read("chat.ts")).toMatch(
      /what === "scopes"\)\s*this\.browserBtn\.hidden = !s\.can\("view_screen"\)/,
    );
    expect(read("cards.ts")).toMatch(
      /w !== "scopes"[\s\S]{0,160}!s\.can\("approve"\)\) allow\.disabled = deny\.disabled = true/,
    );
    for (const f of ["workers.ts", "memory.ts", "connect.ts", "team.ts"])
      expect(read(f), f).toContain('"scopes"');
  });
});
