import { describe, expect, it } from "vitest";
import { fromB64u, toB64u, utf8 } from "../src/bytes.ts";
import { deriveChannelKeys, SecureChannel } from "../src/channel.ts";
import { LinkError } from "../src/errors.ts";
import {
  formatCode,
  newSecret,
  type PairingCode,
  pairAsCore,
  pairAsDevice,
  parseCode,
  sessionAsCore,
  sessionAsDevice,
} from "../src/handshake.ts";
import { fingerprint, generateIdentity, mailboxOf } from "../src/identity.ts";
import { pakeAad, passwordScalarV2, spake2Finish, spake2Start } from "../src/spake2.ts";
import { wirePair } from "../src/wire.ts";

const code: PairingCode = { nameplate: "381", secret: "204957" };
const device = { name: "測試手機", kind: "phone" as const, platform: "test" };

async function pair(coreCode: PairingCode, deviceCode: PairingCode, expectFingerprint?: string) {
  const core = await generateIdentity(true);
  const phone = await generateIdentity();
  const mailbox = await mailboxOf(core.publicRaw);
  const [a, b] = wirePair();
  const coreSide = pairAsCore(a, {
    code: coreCode,
    identity: core,
    coreName: "桌機",
    accept: async () => ({ deviceId: "dev_1", scopes: ["chat"], mailbox }),
  });
  const phoneSide = pairAsDevice(b, {
    code: deviceCode,
    identity: phone,
    device,
    ...(expectFingerprint ? { expectFingerprint } : {}),
  });
  const [c, p] = await Promise.allSettled([coreSide, phoneSide]);
  return { core, phone, mailbox, c, p };
}

async function channels() {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const core = await SecureChannel.create(await deriveChannelKeys(secret, salt, "t", "core"));
  const dev = await SecureChannel.create(await deriveChannelKeys(secret, salt, "t", "device"));
  return { core, dev };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof LinkError ? e.code : String(e);
  }
};

describe("SPAKE2 (v2) + codes", () => {
  it("same code → both sides confirm; another code or another nameplate → confirmation fails", async () => {
    const run = async (a: string, ctxA: string, b: string, ctxB: string) => {
      const sa = spake2Start("A", await passwordScalarV2(a, ctxA));
      const sb = spake2Start("B", await passwordScalarV2(b, ctxB));
      const aad = pakeAad({ purpose: "pair", context: "381", offered: [2], chosen: 2 });
      const ra = await spake2Finish(sa, sb.share, aad);
      const rb = await spake2Finish(sb, sa.share, aad);
      return (await rb.verifyPeer(ra.confirm)) && (await ra.verifyPeer(rb.confirm));
    };
    expect(await run("123456", "pair|381", "123456", "pair|381")).toBe(true);
    expect(await run("123456", "pair|381", "123457", "pair|381")).toBe(false);
    // Same digits under another nameplate is another password.
    expect(await run("123456", "pair|381", "123456", "pair|382")).toBe(false);
  });

  it("codes parse in several spellings and secrets are 6 digits", () => {
    expect(parseCode("381-204-957")).toEqual(code);
    expect(parseCode("381 204957")).toEqual(code);
    expect(parseCode("4821204957")).toEqual({ nameplate: "4821", secret: "204957" });
    expect(formatCode(code)).toBe("381-204-957");
    expect(() => parseCode("12345")).toThrow(LinkError);
    for (let i = 0; i < 50; i++) expect(newSecret()).toMatch(/^\d{6}$/);
  });
});

describe("pairing", () => {
  it("the right code pairs and pins both identity keys", async () => {
    const r = await pair(code, code);
    expect(r.c.status).toBe("fulfilled");
    expect(r.p.status).toBe("fulfilled");
    if (r.p.status !== "fulfilled" || r.c.status !== "fulfilled") return;
    expect(r.p.value.deviceId).toBe("dev_1");
    expect(r.p.value.mailbox).toBe(r.mailbox);
    expect(toB64u(r.p.value.corePublicRaw)).toBe(toB64u(r.core.publicRaw));
    expect(r.c.value.fingerprint).toBe(await fingerprint(r.phone.publicRaw));
    expect(r.c.value.name).toBe("測試手機");
  });

  it("a wrong code fails on both sides", async () => {
    const r = await pair(code, { nameplate: "381", secret: "204958" });
    expect(r.p.status).toBe("rejected");
    expect(r.c.status).toBe("rejected");
    if (r.p.status === "rejected") expect((r.p.reason as LinkError).code).toBe("wrong_code");
    if (r.c.status === "rejected") expect((r.c.reason as LinkError).code).toBe("wrong_code");
  });

  it("a QR fingerprint that does not match the core's key is refused", async () => {
    const r = await pair(code, code, "A".repeat(43));
    expect(r.p.status).toBe("rejected");
    if (r.p.status === "rejected") expect((r.p.reason as LinkError).code).toBe("fingerprint_mismatch");
  });

  it("a man in the middle who swaps shares without the code cannot finish (v2: it never sees a sealed frame)", async () => {
    // The relay replaces the phone's share with its own (guessing a code it does not know).
    const core = await generateIdentity(true);
    const [a, mitmCore] = wirePair();
    const coreSide = pairAsCore(a, {
      code,
      identity: core,
      coreName: "桌機",
      accept: async () => ({ deviceId: "dev_x", scopes: [], mailbox: "m" }),
    });
    const guess = spake2Start("A", await passwordScalarV2("000000", "pair|381"));
    mitmCore.send({ t: "pair1", v: 1, pk: [2], share2: toB64u(guess.share) });
    const p2 = await mitmCore.recv();
    expect(p2).toMatchObject({ t: "pair2", pk: 2 });
    // It must commit to cA for its own guess; the core checks it before anything is sealed.
    const r = await spake2Finish(
      guess,
      fromB64u(String(p2.share)),
      pakeAad({ purpose: "pair", context: "381", offered: [2], chosen: 2 }),
    );
    mitmCore.send({ t: "pair3", c: toB64u(r.confirm) });
    expect(await mitmCore.recv()).toMatchObject({ t: "fail", code: "wrong_code" });
    expect(await codeOf(coreSide)).toBe("wrong_code");
  });
});

