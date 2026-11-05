// G1 at the protocol level: message order against an active attacker, what a
// wrong code costs, tampering in transit, and — since PAKE v1 was removed — that
// every v1-shaped pairing / enrollment is refused (upgrade_required, nothing
// stored) while a phone paired before G1 still reconnects (sessions never ran a PAKE).
import { describe, expect, it, vi } from "vitest";
import { fromB64u, toB64u } from "../src/bytes.ts";
import { deriveChannelKeys, SecureChannel } from "../src/channel.ts";
import { enrollAsCore, enrollAsDevice } from "../src/enroll.ts";
import { LinkError } from "../src/errors.ts";
import {
  LINK_VERSION,
  type PairingCode,
  pairAsCore,
  pairAsDevice,
  sessionAsCore,
  sessionAsDevice,
} from "../src/handshake.ts";
import { generateIdentity, mailboxOf } from "../src/identity.ts";
import { pakeAad, passwordScalarV2, spake2Finish, spake2Start } from "../src/spake2.ts";
import { type QueueWire, type WireMessage, wirePair } from "../src/wire.ts";
import * as v1e from "./fixtures/v1/enroll.ts";
import * as v1 from "./fixtures/v1/handshake.ts";

vi.setConfig({ testTimeout: 30_000 });

const CODE: PairingCode = { nameplate: "381", secret: "204957" };
const DEVICE = { name: "iPhone", kind: "phone" as const, platform: "t" };
/** A sample of codes an offline attacker would try, the real one included. */
const CANDIDATES = [CODE.secret, ...Array.from({ length: 150 }, (_, i) => String(100000 + i * 5333))];

const settle = async (p: Promise<unknown>) => {
  try {
    return { ok: true as const, v: await p };
  } catch (e) {
    return { ok: false as const, code: e instanceof LinkError ? e.code : String(e) };
  }
};

async function honestCore(wire: QueueWire) {
  const id = await generateIdentity(true);
  return pairAsCore(wire, {
    code: CODE,
    identity: id,
    coreName: "Mac",
    accept: async () => ({ deviceId: "dev_1", scopes: ["chat"], mailbox: "mb" }),
  });
}

