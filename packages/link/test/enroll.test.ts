// P12: a new device is enrolled with the code it shows, typed on the
// computer. The code is a SPAKE2 password and each side signs the PAKE
// transcript, so a relay without the code can play neither side.
import { describe, expect, it, vi } from "vitest";
import {
  type CodeRequest,
  type EnrollHandler,
  enrollAsCore,
  enrollAsDevice,
  formatEnrollCode,
  generateIdentity,
  type Identity,
  mailboxOf,
  newEnrollCode,
  type PairedDevice,
  parseEnrollCode,
  wirePair,
} from "../src/browser.ts";

// SPAKE2 point math in plain BigInt is slow on a loaded CI runner.
vi.setConfig({ testTimeout: 20_000 });

const PHONE = { name: "iPhone", kind: "phone" as const, platform: "iOS 18.1 · Safari" };

/** A computer whose person types `typed[i]` on try i (then nothing); a function reads the phone's current code. */
function handler(
  typed: Array<string | (() => string)>,
  log: { asks: CodeRequest[]; stored: PairedDevice[]; ended: unknown[] },
) {
  return {
    askCode: async (r) => {
      log.asks.push(r);
      const c = typed[r.attempt - 1];
      if (c === undefined) return new Promise<string>(() => undefined);
      return typeof c === "function" ? c() : c;
    },
    accept: async (d) => {
      log.stored.push(d);
      return { deviceId: "dev_1", scopes: ["chat", "approve"] };
    },
    end: (r) => log.ended.push(r),
  } satisfies EnrollHandler;
}

const newLog = () => ({ asks: [] as CodeRequest[], stored: [] as PairedDevice[], ended: [] as unknown[] });

async function pair(o: {
  code: string;
  typed: Array<string | ((shown: () => string) => string)>;
  core?: Identity;
  maxTries?: number;
  ttlMs?: number;
  deviceTtlMs?: number;
}) {
  const core = o.core ?? (await generateIdentity(true));
  const phone = await generateIdentity();
  const mailbox = await mailboxOf(core.publicRaw);
  const [d, c] = wirePair();
  const log = newLog();
  const wrong: number[] = [];
  const shownCodes = [o.code];
  const shown = () => shownCodes[shownCodes.length - 1] as string;
  const typed = o.typed.map((t) => (typeof t === "function" ? () => t(shown) : t));
  const [dev, host] = await Promise.allSettled([
    enrollAsDevice(d, {
      mailbox,
      identity: phone,
      device: PHONE,
      code: o.code,
      onWrong: (a) => {
        wrong.push(a.left);
        shownCodes.push(a.code);
      },
      ...(o.maxTries ? { maxTries: o.maxTries } : {}),
      ...((o.deviceTtlMs ?? o.ttlMs) ? { ttlMs: o.deviceTtlMs ?? o.ttlMs } : {}),
    }),
    enrollAsCore(c, {
      identity: core,
      mailbox,
      coreName: "小明的 Mac",
      handler: handler(typed, log),
      ...(o.maxTries ? { maxTries: o.maxTries } : {}),
      ...(o.ttlMs ? { ttlMs: o.ttlMs } : {}),
    }),
  ]);
  return { dev, host, log, wrong, core, phone, mailbox, shownCodes };
}

