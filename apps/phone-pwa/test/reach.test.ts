// BUG-7 / BUG-8: a tapped notification → its card, also while Link is still reconnecting.
import { describe, expect, it } from "vitest";
import { t } from "../../../packages/design/src/i18n/index.ts";
import {
  CONNECT_TIMEOUT_MS,
  once,
  PENDING_CACHE,
  PENDING_KEY,
  type ReachDeps,
  reach,
  takePendingOpen,
  waitForOnline,
} from "../app/reach.ts";

function deps(over: Partial<ReachDeps> & { onlineAt?: number } = {}) {
  const log: string[] = [];
  let online = over.onlineAt === undefined;
  const d: ReachDeps & { log: string[]; thread: string | null; cardKnown: boolean } = {
    log,
    thread: "thr_other",
    cardKnown: true,
    online: () => online,
    waitOnline: async (ms) => {
      log.push(`wait:${ms}`);
      if (over.onlineAt !== undefined && over.onlineAt <= ms) online = true;
      return online;
    },
    locate: async () => ({ threadId: "thr_card", status: "pending" }),
    threadId: () => d.thread,
    openThread: async (id) => {
      log.push(`thread:${id}`);
      d.thread = id;
    },
    openCard: (id) => {
      if (d.cardKnown) log.push(`card:${id}`);
      return d.cardKnown;
    },
    openFirst: () => log.push("first"),
    openOffer: (id) => log.push(`offer:${id}`),
    openBrowser: () => log.push("browser"),
    toast: (m) => log.push(`toast:${m}`),
    banner: (m) => log.push(`banner:${m}`),
    sleep: async () => undefined,
    ...over,
  };
  return d;
}

describe("phone: reach the card a notification points at", () => {
  it("online: opens the card's thread and its sheet", async () => {
    const d = deps();
    expect(await reach(d, "approval", "apv_1", "push")).toBe("opened");
    expect(d.log).toEqual(["thread:thr_card", "card:apv_1"]);
  });

  it("resuming from the background: says it is connecting at once, waits, then opens the card (BUG-7)", async () => {
    const d = deps({ onlineAt: 4000 });
    expect(await reach(d, "approval", "apv_1", "push")).toBe("opened");
    expect(d.log[0]).toBe(`toast:${t("phone.main.connectingWillOpenCard")}`);
    expect(d.log[1]).toBe(`wait:${CONNECT_TIMEOUT_MS}`);
    expect(d.log.slice(2)).toEqual(["thread:thr_card", "card:apv_1"]);
  });

  it("the computer never answers: 'can't reach', not silence and not 'not found'", async () => {
    const d = deps({ onlineAt: Number.POSITIVE_INFINITY });
    expect(await reach(d, "approval", "apv_1", "push")).toBe("unreachable");
    expect(d.log.at(-1)).toBe(`toast:${t("phone.main.cantReachComputer")}`);
  });

  it("already handled on the computer: 這件事已經處理好了 (BUG-8)", async () => {
    const d = deps({ locate: async () => ({ threadId: "thr_card", status: "approved" }) });
    expect(await reach(d, "approval", "apv_1", "push")).toBe("handled");
    expect(d.log).toEqual([`toast:${t("phone.main.thisHasAlreadyBeenTaken")}`]);
    expect(t("phone.main.thisHasAlreadyBeenTaken")).toBe("這件事已經處理好了");
  });

  it("gone: 找不到這張卡了", async () => {
    const d = deps({ locate: async () => ({ threadId: null, status: "unknown" }) });
    expect(await reach(d, "question", "q_1", "push")).toBe("not_found");
    expect(d.log).toEqual([`toast:${t("phone.main.thisCardCantBeFound")}`]);
  });

  it("a stale socket: the first locate fails, the reconnect comes, the second one answers", async () => {
    let calls = 0;
    const d = deps({
      locate: async () => {
        if (++calls === 1) throw new Error("timeout");
        return { threadId: "thr_card", status: "pending" };
      },
    });
    expect(await reach(d, "approval", "apv_1", "push")).toBe("opened");
    expect(calls).toBe(2);
  });

  it("a real error while connected is shown, not swallowed", async () => {
    const d = deps({
      locate: async () => {
        throw new Error("這台裝置沒有「chat」權限");
      },
    });
    expect(await reach(d, "approval", "apv_1", "push")).toBe("error");
    expect(d.log.at(-1)).toBe(
      `toast:${t("phone.main.couldntOpenCard", { message: "這台裝置沒有「chat」權限" })}`,
    );
  });

  it("in front (told over Link): a banner for another thread, nothing for this one", async () => {
    const d = deps();
    expect(await reach(d, "approval", "apv_1", "app")).toBe("banner");
    d.thread = "thr_card";
    expect(await reach(d, "approval", "apv_1", "app")).toBe("on_screen");
  });

  it("the card has not arrived over the thread watch yet: falls back to the first card", async () => {
    const d = deps();
    d.cardKnown = false;
    expect(await reach(d, "approval", "apv_1", "push")).toBe("card_missing");
    expect(d.log.at(-1)).toBe("first");
  });

  it("an offer tap shows the offer at once: no card polling, no unrelated approval (review #2)", async () => {
    let slept = 0;
    const d = deps({
      locate: async () => ({ threadId: "thr_offer", status: "pending" }),
      sleep: async () => void slept++,
    });
    expect(await reach(d, "offer", "off_1", "push")).toBe("offer");
    expect(d.log).toEqual(["offer:off_1"]);
    expect(slept).toBe(0);
    // An offer that has no thread yet is still there to answer.
    const n = deps({ locate: async () => ({ threadId: null, status: "pending" }) });
    expect(await reach(n, "offer", "off_2", "push")).toBe("offer");
    expect(n.log).toEqual(["offer:off_2"]);
    const done = deps({ locate: async () => ({ threadId: null, status: "accepted" }) });
    expect(await reach(done, "offer", "off_3", "push")).toBe("handled");
    const gone = deps({ locate: async () => ({ threadId: null, status: "unknown" }) });
    expect(await reach(gone, "offer", "off_4", "push")).toBe("not_found");
    expect([...done.log, ...gone.log].some((l) => l === "first" || l.startsWith("card:"))).toBe(false);
  });

  it("test pings and handoffs need no lookup", async () => {
    const d = deps({ onlineAt: Number.POSITIVE_INFINITY });
    expect(await reach(d, "test", "", "push")).toBe("test");
    expect(await reach(d, "handoff", "h_1", "push")).toBe("handoff");
    expect(d.log).toEqual([`toast:${t("phone.main.notificationsAreWorking")}`, "browser"]);
  });
});