describe("v2: nothing keyed by the PAKE leaves before the peer proved the code", () => {
  it("a fake phone (or relay) without the code gets only pB, then fail — no sealed frame", async () => {
    const [atk, core] = wirePair();
    const done = settle(honestCore(core));
    const guess = "000000";
    const st = spake2Start("A", await passwordScalarV2(guess, `pair|${CODE.nameplate}`));
    atk.send({ t: "pair1", v: LINK_VERSION, pk: [2], share2: toB64u(st.share) });
    const got: WireMessage[] = [await atk.recv()];
    expect(got[0]).toMatchObject({ t: "pair2", pk: 2 });
    expect(Object.keys(got[0] as object).sort()).toEqual(["pk", "share", "t"]);
    expect(fromB64u(String(got[0]?.share))).toHaveLength(65); // a public point only
    // The attacker must commit to cA without the code: it can only use its own guess.
    const r = await spake2Finish(
      st,
      fromB64u(String(got[0]?.share)),
      pakeAad({ purpose: "pair", context: CODE.nameplate, offered: [2], chosen: 2 }),
    );
    atk.send({ t: "pair3", c: toB64u(r.confirm) });
    got.push(await atk.recv());
    expect(got[1]).toMatchObject({ t: "fail", code: "wrong_code" });
    expect(got.some((m) => m.t === "f")).toBe(false);
    expect(await done).toMatchObject({ ok: false, code: "wrong_code" });
  });

  it("a fake computer playing B gets cA, but cA confirms only the one guess it committed to (no offline test)", async () => {
    const [dev, atk] = wirePair();
    const phone = settle(
      pairAsDevice(dev, {
        code: CODE,
        identity: await generateIdentity(),
        device: DEVICE,
      }),
    );
    const p1 = await atk.recv();
    expect(p1).toMatchObject({ t: "pair1", pk: [2] });
    expect(p1.share).toBeUndefined(); // v2 only: no v1 share at all
    const ctx = `pair|${CODE.nameplate}`;
    const st = spake2Start("B", await passwordScalarV2("999999", ctx)); // committed guess
    atk.send({ t: "pair2", pk: 2, share: toB64u(st.share) });
    const p3 = await atk.recv();
    expect(p3.t).toBe("pair3");
    const cA = fromB64u(String(p3.c));
    const aad = pakeAad({ purpose: "pair", context: CODE.nameplate, offered: [2], chosen: 2 });
    // Offline: for each candidate code, recompute everything B could and check cA.
    let hits = 0;
    for (const c of CANDIDATES) {
      const r = await spake2Finish(
        { ...st, w: await passwordScalarV2(c, ctx) },
        fromB64u(String(p1.share2)),
        aad,
      );
      if (await r.verifyPeer(cA)) hits++;
    }
    expect(hits).toBe(0); // not even the real code (CANDIDATES[0]) verifies
    atk.close("bye");
    expect((await phone).ok).toBe(false);
  });

  it("control: when the committed guess is the real code, cA verifies — that is the single online guess", async () => {
    const [dev, atk] = wirePair();
    const phone = settle(
      pairAsDevice(dev, {
        code: CODE,
        identity: await generateIdentity(),
        device: DEVICE,
      }),
    );
    const p1 = await atk.recv();
    const ctx = `pair|${CODE.nameplate}`;
    const st = spake2Start("B", await passwordScalarV2(CODE.secret, ctx));
    atk.send({ t: "pair2", pk: 2, share: toB64u(st.share) });
    const p3 = await atk.recv();
    const aad = pakeAad({ purpose: "pair", context: CODE.nameplate, offered: [2], chosen: 2 });
    const r = await spake2Finish(st, fromB64u(String(p1.share2)), aad);
    expect(await r.verifyPeer(fromB64u(String(p3.c)))).toBe(true);
    atk.close("bye");
    await phone;
  });

  it("enrollment: the phone sends nothing sealed before the computer's cB verified", async () => {
    const core = await generateIdentity(true);
    const mailbox = await mailboxOf(core.publicRaw);
    const [dev, atk] = wirePair();
    const phone = settle(
      enrollAsDevice(dev, {
        mailbox,
        identity: await generateIdentity(),
        device: DEVICE,
        code: "135790",
        maxTries: 1,
      }),
    );
    const m1 = await atk.recv();
    expect(m1).toMatchObject({ t: "enroll1", pk: [2] });
    expect(m1.share).toBeUndefined(); // v2 only: no v1 share at all
    const salt = `enroll|${mailbox}|${String(m1.n)}`;
    const st = spake2Start("B", await passwordScalarV2("000000", salt));
    atk.send({ t: "enroll2", pk: 2, share: toB64u(st.share) });
    const m3 = await atk.recv();
    expect(m3.t).toBe("enroll3");
    // A forged enroll.ok under keys the attacker could derive from its guess: refused, and still nothing sealed sent.
    const r = await spake2Finish(
      st,
      fromB64u(String(m1.share2)),
      pakeAad({ purpose: "enroll", context: salt, offered: [2], chosen: 2 }),
    );
    const ch = await SecureChannel.create(
      await deriveChannelKeys(r.ke, new Uint8Array(0), "alca-link/v2 enroll keys", "core"),
    );
    atk.send({ t: "f", d: await ch.seal({ k: "enroll.ok", c: toB64u(r.confirm) }) });
    // The phone stops (a fail or just closing), never a sealed enroll.device.
    const after = await settle(atk.recv());
    if (after.ok) expect((after.v as WireMessage).t).toBe("fail");
    else expect(after.code).toBe("closed");
    expect(await phone).toMatchObject({ ok: false });
  });

  it("enrollment: a fake phone without the code gets only enroll2, then enroll.again — no sealed frame", async () => {
    const core = await generateIdentity(true);
    const mailbox = await mailboxOf(core.publicRaw);
    const [atk, c] = wirePair();
    const computer = settle(
      enrollAsCore(c, {
        identity: core,
        mailbox,
        coreName: "Mac",
        maxTries: 2,
        handler: { askCode: async () => "135790", accept: async () => ({ deviceId: "d", scopes: [] }) },
      }),
    );
    const n = toB64u(crypto.getRandomValues(new Uint8Array(16)));
    const salt = `enroll|${mailbox}|${n}`;
    const st = spake2Start("A", await passwordScalarV2("000000", salt));
    atk.send({ t: "enroll1", v: LINK_VERSION, n, pk: [2], share2: toB64u(st.share) });
    const m2 = await atk.recv();
    expect(Object.keys(m2).sort()).toEqual(["pk", "share", "t"]);
    const r = await spake2Finish(
      st,
      fromB64u(String(m2.share)),
      pakeAad({ purpose: "enroll", context: salt, offered: [2], chosen: 2 }),
    );
    atk.send({ t: "enroll3", c: toB64u(r.confirm) });
    expect(await atk.recv()).toMatchObject({ t: "enroll.again" });
    atk.close("bye");
    expect((await computer).ok).toBe(false);
  });
});

