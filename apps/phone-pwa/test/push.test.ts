import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { buildPwa } from "../scripts/build.ts";

/**
 * The built service worker, run in a VM with a stand-in `self`: a push shows
 * a fixed sentence for its type (never content from the payload), and a tap
 * opens or focuses the app at `#open=<type>:<id>`.
 */

const dist = buildPwa(mkdtempSync(join(tmpdir(), "alca-pwa-push-")));
afterAll(() => rmSync(dist, { recursive: true, force: true }));
const code = readFileSync(join(dist, "sw.js"), "utf8");

type Handler = (e: Record<string, unknown>) => void;

function loadSw(clients: Array<Record<string, unknown>> = []) {
  const handlers = new Map<string, Handler>();
  const shown: Array<{ title: string; o: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const waits: Promise<unknown>[] = [];
  const self = {
    addEventListener: (t: string, h: Handler) => handlers.set(t, h),
    skipWaiting: async () => undefined,
    registration: {
      scope: "https://alca.example/app/",
      showNotification: async (title: string, o: Record<string, unknown>) => {
        shown.push({ title, o });
      },
      getNotifications: async () => [],
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => clients,
      openWindow: async (u: string) => {
        opened.push(u);
        return null;
      },
    },
  };
  runInNewContext(code, {
    self,
    caches: {
      open: async () => ({ put: async () => {}, match: async () => undefined, delete: async () => true }),
    },
    location: { origin: "https://alca.example" },
    URL,
    JSON,
    Date,
  });
  const fire = async (type: string, e: Record<string, unknown>) => {
    handlers.get(type)?.({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits.splice(0));
  };
  return { fire, shown, opened, handlers };
}

const push = (payload: unknown) => ({ data: { json: () => payload } });

describe("service worker push + notificationclick", () => {
  it("shows the fixed sentence for the type, keyed by the opaque id", async () => {
    const sw = loadSw();
    await sw.fire("push", push({ v: 1, t: "approval", id: "apv_01J" }));
    expect(sw.shown[0]?.title).toBe("需要你");
    expect(sw.shown[0]?.o).toMatchObject({
      body: "有一件事要你點頭。打開 Alca 看詳情。",
      tag: "apv_01J",
      data: { t: "approval", id: "apv_01J" },
      requireInteraction: true,
    });
  });

  it("never shows words from the payload, and still notifies for an unreadable push", async () => {
    const sw = loadSw();
    await sw.fire(
      "push",
      push({ t: "approval", id: "付款給王小明 NT$1280", title: "付款給王小明", body: "NT$1280" }),
    );
    const dump = JSON.stringify(sw.shown);
    expect(dump).not.toContain("王小明");
    expect(dump).not.toContain("1280");
    await sw.fire("push", { data: { json: () => JSON.parse("{") } });
    expect(sw.shown).toHaveLength(2);
    expect(sw.shown[1]?.title).toBe("需要你");
    await sw.fire("push", push({ t: "question", id: "qst_1" }));
    expect(sw.shown[2]?.title).toBe("Alca 有個問題");
  });

  it("opens the app at the card when no window is open", async () => {
    const sw = loadSw();
    let closed = false;
    await sw.fire("notificationclick", {
      notification: { data: { t: "approval", id: "apv_9" }, close: () => (closed = true), tag: "apv_9" },
      action: "",
    });
    expect(closed).toBe(true);
    expect(sw.opened).toEqual(["https://alca.example/app/#open=approval:apv_9"]);
  });

  it("focuses an open app and tells it which card (no reload)", async () => {
    const msgs: unknown[] = [];
    let focused = false;
    const win = {
      url: "https://alca.example/app/",
      focused: false,
      focus: async () => {
        focused = true;
        return win;
      },
      navigate: async () => null,
      postMessage: (m: unknown) => msgs.push(m),
    };
    const sw = loadSw([win]);
    await sw.fire("notificationclick", {
      notification: { data: { t: "question", id: "qst_2" }, close: () => undefined, tag: "qst_2" },
      action: "",
    });
    expect(focused).toBe(true);
    expect(msgs).toEqual([{ type: "alca-open", t: "question", id: "qst_2" }]);
    expect(sw.opened).toEqual([]);
  });

  it("answers its build version on a MessageChannel", () => {
    const sw = loadSw();
    const got: unknown[] = [];
    sw.handlers.get("message")?.({
      data: { type: "alca-version" },
      ports: [{ postMessage: (m: unknown) => got.push(m) }],
      waitUntil: () => undefined,
    });
    expect(got[0]).toMatchObject({ version: expect.stringMatching(/^[0-9a-f]{12}$/) });
  });

  it("ships the badge icon and the device stylesheet", () => {
    expect(code).toContain('"./icons/badge-96.png"');
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain("./styles/device.css");
  });
});