describe("session", () => {
  async function setup(revoked = false) {
    const core = await generateIdentity(true);
    const phone = await generateIdentity();
    const mailbox = await mailboxOf(core.publicRaw);
    const [a, b] = wirePair();
    const coreSide = sessionAsCore(a, {
      identity: core,
      mailbox,
      lookup: (id) => (id !== "dev_1" ? undefined : revoked ? "revoked" : { publicRaw: phone.publicRaw }),
    }).then(async (s) => {
      a.send({ t: "f", d: await s.channel.seal({ k: "ready" }) });
      return s;
    });
    coreSide.catch(() => undefined);
    return { core, phone, mailbox, a, b, coreSide };
  }

  it("authenticates both ends and carries sealed messages", async () => {
    const s = await setup();
    const dev = await sessionAsDevice(s.b, {
      deviceId: "dev_1",
      identity: s.phone,
      corePublicRaw: s.core.publicRaw,
      mailbox: s.mailbox,
    });
    const c = await s.coreSide;
    expect(c.deviceId).toBe("dev_1");
    expect(dev.ready.k).toBe("ready");
    const f = await dev.channel.seal({ hello: "你好" });
    expect(await c.channel.open(f)).toEqual({ hello: "你好" });
  });

  it("a revoked device is rejected", async () => {
    const s = await setup(true);
    const r = sessionAsDevice(s.b, {
      deviceId: "dev_1",
      identity: s.phone,
      corePublicRaw: s.core.publicRaw,
      mailbox: s.mailbox,
    });
    expect(await codeOf(r)).toBe("revoked");
    expect(await codeOf(s.coreSide)).toBe("revoked");
  });

  it("an unknown device is rejected", async () => {
    const s = await setup();
    const r = sessionAsDevice(s.b, {
      deviceId: "dev_2",
      identity: s.phone,
      corePublicRaw: s.core.publicRaw,
      mailbox: s.mailbox,
    });
    expect(await codeOf(r)).toBe("unknown_device");
  });

  it("a device signing with another key is rejected", async () => {
    const s = await setup();
    const other = await generateIdentity();
    const r = sessionAsDevice(s.b, {
      deviceId: "dev_1",
      identity: other,
      corePublicRaw: s.core.publicRaw,
      mailbox: s.mailbox,
    });
    expect(await codeOf(s.coreSide)).toBe("bad_signature");
    expect(await codeOf(r)).not.toBe("ok");
  });

  it("an impostor core (wrong key) is rejected by the device", async () => {
    const s = await setup();
    const pinned = await generateIdentity();
    const r = sessionAsDevice(s.b, {
      deviceId: "dev_1",
      identity: s.phone,
      corePublicRaw: pinned.publicRaw,
      mailbox: s.mailbox,
    });
    expect(await codeOf(r)).toBe("bad_signature");
  });
});

describe("sealed frames", () => {
  it("round-trip in order, both directions", async () => {
    const { core, dev } = await channels();
    const frames = await Promise.all([1, 2, 3].map((n) => dev.seal({ n })));
    expect(await Promise.all(frames.map((f) => core.open(f)))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(await dev.open(await core.seal("back"))).toBe("back");
  });

  it("tampered ciphertext fails and breaks the channel", async () => {
    const { core, dev } = await channels();
    const raw = fromB64u(await dev.seal({ amount: 100 }));
    raw[raw.length - 20] = (raw[raw.length - 20] as number) ^ 1;
    await expect(core.open(toB64u(raw))).rejects.toMatchObject({ code: "tampered" });
    await expect(core.open(await dev.seal({ amount: 1 }))).rejects.toMatchObject({ code: "tampered" });
  });

  it("a tampered header (counter) fails authentication", async () => {
    const { core, dev } = await channels();
    await core.open(await dev.seal(0));
    const raw = fromB64u(await dev.seal(1));
    const forged = fromB64u(await dev.seal(2));
    forged.set(raw.subarray(9), 9); // frame 2's header, frame 1's body
    await expect(core.open(toB64u(forged.subarray(0, raw.length)))).rejects.toMatchObject({
      code: "out_of_order",
    });
  });

  it("a replayed frame is rejected", async () => {
    const { core, dev } = await channels();
    const f = await dev.seal({ approve: "apr_1" });
    await core.open(f);
    await expect(core.open(f)).rejects.toMatchObject({ code: "replay" });
  });

  it("a dropped or reordered frame is rejected", async () => {
    const { core, dev } = await channels();
    const f0 = await dev.seal(0);
    const f1 = await dev.seal(1);
    await expect(core.open(f1)).rejects.toMatchObject({ code: "out_of_order" });
    await expect(core.open(f0)).rejects.toBeInstanceOf(LinkError);
  });

  it("frames from another session do not open", async () => {
    const a = await channels();
    const b = await channels();
    await expect(b.core.open(await a.dev.seal("x"))).rejects.toMatchObject({ code: "tampered" });
  });

  it("garbage is malformed, not a crash", async () => {
    const { core } = await channels();
    await expect(core.open("!!")).rejects.toMatchObject({ code: "malformed" });
    const c2 = (await channels()).core;
    await expect(c2.open(toB64u(utf8("short")))).rejects.toMatchObject({ code: "malformed" });
  });
});