describe("the phone checks the computer's confirmation itself", () => {
  it("a sealed pair.core that opens but carries a wrong cB is refused before the phone sends its key", async () => {
    // Only a peer that knows the code can seal under Ke; this checks cB is verified, not just the AEAD tag.
    const [dev, atk] = wirePair();
    const phone = settle(
      pairAsDevice(dev, {
        code: CODE,
        identity: await generateIdentity(),
        device: DEVICE,
      }),
    );
    const p1 = await atk.recv();
    const ctx = `pair|${CODE.nameplate}`;
    const st = spake2Start("B", await passwordScalarV2(CODE.secret, ctx));
    atk.send({ t: "pair2", pk: 2, share: toB64u(st.share) });
    await atk.recv(); // pair3
    const r = await spake2Finish(
      st,
      fromB64u(String(p1.share2)),
      pakeAad({ purpose: "pair", context: CODE.nameplate, offered: [2], chosen: 2 }),
    );
    const ch = await SecureChannel.create(
      await deriveChannelKeys(r.ke, new Uint8Array(0), "alca-link/v2 pair keys", "core"),
    );
    const id = await generateIdentity(true);
    const bad = new Uint8Array(r.confirm);
    bad[0] = (bad[0] as number) ^ 1;
    atk.send({
      t: "f",
      d: await ch.seal({ k: "pair.core", pub: toB64u(id.publicRaw), sig: "AA", name: "x", c: toB64u(bad) }),
    });
    const next = await settle(atk.recv());
    if (next.ok) expect((next.v as WireMessage).t).toBe("fail");
    expect(await phone).toMatchObject({ ok: false, code: "wrong_code" });
  });
});

