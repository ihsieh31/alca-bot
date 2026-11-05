// PAKE v2 (src/spake2.ts): RFC 9382 Appendix B vectors verbatim, the RFC's
// M and N, and that confirmation fails when any transcript or AAD field moves.
import { createHmac, hkdfSync } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { describe, expect, it } from "vitest";
import { LinkError } from "../src/errors.ts";
import {
  choosePake,
  ID_CORE,
  ID_DEVICE,
  M,
  N,
  PAKE_SUPPORTED,
  PAKE_V2,
  pakeAad,
  parseShare,
  passwordScalarV2,
  spake2Finish,
  spake2Start,
  transcript,
} from "../src/spake2.ts";
import { RFC9382_VECTORS } from "./fixtures/rfc9382-vectors.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const big = (s: string) => BigInt(`0x${s}`);
const NIL = new Uint8Array(0);

describe("RFC 9382 Appendix B (SPAKE2-P256-SHA256-HKDF-HMAC)", () => {
  for (const v of RFC9382_VECTORS) {
    it(`A='${v.A}', B='${v.B}': pA, pB, K, TT, Ke, Ka, KcA, KcB, cA, cB all match`, async () => {
      const ids = { a: v.A, b: v.B };
      const a = spake2Start("A", big(v.w), ids, big(v.x));
      const b = spake2Start("B", big(v.w), ids, big(v.y));
      expect(hex(a.share)).toBe(v.pA);
      expect(hex(b.share)).toBe(v.pB);
      const ra = await spake2Finish(a, b.share, NIL);
      const rb = await spake2Finish(b, a.share, NIL);
      for (const r of [ra, rb]) {
        expect(hex(r.K)).toBe(v.K);
        expect(hex(r.tt)).toBe(v.TT);
        expect(hex(r.ke)).toBe(v.Ke);
        expect(hex(r.kcA)).toBe(v.KcA);
        expect(hex(r.kcB)).toBe(v.KcB);
      }
      expect(hex(ra.confirm)).toBe(v.cA);
      expect(hex(rb.confirm)).toBe(v.cB);
      expect(await rb.verifyPeer(ra.confirm)).toBe(true);
      expect(await ra.verifyPeer(rb.confirm)).toBe(true);
      // Ka is half of Hash(TT); cross-check the key schedule with node:crypto.
      const kc = Buffer.from(hkdfSync("sha256", unhex(v.Ka), NIL, Buffer.from("ConfirmationKeys"), 32));
      expect(kc.toString("hex")).toBe(v.KcA + v.KcB);
      expect(createHmac("sha256", kc.subarray(0, 16)).update(unhex(v.TT)).digest("hex")).toBe(v.cA);
    });
  }

  it("M and N are the RFC 9382 §6 points (compressed encodings), on the curve and distinct", () => {
    expect(hex(M.toBytes(true))).toBe("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f");
    expect(hex(N.toBytes(true))).toBe("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49");
    M.assertValidity();
    N.assertValidity();
    expect(M.equals(N)).toBe(false);
  });
});

