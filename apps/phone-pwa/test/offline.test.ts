import type { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { memoryStore, SealedStore } from "../app/cache-crypto.ts";
import { OfflineCache, Outbox, type OutboxItem } from "../app/offline.ts";

const SECRET = "請幫我付款給山嵐選物 NT$1,280";

describe("phone × encrypted offline cache (P13)", () => {
  it("seals every record: nothing readable at rest, keys are not extractable", async () => {
    const raw = memoryStore();
    const st = await SealedStore.open(raw, "dev_1");
    await st.put("thread:thr_1", { messages: [{ content: SECRET }] });
    expect(await st.get("thread:thr_1")).toEqual({ messages: [{ content: SECRET }] });
    // At rest: ciphertext only, no plaintext, no raw key bytes.
    const atRest = [...raw.map.values()].map((v) => {
      const o = v as { ct?: ArrayBuffer; data?: ArrayBuffer };
      return o.ct ? Buffer.from(o.ct).toString() : o.data ? Buffer.from(o.data).toString() : "";
    });
    expect(atRest.join("")).not.toContain("山嵐");
    expect(JSON.stringify([...raw.map.keys()])).not.toContain("山嵐");
    const kek = raw.map.get("k:kek") as webcrypto.CryptoKey;
    expect(kek.extractable).toBe(false);
    expect(kek.usages.sort()).toEqual(["unwrapKey", "wrapKey"]);
    await expect(crypto.subtle.exportKey("raw", kek)).rejects.toThrow();
    // The data key is stored wrapped only; what the store uses cannot be exported either.
    const dk = (st as unknown as { dk: webcrypto.CryptoKey }).dk;
    expect(dk.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", dk)).rejects.toThrow();
  });

  it("opens again on the next launch; a record moved to another name or tampered is dropped", async () => {
    const raw = memoryStore();
    await (await SealedStore.open(raw, "dev_1")).put("a", { n: 1 });
    const again = await SealedStore.open(raw, "dev_1");
    expect(await again.get("a")).toEqual({ n: 1 });
    raw.map.set("r:b", raw.map.get("r:a"));
    expect(await again.get("b")).toBeUndefined();
    expect(raw.map.has("r:b")).toBe(false);
    const rec = raw.map.get("r:a") as { ct: ArrayBuffer };
    const ct = new Uint8Array(rec.ct);
    ct.set([(ct[0] ?? 0) ^ 1], 0);
    expect(await again.get("a")).toBeUndefined();
  });

  it("is bound to the pairing: another device id (a new pairing) starts empty; destroy shreds the keys", async () => {
    const raw = memoryStore();
    await (await SealedStore.open(raw, "dev_1")).put("a", { n: 1 });
    const other = await SealedStore.open(raw, "dev_2");
    expect(await other.get("a")).toBeUndefined();
    expect(await other.names()).toEqual([]);
    await other.put("x", 1);
    await other.destroy();
    expect(raw.map.size).toBe(0);
  });

  it("a finished turn re-saves the open conversation, so offline shows the last answer", async () => {
    const messages = [
      { id: "msg_1", runId: "run_1", role: "user" as const, content: "幫我整理明天的行程" },
      { id: "msg_2", runId: "run_1", role: "assistant" as const, content: "收到" },
    ];
    let online = true;
    const asked: string[] = [];
    const c = {
      online: () => online,
      request: async <T>(op: string) => {
        asked.push(op);
        return { messages: [...messages] } as T;
      },
    };
    const cache = new OfflineCache(await SealedStore.open(memoryStore(), "dev_resave"));
    expect(await cache.refresh(c, "thr_r", "行程")).toBe(true);
    expect((await cache.thread("thr_r"))?.messages.map((m) => m.content)).toEqual([
      "幫我整理明天的行程",
      "收到",
    ]);
    // Offline nothing is asked of the computer and the saved copy stays.
    online = false;
    messages.push({ id: "msg_3", runId: "run_2", role: "user", content: "不該存" });
    expect(await cache.refresh(c, "thr_r", "行程")).toBe(false);
    expect((await cache.thread("thr_r"))?.messages).toHaveLength(2);
    expect(asked).toEqual(["threads.get"]);
  });

  it("keeps the newest conversations' messages and drops tool rows", async () => {
    const cache = new OfflineCache(await SealedStore.open(memoryStore(), "dev_1"));
    const msgs = Array.from({ length: 250 }, (_, i) => ({
      id: `msg_${i}`,
      runId: null,
      role: (i % 10 === 0 ? "tool" : "user") as "tool" | "user",
      content: `m${i}`,
    }));
    await cache.saveThread("thr_1", "t", msgs);
    const t = await cache.thread("thr_1");
    expect(t?.messages.length).toBe(200);
    expect(t?.messages.some((m) => m.role === "tool")).toBe(false);
    expect(t?.messages.at(-1)?.content).toBe("m249");
    const list = Array.from({ length: 35 }, (_, i) => ({
      id: `thr_${i}`,
      title: null,
      updatedAt: "",
      busy: false,
      waiting: false,
      workers: 0,
    }));
    for (const x of list.slice(28)) await cache.saveThread(x.id, null, []);
    await cache.saveThreads(list);
    expect(await cache.thread("thr_29")).toBeDefined();
    expect(await cache.thread("thr_31")).toBeUndefined();
    expect(await cache.threads()).toHaveLength(35);
  });
});

type Call = { op: string; args: Record<string, unknown> };

function fakeCore(script: Array<(c: Call) => unknown> = []) {
  const calls: Call[] = [];
  const sent = new Map<string, unknown>();
  let online = true;
  return {
    calls,
    sent,
    setOnline: (v: boolean) => (online = v),
    api: {
      online: () => online,
      request: async <T>(op: string, args: Record<string, unknown>): Promise<T> => {
        const c = { op, args };
        calls.push(c);
        const step = script.shift();
        if (step) {
          const r = step(c);
          if (r instanceof Error) throw r;
          if (r !== undefined) return r as T;
        }
        if (op === "threads.create") return { id: `thr_new_${String(args.clientKey)}` } as T;
        const key = String(args.clientKey);
        if (sent.has(key)) return { runId: sent.get(key), duplicate: true } as T;
        sent.set(key, `run_${sent.size}`);
        return { runId: sent.get(key) } as T;
      },
    },
  };
}

const err = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("phone × outbox (P13)", () => {
  it("sends in the order typed, once each, with the phone's own key", async () => {
    const box = new Outbox(await SealedStore.open(memoryStore(), "dev_1"));
    const core = fakeCore();
    await box.add("一", "thr_1", null);
    await box.add("二", "thr_1", null);
    await box.add("三", "thr_2", null);
    await box.flush(core.api);
    expect(core.calls.map((c) => c.args.text)).toEqual(["一", "二", "三"]);
    expect(new Set(core.calls.map((c) => c.args.clientKey)).size).toBe(3);
    expect(box.items).toEqual([]);
  });

  it("a lost connection leaves the item queued; the next flush reuses its key, so it is not sent twice", async () => {
    const box = new Outbox(await SealedStore.open(memoryStore(), "dev_1"));
    // The core got the first try but its answer was lost (timeout).
    const core = fakeCore([
      (c) => {
        core.sent.set(String(c.args.clientKey), "run_0");
        return err("timeout");
      },
    ]);
    await box.add("付款前先問我", "thr_1", null);
    await box.add("第二則", "thr_1", null);
    await box.flush(core.api);
    expect(box.items.map((i) => i.state)).toEqual(["queued", "queued"]);
    expect(core.calls).toHaveLength(1); // stopped: nothing after it went first
    await box.flush(core.api);
    expect(core.calls[1]?.args.clientKey).toBe(core.calls[0]?.args.clientKey);
    expect(core.sent.size).toBe(2); // two messages, the first not twice
    expect(box.items).toEqual([]);
  });

  it("offline: nothing is tried; concurrent flushes share one pass", async () => {
    const box = new Outbox(undefined);
    const core = fakeCore();
    core.setOnline(false);
    await box.add("離線打的", "thr_1", null);
    await box.flush(core.api);
    expect(core.calls).toHaveLength(0);
    core.setOnline(true);
    await Promise.all([box.flush(core.api), box.flush(core.api), box.flush(core.api)]);
    expect(core.calls).toHaveLength(1);
  });

  it("a busy conversation waits and keeps the order; a refused one fails and stays until retried or removed", async () => {
    const box = new Outbox(undefined);
    box.busyRetryMs = 20;
    const core = fakeCore([() => err("busy", "這個對話正在執行中")]);
    await box.add("等一下", "thr_1", null);
    await box.add("然後這個", "thr_1", null);
    await box.flush(core.api);
    expect(box.items[0]?.state).toBe("waiting");
    await new Promise((r) => setTimeout(r, 80));
    expect(box.items).toEqual([]);
    expect(core.calls.map((c) => c.args.text)).toEqual(["等一下", "等一下", "然後這個"]);

    const core2 = fakeCore([() => err("not_found", "沒有這個對話")]);
    await box.add("給刪掉的對話", "thr_gone", null);
    await box.add("下一則照送", "thr_1", null);
    await box.flush(core2.api);
    expect(box.items).toHaveLength(1);
    expect(box.items[0]).toMatchObject({ state: "failed", error: "沒有這個對話" });
    await box.flush(core2.api);
    expect(core2.calls).toHaveLength(2); // a failed item is not retried by itself
    await box.retry(box.items[0]?.key as string);
    expect(box.items[0]?.state).toBe("queued");
    await box.remove(box.items[0]?.key as string);
    expect(box.items).toEqual([]);
  });

  it("retry / delete never touch an item that is on its way (review #16)", async () => {
    const box = new Outbox(undefined);
    const item = await box.add("送出中", "thr_1", null);
    (box.items[0] as OutboxItem).state = "sending";
    await box.remove(item.key);
    expect(box.items).toHaveLength(1);
    await box.retry(item.key);
    expect(box.items[0]?.state).toBe("sending");
    (box.items[0] as OutboxItem).state = "failed";
    await box.retry(item.key);
    expect(box.items[0]?.state).toBe("queued");
    await box.remove(item.key);
    expect(box.items).toEqual([]);
  });

  it("the outbox bubble re-reads the item at the tap and keeps one live region (review #16)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/outbox-view.ts", import.meta.url), "utf8");
    expect(src).toMatch(/run: \(\) => idle\(\) && act\.retry/);
    expect(src).toMatch(/run: \(\) => idle\(\) && act\.remove/);
    expect(src).toMatch(/waiting: t\("phone\.outboxView\.willSendAfterThisChat"\)/);
    expect(src).toMatch(
      /querySelector<HTMLElement>\(":scope > \.q-meta"\) \?\? h\("p", \{ class: "q-meta", role: "status" \}\)/,
    );
  });

  it("a new conversation typed offline is made once, and its other messages follow it", async () => {
    const box = new Outbox(undefined);
    const core = fakeCore();
    const created: string[] = [];
    await box.add("新對話第一句", null, "bot_research", "draft_a");
    await box.add("第二句", null, null, "draft_a");
    await box.add("另一個新對話", null, null, "draft_b");
    expect(box.for(null, "draft_a").map((i) => i.text)).toEqual(["新對話第一句", "第二句"]);
    await box.flush({ ...core.api, created: (_i, id) => created.push(id) });
    const creates = core.calls.filter((c) => c.op === "threads.create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.args).toMatchObject({ botId: "bot_research", title: "新對話第一句" });
    expect(String(creates[0]?.args.clientKey)).toMatch(/-t$/);
    const sends = core.calls.filter((c) => c.op === "threads.send");
    expect(sends[0]?.args.threadId).toBe(sends[1]?.args.threadId);
    expect(sends[2]?.args.threadId).not.toBe(sends[0]?.args.threadId);
    expect(created).toHaveLength(2);
  });

  it("survives a restart sealed; an item that was mid-send is queued again with the same key", async () => {
    const raw = memoryStore();
    const st = await SealedStore.open(raw, "dev_1");
    const box = new Outbox(st);
    const item = await box.add(SECRET, "thr_1", null);
    (box.items[0] as OutboxItem).state = "sending";
    await st.put("outbox", box.items);
    const atRest = JSON.stringify([...raw.map.entries()].map(([k, v]) => [k, Object.keys(v as object)]));
    expect(atRest).not.toContain("山嵐");
    const next = new Outbox(await SealedStore.open(raw, "dev_1"));
    await next.load();
    expect(next.items).toMatchObject([{ key: item.key, state: "queued", text: SECRET }]);
  });
});