describe("tampering in transit fails confirmation", () => {
  /** Phone ↔ relay ↔ core, the relay rewriting messages with `edit`. */
  async function viaRelay(edit: (m: WireMessage, toCore: boolean) => WireMessage) {
    const [d, rd] = wirePair();
    const [rc, c] = wirePair();
    void (async () => {
      for (;;) rc.send(edit(await rd.recv(10_000), true));
    })().catch(() => rc.close());
    void (async () => {
      for (;;) rd.send(edit(await rc.recv(10_000), false));
    })().catch(() => rd.close());
    const [phone, core] = await Promise.all([
      settle(pairAsDevice(d, { code: CODE, identity: await generateIdentity(), device: DEVICE })),
      settle(honestCore(c)),
    ]);
    return { phone, core };
  }
  const other = async (role: "A" | "B") =>
    toB64u(spake2Start(role, await passwordScalarV2(CODE.secret, `pair|${CODE.nameplate}`)).share);

  it("untouched: v2 pairs", async () => {
    const r = await viaRelay((m) => m);
    expect(r.phone).toMatchObject({ ok: true, v: { pake: 2 } });
  });

  it("the offered version list (pk) rewritten → wrong_code, nothing stored", async () => {
    const r = await viaRelay((m, toCore) => (toCore && m.t === "pair1" ? { ...m, pk: [2, 1, 3] } : m));
    expect(r.core).toMatchObject({ ok: false, code: "wrong_code" });
    expect(r.phone.ok).toBe(false);
  });

  it("pA (share2) or pB swapped for another valid point → wrong_code", async () => {
    const a = await other("A");
    const b = await other("B");
    const r1 = await viaRelay((m, toCore) => (toCore && m.t === "pair1" ? { ...m, share2: a } : m));
    expect(r1.core).toMatchObject({ ok: false, code: "wrong_code" });
    const r2 = await viaRelay((m, toCore) => (!toCore && m.t === "pair2" ? { ...m, share: b } : m));
    expect(r2.core).toMatchObject({ ok: false, code: "wrong_code" });
  });

  it("cA bit-flipped → wrong_code; the sealed frame carrying cB altered → the phone stops before sending its key", async () => {
    const flip = (s: unknown) => {
      const b = fromB64u(String(s));
      b[0] = (b[0] as number) ^ 1;
      return toB64u(b);
    };
    const r1 = await viaRelay((m, toCore) => (toCore && m.t === "pair3" ? { ...m, c: flip(m.c) } : m));
    expect(r1.core).toMatchObject({ ok: false, code: "wrong_code" });
    const r2 = await viaRelay((m, toCore) => (!toCore && m.t === "f" ? { ...m, d: flip(m.d) } : m));
    expect(r2.phone.ok).toBe(false);
    expect(r2.core.ok).toBe(false);
  });

  it("stripping v2 in transit (pk and share2 removed) → the core refuses upgrade_required; nothing runs v1", async () => {
    const [d, rd] = wirePair();
    const [rc, c] = wirePair();
    void (async () => {
      for (;;) {
        const m = await rd.recv(10_000);
        const { pk: _pk, share2: _s, ...rest } = m;
        rc.send(rest);
      }
    })().catch(() => rc.close());
    void (async () => {
      for (;;) rd.send(await rc.recv(10_000));
    })().catch(() => rd.close());
    const [phone, core] = await Promise.all([
      settle(pairAsDevice(d, { code: CODE, identity: await generateIdentity(), device: DEVICE })),
      settle(honestCore(c)),
    ]);
    expect(phone.ok).toBe(false);
    expect(core).toMatchObject({ ok: false, code: "upgrade_required" });
  });
});