describe("phone: waiting for Link, acting once, the service worker's pending tap", () => {
  const client = (status: string) => {
    const hs: Array<(s: string) => void> = [];
    return {
      status,
      onStatus: (h: (s: string) => void) => {
        hs.push(h);
        return () => hs.splice(hs.indexOf(h), 1);
      },
      emit: (s: string) => {
        for (const h of [...hs]) h(s);
      },
      hs,
    };
  };

  it("waitForOnline: at once when online, on the status change, false on revoke or timeout", async () => {
    expect(await waitForOnline(client("online"), 10)).toBe(true);
    expect(await waitForOnline(client("revoked"), 10)).toBe(false);
    const c = client("connecting");
    const p = waitForOnline(c, 1000);
    c.emit("connecting");
    c.emit("online");
    expect(await p).toBe(true);
    expect(c.hs).toHaveLength(0);
    const r = client("offline");
    const q = waitForOnline(r, 1000);
    r.emit("revoked");
    expect(await q).toBe(false);
    expect(await waitForOnline(client("offline"), 5)).toBe(false);
  });

  it("once: the same tap from several paths acts once", () => {
    let now = 0;
    const fresh = once(10_000, () => now);
    expect(fresh("approval:a")).toBe(true);
    expect(fresh("approval:a")).toBe(false);
    expect(fresh("approval:b")).toBe(true);
    now = 11_000;
    expect(fresh("approval:a")).toBe(true);
  });

  it("takePendingOpen reads and removes the service worker's note; stale or odd notes are dropped", async () => {
    const box = new Map<string, unknown>();
    const storage = {
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
    box.set(PENDING_KEY, { t: "approval", id: "apv_1", at: 1000 });
    expect(await takePendingOpen(storage, 2000)).toEqual(["approval", "apv_1"]);
    expect(box.size).toBe(0);
    expect(await takePendingOpen(storage, 2000)).toBeUndefined();
    box.set(PENDING_KEY, { t: "approval", id: "apv_1", at: 0 });
    expect(await takePendingOpen(storage, 10 * 60_000)).toBeUndefined();
    box.set(PENDING_KEY, { t: "evil", id: "x", at: 1000 });
    expect(await takePendingOpen(storage, 2000)).toBeUndefined();
    box.set(PENDING_KEY, { t: "question", id: "../x", at: 1000 });
    expect(await takePendingOpen(storage, 2000)).toEqual(["question", ""]);
    expect(await takePendingOpen(undefined)).toBeUndefined();
  });
});
