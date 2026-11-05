import { describe, expect, it } from "vitest";
import { openStore, segment, toMatchQuery } from "../src/index.ts";

function store() {
  const s = openStore(":memory:");
  const botId = s.bots.ensureDefault().id;
  const add = (body: string) =>
    s.memory.add({
      botId,
      scope: "shared",
      kind: "fact",
      body,
      origin: "user",
      confidence: 1,
      source: { kind: "ui" },
    });
  return { s, add, botId };
}

describe("CJK segmentation", () => {
  it("splits CJK runs into bigrams + trailing unigram and keeps latin words", () => {
    expect(segment("長期記憶")).toEqual(["長期", "期記", "記憶", "憶"]);
    expect(segment("用 Claude Code 做記憶")).toEqual(["用", "claude", "code", "做記", "記憶", "憶"]);
    expect(segment("，。！")).toEqual([]);
  });

  it("builds safe MATCH expressions", () => {
    expect(toMatchQuery("記憶")).toBe('"記憶"');
    expect(toMatchQuery("記")).toBe('"記"*');
    expect(toMatchQuery('a"b')).toBe('"a b"');
    // FTS operators in user input are neutralised into quoted terms.
    expect(toMatchQuery('x" OR NEAR(y')).toBe('"x"* AND "or"* AND "near y"');
    expect(toMatchQuery("   ")).toBeNull();
  });
});

describe("memory FTS (CJK)", () => {
  it("a 2-char Chinese query like 記憶 matches inside a longer run", () => {
    const { s, add } = store();
    const hit = add("使用者希望長期記憶系統全部 agent 共用");
    add("今天的天氣很好");
    const r = s.memory.search("記憶");
    expect(r.map((x) => x.id)).toEqual([hit.id]);
    s.close();
  });

  it("matches at run start, end, single chars, and mixed CJK/latin queries", () => {
    const { s, add } = store();
    const a = add("記憶整理");
    const b = add("共用記憶");
    const c = add("Alca Agent 的權限設定");
    expect(
      s.memory
        .search("記憶")
        .map((x) => x.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(
      s.memory
        .search("憶")
        .map((x) => x.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(s.memory.search("權限").map((x) => x.id)).toEqual([c.id]);
    expect(s.memory.search("agent 權限").map((x) => x.id)).toEqual([c.id]);
    expect(s.memory.search("agent權限設定").map((x) => x.id)).toEqual([]);
    expect(s.memory.search("的權限設定").map((x) => x.id)).toEqual([c.id]);
    expect(s.memory.search("AGENT").map((x) => x.id)).toEqual([c.id]);
    expect(s.memory.search("天氣")).toEqual([]);
    s.close();
  });

  it("does not match characters out of order and handles Japanese kana", () => {
    const { s, add } = store();
    add("記憶");
    const j = add("きおくを共有する");
    expect(s.memory.search("憶記")).toEqual([]);
    expect(s.memory.search("共有").map((x) => x.id)).toEqual([j.id]);
    s.close();
  });

  it("keeps the index in sync on supersede and forget", () => {
    const { s, add, botId } = store();
    const m = add("喜歡喝珍珠奶茶");
    expect(s.memory.search("奶茶")).toHaveLength(1);
    const next = s.memory.add({
      botId,
      scope: "shared",
      kind: "preference",
      body: "改喝無糖綠茶",
      origin: "user",
      confidence: 1,
      source: { kind: "ui" },
      supersedes: m.id,
    });
    expect(s.memory.search("奶茶")).toHaveLength(0);
    expect(s.memory.search("奶茶", { includeSuperseded: true })).toHaveLength(1);
    expect(s.memory.search("綠茶")).toHaveLength(1);
    s.memory.forgetChain(next.id);
    expect(s.memory.search("綠茶")).toHaveLength(0);
    expect(s.memory.search("奶茶", { includeSuperseded: true })).toHaveLength(0);
    s.close();
  });

  it("separates the shared user model from a bot's own notes", () => {
    const { s, botId } = store();
    const other = s.bots.create("研究員");
    const base = {
      kind: "fact" as const,
      origin: "user" as const,
      confidence: 1,
      source: { kind: "ui" as const },
    };
    s.memory.add({ ...base, botId, scope: "shared", body: "記憶共用" });
    s.memory.add({ ...base, botId: other.id, scope: "bot", body: "記憶筆記" });
    expect(s.memory.search("記憶", { visibleTo: botId })).toHaveLength(1);
    expect(s.memory.search("記憶", { visibleTo: other.id })).toHaveLength(2);
    expect(s.memory.search("記憶", { scope: "bot" })).toHaveLength(1);
    s.close();
  });
});