describe("v2 confirmation binds the whole transcript and the AAD", () => {
  const aad = pakeAad({ purpose: "pair", context: "381", offered: [2, 1], chosen: 2 });

  async function run(o: {
    codeA?: string;
    codeB?: string;
    aadA?: Uint8Array;
    aadB?: Uint8Array;
    idsA?: { a: string; b: string };
    idsB?: { a: string; b: string };
    tamperA?: (s: Uint8Array) => Uint8Array;
    tamperB?: (s: Uint8Array) => Uint8Array;
  }) {
    const wA = await passwordScalarV2(o.codeA ?? "204957", "pair|381");
    const wB = await passwordScalarV2(o.codeB ?? "204957", "pair|381");
    const a = spake2Start("A", wA, o.idsA);
    const b = spake2Start("B", wB, o.idsB);
    const ra = await spake2Finish(a, o.tamperB ? o.tamperB(b.share) : b.share, o.aadA ?? aad);
    const rb = await spake2Finish(b, o.tamperA ? o.tamperA(a.share) : a.share, o.aadB ?? aad);
    return { aOk: await ra.verifyPeer(rb.confirm), bOk: await rb.verifyPeer(ra.confirm), ra, rb };
  }

  it("same code, same AAD: both confirmations verify and Ke agrees", async () => {
    const r = await run({});
    expect(r.aOk && r.bOk).toBe(true);
    expect(hex(r.ra.ke)).toBe(hex(r.rb.ke));
  });

  it("another code fails both confirmations", async () => {
    const r = await run({ codeB: "204958" });
    expect(r.aOk || r.bOk).toBe(false);
  });

  const variants: Array<[string, Parameters<typeof pakeAad>[0]]> = [
    ["purpose", { purpose: "enroll", context: "381", offered: [2, 1], chosen: 2 }],
    ["context (nameplate / salt)", { purpose: "pair", context: "382", offered: [2, 1], chosen: 2 }],
    [
      "offered version list (downgrade: v1 stripped)",
      { purpose: "pair", context: "381", offered: [2], chosen: 2 },
    ],
    ["chosen version", { purpose: "pair", context: "381", offered: [2, 1], chosen: 1 }],
  ];
  for (const [field, other] of variants)
    it(`AAD field "${field}" differs → confirmation fails on both sides`, async () => {
      const r = await run({ aadB: pakeAad(other) });
      expect(r.aOk).toBe(false);
      expect(r.bOk).toBe(false);
    });

  it("identity A or B differs → confirmation fails", async () => {
    for (const idsB of [
      { a: "someone else", b: ID_CORE },
      { a: ID_DEVICE, b: "someone else" },
    ]) {
      const r = await run({ idsB });
      expect(r.aOk || r.bOk).toBe(false);
    }
  });

  it("a share substituted in transit (pA or pB) → confirmation fails", async () => {
    const other = spake2Start("A", await passwordScalarV2("204957", "pair|381")).share;
    expect((await run({ tamperA: () => other })).bOk).toBe(false);
    const otherB = spake2Start("B", await passwordScalarV2("204957", "pair|381")).share;
    expect((await run({ tamperB: () => otherB })).aOk).toBe(false);
  });

  it("every TT field is committed: changing idA, idB, pA, pB, K or w changes TT", () => {
    const g = p256.Point.BASE.toBytes(false);
    const base = { idA: ID_DEVICE, idB: ID_CORE, pA: g, pB: g, K: g, w: 5n };
    const tt = hex(transcript(base));
    const g2 = p256.Point.BASE.double().toBytes(false);
    const changes = [
      { idA: "x" },
      { idB: "x" },
      { pA: g2 },
      { pB: g2 },
      { K: g2 },
      { w: 6n },
      // Moving bytes between fields must not collide either (length prefixes).
      { idA: `${ID_DEVICE}a`, idB: ID_CORE.slice(1) },
    ];
    for (const c of changes) expect(hex(transcript({ ...base, ...c }))).not.toBe(tt);
  });

  it("a forged confirmation (wrong length, flipped bit, the peer's own MAC reflected) is refused", async () => {
    const r = await run({});
    const flipped = new Uint8Array(r.ra.confirm);
    flipped[0] = (flipped[0] as number) ^ 1;
    expect(await r.rb.verifyPeer(flipped)).toBe(false);
    expect(await r.rb.verifyPeer(r.ra.confirm.subarray(0, 31))).toBe(false);
    expect(await r.rb.verifyPeer(r.rb.confirm)).toBe(false);
  });
});

describe("v2 input checks", () => {
  it("an off-curve, compressed, wrong-length or identity share is refused before any math", async () => {
    const w = await passwordScalarV2("204957", "c");
    const st = spake2Start("B", w);
    const good = spake2Start("A", w).share;
    const offCurve = new Uint8Array(good);
    offCurve[64] = (offCurve[64] as number) ^ 1;
    for (const bad of [offCurve, good.subarray(0, 64), M.toBytes(true), new Uint8Array(65)])
      await expect(spake2Finish(st, bad, NIL)).rejects.toBeInstanceOf(LinkError);
    expect(() => parseShare(new Uint8Array([0]))).toThrow(LinkError);
  });

  it("a share that unblinds to infinity (pA = w·M) is refused", async () => {
    const w = await passwordScalarV2("204957", "c");
    const st = spake2Start("B", w);
    await expect(spake2Finish(st, M.multiply(w).toBytes(false), NIL)).rejects.toMatchObject({
      code: "protocol",
    });
  });

  it("w is HKDF-SHA256(code, context, 'alca-link/v2 spake2 w', 48) mod n (re-derived with node:crypto)", async () => {
    const okm = Buffer.from(hkdfSync("sha256", "204957", "pair|381", "alca-link/v2 spake2 w", 48));
    const n = p256.Point.Fn.ORDER;
    expect(await passwordScalarV2("204957", "pair|381")).toBe(BigInt(`0x${okm.toString("hex")}`) % n);
  });

  it("version choice: v2 when offered; nothing otherwise (v1 is removed, no fallback)", () => {
    expect(PAKE_SUPPORTED).toEqual([PAKE_V2]);
    expect(choosePake([2, 1])).toBe(PAKE_V2);
    expect(choosePake([2])).toBe(PAKE_V2);
    expect(choosePake(undefined)).toBeUndefined(); // a pre-G1 peer sends no pk
    expect(choosePake([1])).toBeUndefined();
    expect(choosePake(["2"])).toBeUndefined();
    expect(choosePake(2)).toBeUndefined();
    expect(choosePake([3])).toBeUndefined();
  });
});

describe("the P-256 group (src/curve.ts)", () => {
  it("has exactly noble's own p256 parameters, and k·G agrees with OpenSSL", async () => {
    const { Point: Ours } = await import("../src/curve.ts");
    const theirs = p256.Point.CURVE();
    const ours = Ours.CURVE();
    for (const k of ["p", "n", "h", "a", "b", "Gx", "Gy"] as const) expect(ours[k]).toBe(theirs[k]);
    const { createECDH } = await import("node:crypto");
    const k = 0x1234567890abcdefn;
    const e = createECDH("prime256v1");
    e.setPrivateKey(Buffer.from(k.toString(16).padStart(64, "0"), "hex"));
    expect(hex(Ours.BASE.multiply(k).toBytes(false))).toBe(e.getPublicKey("hex"));
  });
});