describe("enrollment with the phone's code (P12)", () => {
  it("codes are 6 uniform digits; typed forms parse", () => {
    for (let i = 0; i < 50; i++) expect(newEnrollCode()).toMatch(/^\d{6}$/);
    expect(formatEnrollCode("482913")).toBe("482 913");
    expect(parseEnrollCode(" 482 913 ")).toBe("482913");
    expect(parseEnrollCode("482-913")).toBe("482913");
    expect(parseEnrollCode("48291")).toBeUndefined();
  });

  it("the right code: both sides authenticated, the device stored with no other prompt", async () => {
    const code = newEnrollCode();
    const r = await pair({ code, typed: [code] });
    expect(r.dev.status).toBe("fulfilled");
    expect(r.host.status).toBe("fulfilled");
    if (r.dev.status !== "fulfilled" || r.host.status !== "fulfilled") return;
    expect(r.dev.value).toMatchObject({ deviceId: "dev_1", mailbox: r.mailbox, coreName: "小明的 Mac" });
    expect([...r.dev.value.corePublicRaw]).toEqual([...r.core.publicRaw]);
    expect([...r.host.value.publicRaw]).toEqual([...r.phone.publicRaw]);
    expect(r.log.asks).toHaveLength(1);
    expect(r.log.stored).toHaveLength(1);
    expect(r.log.ended).toEqual([expect.objectContaining({ ok: true })]);
  });

  it("a typo costs one try and spends the code: the phone shows a new one, which works", async () => {
    const code = "123456";
    const r = await pair({ code, typed: ["654321", (shown) => shown()] });
    expect(r.dev.status).toBe("fulfilled");
    expect(r.wrong).toEqual([4]);
    expect(r.shownCodes).toHaveLength(2);
    expect(r.shownCodes[1]).toMatch(/^\d{6}$/);
    expect(r.shownCodes[1]).not.toBe(code);
    expect(r.log.asks.map((a) => [a.attempt, a.left, a.wrong])).toEqual([
      [1, 5, false],
      [2, 4, true],
    ]);
  });

  it("five wrong codes lock it: both sides give up with wrong_code and nothing is stored", async () => {
    const r = await pair({
      code: "111111",
      typed: ["000001", "000002", "000003", "000004", "000005", "111111"],
    });
    expect(r.dev).toMatchObject({ status: "rejected", reason: { code: "wrong_code" } });
    expect(r.host).toMatchObject({ status: "rejected", reason: { code: "wrong_code" } });
    expect(r.log.asks).toHaveLength(5); // the 6th (right) code is never asked for
    expect(r.wrong).toEqual([4, 3, 2, 1]);
    expect(r.log.stored).toHaveLength(0);
  });

  it("a code expires: the sheet stops waiting and the phone hears expired", async () => {
    const r = await pair({ code: "222222", typed: [], ttlMs: 300, deviceTtlMs: 2000 });
    expect(r.host).toMatchObject({ status: "rejected", reason: { code: "expired" } });
    expect(r.dev).toMatchObject({ status: "rejected", reason: { code: "expired" } });
    expect(r.log.stored).toHaveLength(0);
  });

  it("a relay in the middle without the code fails on both sides (it can only guess)", async () => {
    const core = await generateIdentity(true);
    const relayKey = await generateIdentity(true);
    const phone = await generateIdentity();
    const code = "424242";
    const realMailbox = await mailboxOf(core.publicRaw);
    const relayMailbox = await mailboxOf(relayKey.publicRaw);
    const [devSide, relayToDev] = wirePair();
    const [relayToCore, coreSide] = wirePair();
    const guesses = ["000000", "999999"];
    const relayLog = newLog();
    const coreLog = newLog();
    const results = await Promise.allSettled([
      // The phone, told by the lying relay that the computer is the relay's own mailbox.
      enrollAsDevice(devSide, { mailbox: relayMailbox, identity: phone, device: PHONE, code, maxTries: 2 }),
      // The relay plays the computer to the phone with guessed codes…
      enrollAsCore(relayToDev, {
        identity: relayKey,
        mailbox: relayMailbox,
        coreName: "假的",
        handler: handler(guesses, relayLog),
        maxTries: 2,
      }),
      // …and the phone to the computer, where the person types the real code.
      enrollAsDevice(relayToCore, {
        mailbox: realMailbox,
        identity: relayKey,
        device: PHONE,
        code: "000000",
        maxTries: 2,
      }),
      enrollAsCore(coreSide, {
        identity: core,
        mailbox: realMailbox,
        coreName: "真的",
        handler: handler([code, code], coreLog),
        maxTries: 2,
      }),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "wrong_code" } });
    expect(results[3]).toMatchObject({ status: "rejected", reason: { code: "wrong_code" } });
    expect(relayLog.stored).toHaveLength(0); // the relay never got the phone's key accepted
    expect(coreLog.stored).toHaveLength(0); // nor its own key onto the real computer
  });

  it("a relay that swaps the PAKE share or the computer's key is caught", async () => {
    // Share swapped in transit: the computer cannot open the phone's frame (counts as a wrong code).
    const core = await generateIdentity(true);
    const mailbox = await mailboxOf(core.publicRaw);
    const [d, relayD] = wirePair();
    const [relayC, c] = wirePair();
    const swap = (v: unknown) =>
      typeof v === "string"
        ? v.replace(/^(.{4})(.)/, (_x, a: string, b: string) => a + (b === "A" ? "B" : "A"))
        : v;
    const flip = (m: Record<string, unknown>) => {
      // Another point in the share (off-curve or a different point: either way refused).
      if (m.t === "enroll1") return { ...m, share2: swap(m.share2) };
      return m;
    };
    void (async () => {
      for (;;) relayC.send(flip(await relayD.recv(10_000)));
    })().catch(() => relayC.close());
    void (async () => {
      for (;;) relayD.send(await relayC.recv(10_000));
    })().catch(() => relayD.close());
    const log = newLog();
    const [dev, host] = await Promise.allSettled([
      enrollAsDevice(d, {
        mailbox,
        identity: await generateIdentity(),
        device: PHONE,
        code: "135790",
        maxTries: 1,
      }),
      enrollAsCore(c, {
        identity: core,
        mailbox,
        coreName: "x",
        handler: handler(["135790"], log),
        maxTries: 1,
      }),
    ]);
    expect(dev.status).toBe("rejected");
    expect(host.status).toBe("rejected");
    expect(log.stored).toHaveLength(0);

    // A computer whose key does not own the listed mailbox is refused by the phone.
    const listed = await generateIdentity(true);
    const r = await pair({ code: "246810", typed: ["246810"], core: listed });
    expect(r.dev.status).toBe("fulfilled");
    const other = await generateIdentity(true);
    const [d2, c2] = wirePair();
    const code = "112233";
    const [dev2] = await Promise.allSettled([
      enrollAsDevice(d2, {
        mailbox: await mailboxOf(listed.publicRaw),
        identity: await generateIdentity(),
        device: PHONE,
        code,
      }),
      enrollAsCore(c2, {
        identity: other,
        mailbox: await mailboxOf(listed.publicRaw),
        coreName: "假的",
        handler: handler([code], newLog()),
      }),
    ]);
    expect(dev2).toMatchObject({ status: "rejected", reason: { code: "fingerprint_mismatch" } });
  });
});
