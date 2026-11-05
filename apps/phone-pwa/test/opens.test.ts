// Review 2026-11-05 #1 / #3: notification-tap listeners end with their session, and a tap
// that arrived as a message is not replayed from the pending cache on the next resume.
import { describe, expect, it } from "vitest";
import { PENDING_CACHE, PENDING_KEY, wireOpens } from "../app/reach.ts";

type H = (e: Event) => void;
function target() {
  const hs: Array<{ type: string; h: H; signal: AbortSignal | undefined }> = [];
  return {
    visibilityState: "visible",
    addEventListener: (type: string, h: H, o?: { signal?: AbortSignal }) => {
      hs.push({ type, h, signal: o?.signal });
      o?.signal?.addEventListener("abort", () =>
        hs.splice(
          hs.findIndex((x) => x.h === h),
          1,
        ),
      );
    },
    fire(type: string, e: Partial<MessageEvent> = {}) {
      for (const x of [...hs]) if (x.type === type) x.h(e as Event);
    },
    count: (type: string) => hs.filter((x) => x.type === type).length,
    hs,
  };
}
function storage() {
  const box = new Map<string, unknown>();
  return {
    box,
    open: async (name: string) => {
      expect(name).toBe(PENDING_CACHE);
      return {
        match: async (k: string) => {
          const v = box.get(k);
          return v === undefined ? undefined : { json: async () => v };
        },
        delete: async (k: string) => box.delete(k),
      };
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("phone: notification-tap listeners per session", () => {
  it("every listener is registered with the session's signal and removed when it ends (revoke / forget)", async () => {
    const doc = target();
    const sw = target();
    const st = storage();
    const seen: string[] = [];
    const first = new AbortController();
    wireOpens({ doc, sw, storage: st, signal: first.signal, go: (t, id) => seen.push(`1:${t}:${id}`) });
    expect(doc.hs.every((x) => x.signal === first.signal)).toBe(true);
    expect(sw.hs.every((x) => x.signal === first.signal)).toBe(true);
    first.abort();
    expect(doc.count("visibilitychange") + sw.count("message")).toBe(0);
    // The next session (re-paired in the page, no reload): only its own set runs.
    const second = new AbortController();
    wireOpens({ doc, sw, storage: st, signal: second.signal, go: (t, id) => seen.push(`2:${t}:${id}`) });
    expect(doc.count("visibilitychange")).toBe(1);
    expect(sw.count("message")).toBe(1);
    sw.fire("message", { data: { type: "alca-open", t: "approval", id: "apv_1" } });
    await tick();
    expect(seen).toEqual(["2:approval:apv_1"]);
  });

  it("a pending note read after the session ended is not acted on", async () => {
    const st = storage();
    st.box.set(PENDING_KEY, { t: "approval", id: "apv_2", at: Date.now() });
    const ac = new AbortController();
    const seen: string[] = [];
    wireOpens({ doc: target(), sw: undefined, storage: st, signal: ac.signal, go: (t) => seen.push(t) });
    ac.abort();
    await tick();
    expect(seen).toEqual([]);
  });

  it("a tap handled as a message drops the pending note, so the next resume does not replay it", async () => {
    const doc = target();
    const sw = target();
    const st = storage();
    const seen: string[] = [];
    wireOpens({
      doc,
      sw,
      storage: st,
      signal: new AbortController().signal,
      go: (t, id) => seen.push(`${t}:${id}`),
    });
    await tick();
    // The worker writes the note, then posts (app already visible: no visibilitychange).
    st.box.set(PENDING_KEY, { t: "approval", id: "apv_3", at: Date.now() });
    sw.fire("message", { data: { type: "alca-open", t: "approval", id: "apv_3" } });
    await tick();
    await tick();
    expect(st.box.has(PENDING_KEY)).toBe(false);
    // Background, then back within PENDING_MAX_AGE_MS (after once()'s window): nothing again.
    doc.fire("visibilitychange");
    await tick();
    await tick();
    expect(seen).toEqual(["approval:apv_3"]);
  });

  it("start and visibility read the pending note (iOS may lose the message)", async () => {
    const doc = target();
    const st = storage();
    const seen: string[] = [];
    wireOpens({
      doc,
      sw: undefined,
      storage: st,
      signal: new AbortController().signal,
      go: (t, id) => seen.push(`${t}:${id}`),
    });
    await tick();
    st.box.set(PENDING_KEY, { t: "offer", id: "off_1", at: Date.now() });
    doc.fire("visibilitychange");
    await tick();
    await tick();
    expect(seen).toEqual(["offer:off_1"]);
  });
});

describe("phone: #open= kinds", () => {
  it("main.ts reads every kind the worker can open, offer included (review #10)", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../app/main.ts", import.meta.url), "utf8");
    const kinds = /open=\(([a-z|]+)\)/.exec(main)?.[1]?.split("|") ?? [];
    expect(kinds.sort()).toEqual(["approval", "handoff", "offer", "question", "test"]);
  });
});