describe("PAKE v1 is removed: every v1-shaped first message is refused before any PAKE", () => {
  const v1Share = async () => toB64u(spake2Start("A", 7n).share); // any valid point: the core never looks at it
  const pair1Shapes = async () => {
    const share = await v1Share();
    const share2 = toB64u(
      spake2Start("A", await passwordScalarV2(CODE.secret, `pair|${CODE.nameplate}`)).share,
    );
    return [
      { name: "pre-G1 page: share only, no pk", m: { t: "pair1", v: LINK_VERSION, share } },
      { name: "pk [1]", m: { t: "pair1", v: LINK_VERSION, pk: [1], share } },
      { name: "pk [1] with a v2 share", m: { t: "pair1", v: LINK_VERSION, pk: [1], share, share2 } },
      { name: "pk as a string", m: { t: "pair1", v: LINK_VERSION, pk: "2", share, share2 } },
      { name: "pk empty", m: { t: "pair1", v: LINK_VERSION, pk: [], share2 } },
    ];
  };

  it("pairing: the core answers fail upgrade_required (with the update message), sends no pair2, stores nothing", async () => {
    for (const { name, m } of await pair1Shapes()) {
      const [atk, core] = wirePair();
      const accepted: string[] = [];
      const pakes: number[] = [];
      const done = settle(
        pairAsCore(core, {
          code: CODE,
          identity: await generateIdentity(true),
          coreName: "Mac",
          onPake: (v) => pakes.push(v),
          accept: async (dev) => {
            accepted.push(dev.name);
            return { deviceId: "d", scopes: [], mailbox: "m" };
          },
        }),
      );
      atk.send(m as WireMessage);
      const first = await atk.recv();
      expect(first, name).toMatchObject({ t: "fail", code: "upgrade_required" });
      expect(String(first.message), name).toMatch(/update .*pair again/);
      expect(await done, name).toMatchObject({ ok: false, code: "upgrade_required" });
      expect(accepted, name).toEqual([]);
      expect(pakes, name).toEqual([]); // no PAKE version was ever chosen
    }
  });

  it("enrollment: the core answers fail upgrade_required before it asks for the code, stores nothing", async () => {
    const coreId = await generateIdentity(true);
    const mailbox = await mailboxOf(coreId.publicRaw);
    for (const pk of [undefined, [1], "2", []]) {
      const [atk, c] = wirePair();
      const asks: number[] = [];
      const stored: string[] = [];
      const computer = settle(
        enrollAsCore(c, {
          identity: coreId,
          mailbox,
          coreName: "Mac",
          handler: {
            askCode: async (r) => {
              asks.push(r.attempt);
              return "135790";
            },
            accept: async (d) => {
              stored.push(d.name);
              return { deviceId: "d", scopes: [] };
            },
          },
        }),
      );
      const n = toB64u(crypto.getRandomValues(new Uint8Array(16)));
      atk.send({
        t: "enroll1",
        v: LINK_VERSION,
        n,
        share: await v1Share(),
        ...(pk === undefined ? {} : { pk }),
      });
      expect(await atk.recv()).toMatchObject({ t: "fail", code: "upgrade_required" });
      expect(await computer).toMatchObject({ ok: false, code: "upgrade_required" });
      expect(asks).toEqual([]);
      expect(stored).toEqual([]);
    }
  });

  it("the frozen pre-G1 phone (fixture) against the new core: pairing and enrollment → upgrade_required", async () => {
    const [a, b] = wirePair();
    const [d, c] = await Promise.all([
      settle(v1.pairAsDevice(b, { code: CODE, identity: await generateIdentity(), device: DEVICE })),
      settle(honestCore(a)),
    ]);
    expect([d.ok ? "" : d.code, c.ok ? "" : c.code]).toContain("upgrade_required");
    expect(c.ok).toBe(false);
    const coreId = await generateIdentity(true);
    const mailbox = await mailboxOf(coreId.publicRaw);
    const [x, y] = wirePair();
    const handler = {
      askCode: async () => "482913",
      accept: async () => ({ deviceId: "d", scopes: ["chat"] }),
    };
    const [ed, ec] = await Promise.all([
      settle(
        v1e.enrollAsDevice(y, {
          mailbox,
          identity: await generateIdentity(),
          device: DEVICE,
          code: "482913",
        }),
      ),
      settle(enrollAsCore(x, { identity: coreId, mailbox, coreName: "Mac", handler })),
    ]);
    expect([ed.ok ? "" : ed.code, ec.ok ? "" : ec.code]).toContain("upgrade_required");
    expect(ec.ok).toBe(false);
  });

  it("the new phone against a frozen pre-G1 computer (fixture): it stops with downgrade, sends no v1 share", async () => {
    const [a, b] = wirePair();
    const sent: WireMessage[] = [];
    const send = b.send.bind(b);
    b.send = (m: WireMessage) => {
      sent.push(m);
      send(m);
    };
    const accept = async () => ({ deviceId: "d", scopes: ["chat"], mailbox: "m" });
    const [d, c] = await Promise.all([
      settle(pairAsDevice(b, { code: CODE, identity: await generateIdentity(), device: DEVICE })),
      settle(
        v1.pairAsCore(a, { code: CODE, identity: await generateIdentity(true), coreName: "Mac", accept }),
      ),
    ]);
    expect(d).toMatchObject({ ok: false, code: "downgrade" });
    expect(c.ok).toBe(false);
    expect(sent[0]).toMatchObject({ t: "pair1", pk: [2] });
    expect(sent[0]?.share).toBeUndefined();
    const coreId = await generateIdentity(true);
    const mailbox = await mailboxOf(coreId.publicRaw);
    const [x, y] = wirePair();
    const handler = {
      askCode: async () => "482913",
      accept: async () => ({ deviceId: "d", scopes: ["chat"] }),
    };
    const [ed] = await Promise.all([
      settle(
        enrollAsDevice(y, { mailbox, identity: await generateIdentity(), device: DEVICE, code: "482913" }),
      ),
      settle(v1e.enrollAsCore(x, { identity: coreId, mailbox, coreName: "Mac", handler })),
    ]);
    expect(ed.ok).toBe(false);
  });

  it("current phone × current core: pairing and enrollment run v2", async () => {
    const [a, b] = wirePair();
    const [d, c] = await Promise.all([
      settle(pairAsDevice(b, { code: CODE, identity: await generateIdentity(), device: DEVICE })),
      settle(honestCore(a)),
    ]);
    expect(d).toMatchObject({ ok: true, v: { pake: 2 } });
    expect(c).toMatchObject({ ok: true, v: { pake: 2 } });
    const coreId = await generateIdentity(true);
    const mailbox = await mailboxOf(coreId.publicRaw);
    const [x, y] = wirePair();
    const handler = {
      askCode: async () => "482913",
      accept: async () => ({ deviceId: "d", scopes: ["chat"] }),
    };
    const [ed, ec] = await Promise.all([
      settle(
        enrollAsDevice(y, { mailbox, identity: await generateIdentity(), device: DEVICE, code: "482913" }),
      ),
      settle(enrollAsCore(x, { identity: coreId, mailbox, coreName: "Mac", handler })),
    ]);
    expect(ed).toMatchObject({ ok: true, v: { pake: 2 } });
    expect(ec).toMatchObject({ ok: true, v: { pake: 2 } });
  });
});

