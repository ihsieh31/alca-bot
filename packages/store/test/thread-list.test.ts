import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const at = (i: number) => new Date(Date.UTC(2026, 10, 4, 0, 0, i));

describe("thread list paging, archive and delete (P13 A6)", () => {
  it("pages by updatedAt + id with no gaps or repeats, even with equal times", () => {
    const s = openStore(":memory:");
    for (let i = 0; i < 7; i++)
      s.threads.create(`thr_${String(i).padStart(2, "0")}`, `t${i}`, at(i < 4 ? 1 : i));
    const seen: string[] = [];
    let before: { updatedAt: string; id: string } | undefined;
    for (;;) {
      const page = s.threads.list(3, before ? { before } : {});
      seen.push(...page.map((t) => t.id));
      if (page.length < 3) break;
      const last = page.at(-1)!;
      before = { updatedAt: last.updatedAt, id: last.id };
    }
    expect(seen).toEqual(["thr_06", "thr_05", "thr_04", "thr_03", "thr_02", "thr_01", "thr_00"]);
    s.close();
  });

  it("archive hides a thread and lists it under archived; bringing it back restores it", () => {
    const s = openStore(":memory:");
    s.threads.create("thr_a", "a", at(1));
    s.threads.create("thr_b", "b", at(2));
    expect(s.threads.setArchived("thr_a", true, at(3))).toBe(true);
    expect(s.threads.list().map((t) => t.id)).toEqual(["thr_b"]);
    expect(s.threads.list(50, { archived: true }).map((t) => t.id)).toEqual(["thr_a"]);
    s.threads.setArchived("thr_a", false);
    expect(s.threads.list().map((t) => t.id)).toEqual(["thr_b", "thr_a"]);
    s.close();
  });

  it("erase removes messages and the title; the thread no longer opens or lists, the run stays", () => {
    const s = openStore(":memory:");
    s.threads.create("thr_x", "私密", at(1));
    s.threads.addMessage({ id: "msg_1", threadId: "thr_x", runId: null, role: "user", content: "我的秘密" });
    s.threads.setSession("thr_x", "demo", "sess_1");
    expect(s.threads.dependents("thr_x")).toEqual({ routines: 0, triggers: 0, workers: 0 });
    expect(s.threads.erase("thr_x")).toBe(true);
    expect(s.threads.get("thr_x")).toBeUndefined();
    expect(s.threads.list(50, { archived: true })).toEqual([]);
    expect(s.threads.messages("thr_x")).toEqual([]);
    expect(s.threads.getSession("thr_x", "demo")).toBeUndefined();
    const row = s.db.prepare("SELECT title, deleted_at FROM threads WHERE id = 'thr_x'").get() as {
      title: string | null;
      deleted_at: string | null;
    };
    expect(row.title).toBeNull();
    expect(row.deleted_at).not.toBeNull();
    expect(s.threads.erase("thr_x")).toBe(false);
    expect(s.threads.setArchived("thr_x", false)).toBe(false);
    s.close();
  });
});