describe("a phone paired before G1 keeps working", () => {
  it("v1-paired phone (old code) reconnects to the new core: the session handshake is unchanged", async () => {
    expect(LINK_VERSION).toBe(1);
    expect(v1.LINK_VERSION).toBe(1);
    const coreId = await generateIdentity(true);
    const phoneId = await generateIdentity();
    const mailbox = await mailboxOf(coreId.publicRaw);
    // Paired the old way, on both ends.
    const [a, b] = wirePair();
    const [paired] = await Promise.all([
      v1.pairAsDevice(b, { code: CODE, identity: phoneId, device: DEVICE }),
      v1.pairAsCore(a, {
        code: CODE,
        identity: coreId,
        coreName: "Mac",
        accept: async () => ({ deviceId: "dev_9", scopes: ["chat"], mailbox }),
      }),
    ]);
    // Reconnect: the old phone's session code, then the new one, against the new core's.
    for (const phoneSide of [v1.sessionAsDevice, sessionAsDevice]) {
      const [x, y] = wirePair();
      const coreSession = sessionAsCore(x, {
        identity: coreId,
        mailbox,
        lookup: (id) => (id === "dev_9" ? { publicRaw: phoneId.publicRaw } : undefined),
      });
      const phoneSession = phoneSide(y, {
        deviceId: paired.deviceId,
        identity: phoneId,
        corePublicRaw: paired.corePublicRaw,
        mailbox,
      });
      const s = await coreSession;
      x.send({ t: "f", d: await s.channel.seal({ k: "ready" }) });
      const ph = await phoneSession;
      expect(ph.ready.k).toBe("ready");
      expect(s.deviceId).toBe("dev_9");
    }
  });
});
