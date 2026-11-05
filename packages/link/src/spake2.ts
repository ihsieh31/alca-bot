// PAKE v2 (Phase G1): SPAKE2 exactly as RFC 9382, ciphersuite
// SPAKE2-P256-SHA256-HKDF-HMAC, with explicit key confirmation.
//
//   A (the side that speaks first, the device) uses M, B (the core) uses N:
//     pA = x·P + w·M        pB = y·P + w·N        (x, y uniform in [1, n))
//     A: K = x·(pB − w·N)   B: K = y·(pA − w·M)   (cofactor h = 1)
//   TT  = len(A)‖A ‖ len(B)‖B ‖ len(pA)‖pA ‖ len(pB)‖pB ‖ len(K)‖K ‖ len(w)‖w
//         (len = 8-byte little endian; points SEC1 uncompressed; w 32 bytes BE)
//   Ke ‖ Ka   = SHA-256(TT)
//   KcA ‖ KcB = HKDF-SHA256(ikm = Ka, salt = nil, info = "ConfirmationKeys" ‖ AAD, L = 32)
//   cA = HMAC-SHA256(KcA, TT)   cB = HMAC-SHA256(KcB, TT)
//
// M and N are the RFC 9382 §6 constants for P-256; nothing is hashed to the
// curve. AAD binds the protocol name, the purpose (pairing / enrollment),
// the context (nameplate or enrollment salt) and both sides' version lists,
// so a changed list or context fails confirmation (RFC 9382 §3.2).
//
// Ordering rule enforced by the callers (handshake.ts, enroll.ts): A sends
// cA before anything else keyed by K; B checks cA (constant time,
// WebCrypto HMAC verify) before it sends cB or any sealed frame.
//
// Point math: @noble/curves (curve.ts). Received points are validated (on the curve,
// not infinity) before use. JavaScript cannot promise constant time.
import { type Bytes, bigIntToBytes, bytesToBigInt, concat, framed, subtle, utf8 } from "./bytes.ts";
import { ORDER, Point, randomScalar } from "./curve.ts";
import { LinkError } from "./errors.ts";

export const PAKE_V2 = 2;
/**
 * The PAKE versions this build can run, best first (sent as `pk`). v2 only:
 * v1 (the pre-G1 protocol) was removed. `pk` stays a list so a later version
 * can be negotiated the same way.
 */
export const PAKE_SUPPORTED: readonly number[] = [PAKE_V2];
export const V2_LABEL = "alca-link/v2";
/** Implicit identities (RFC 9382 §3.3): roles are fixed; long-term keys are bound one layer up by signatures. */
export const ID_DEVICE = "alca-link device";
export const ID_CORE = "alca-link core";

type Pt = Point;

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
/** RFC 9382 §6, P-256: seeds "1.2.840.10045.3.1.7 point generation seed (M|N)". */
export const M = Point.fromBytes(hex("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f"));
export const N = Point.fromBytes(hex("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49"));

export type Spake2Role = "A" | "B";

export interface Spake2State {
  role: Spake2Role;
  w: bigint;
  x: bigint;
  /** This side's share, SEC1 uncompressed (65 bytes). */
  share: Bytes;
  idA: string;
  idB: string;
}

export interface Spake2Result {
  /** The shared secret (16 bytes). The only output used after the PAKE. */
  ke: Bytes;
  tt: Bytes;
  /** This side's confirmation MAC (cA for A, cB for B). */
  confirm: Bytes;
  /** Constant-time check of the peer's confirmation MAC. */
  verifyPeer(mac: Uint8Array): Promise<boolean>;
  /** Exposed for the RFC 9382 vectors only. */
  kcA: Bytes;
  kcB: Bytes;
  K: Bytes;
}

/**
 * w = OS2IP(HKDF-SHA256(ikm = code, salt = context, info = "alca-link/v2 spake2 w", 48 bytes)) mod n.
 * 48 bytes is 128 bits more than n, so the bias is negligible (RFC 9382 §3.2, SP 800-56A).
 */
export async function passwordScalarV2(code: string, context: string): Promise<bigint> {
  const key = await subtle().importKey("raw", utf8(code), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: utf8(context), info: utf8(`${V2_LABEL} spake2 w`) },
    key,
    48 * 8,
  );
  const w = bytesToBigInt(new Uint8Array(bits)) % ORDER;
  if (w === 0n) throw new LinkError("protocol", "degenerate password scalar");
  return w;
}

/** Start a run. `x` is for known-answer tests only; real runs draw it uniformly. */
export function spake2Start(
  role: Spake2Role,
  w: bigint,
  ids: { a: string; b: string } = { a: ID_DEVICE, b: ID_CORE },
  x: bigint = randomScalar(),
): Spake2State {
  if (x <= 0n || x >= ORDER) throw new LinkError("protocol", "bad ephemeral scalar");
  const share = Point.BASE.multiply(x).add((role === "A" ? M : N).multiply(w));
  if (share.is0()) throw new LinkError("protocol", "degenerate share");
  return { role, w, x, share: share.toBytes(false) as Bytes, idA: ids.a, idB: ids.b };
}

/** Parse and validate a peer share: SEC1 uncompressed, on P-256, not infinity. */
export function parseShare(b: Uint8Array): Pt {
  if (b.length !== 65 || b[0] !== 4) throw new LinkError("malformed", "bad PAKE share");
  let p: Pt;
  try {
    p = Point.fromBytes(b);
    p.assertValidity();
  } catch {
    throw new LinkError("malformed", "bad PAKE share");
  }
  if (p.is0()) throw new LinkError("malformed", "bad PAKE share");
  return p;
}

const le64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const lp = (b: Uint8Array) => concat(le64(b.length), b);

/** RFC 9382 §3.3 transcript. */
export function transcript(o: {
  idA: string;
  idB: string;
  pA: Uint8Array;
  pB: Uint8Array;
  K: Uint8Array;
  w: bigint;
}): Bytes {
  return concat(lp(utf8(o.idA)), lp(utf8(o.idB)), lp(o.pA), lp(o.pB), lp(o.K), lp(bigIntToBytes(o.w, 32)));
}

/** What both sides must agree on besides the code (RFC 9382 §3.2 AAD). */
export function pakeAad(o: {
  purpose: "pair" | "enroll";
  context: string;
  /** The versions the device offered (its `pk`). */
  offered: readonly number[];
  /** The version the core chose. */
  chosen: number;
}): Bytes {
  return framed(
    utf8(V2_LABEL),
    utf8(o.purpose),
    utf8(o.context),
    utf8(o.offered.join(",")),
    utf8(String(o.chosen)),
  );
}

async function hmacKey(raw: Uint8Array) {
  return subtle().importKey("raw", raw as Bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Finish with the peer's share; nothing here is sent anywhere. */
export async function spake2Finish(
  st: Spake2State,
  peerShare: Uint8Array,
  aad: Uint8Array,
): Promise<Spake2Result> {
  const peer = parseShare(peerShare);
  const unblinded = peer.subtract((st.role === "A" ? N : M).multiply(st.w));
  if (unblinded.is0()) throw new LinkError("protocol", "degenerate share");
  const k = unblinded.multiply(st.x);
  if (k.is0()) throw new LinkError("protocol", "degenerate share");
  const K = k.toBytes(false) as Bytes;
  const [pA, pB] = st.role === "A" ? [st.share, peerShare] : [peerShare, st.share];
  const tt = transcript({ idA: st.idA, idB: st.idB, pA, pB, K, w: st.w });
  const h = new Uint8Array(await subtle().digest("SHA-256", tt));
  const ke = h.slice(0, 16) as Bytes;
  const ka = h.slice(16) as Bytes;
  const hk = await subtle().importKey("raw", ka, "HKDF", false, ["deriveBits"]);
  const kc = new Uint8Array(
    await subtle().deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: concat(utf8("ConfirmationKeys"), aad) },
      hk,
      256,
    ),
  );
  const kcA = kc.slice(0, 16) as Bytes;
  const kcB = kc.slice(16) as Bytes;
  const mine = await hmacKey(st.role === "A" ? kcA : kcB);
  const theirs = await hmacKey(st.role === "A" ? kcB : kcA);
  const confirm = new Uint8Array(await subtle().sign("HMAC", mine, tt)) as Bytes;
  return {
    ke,
    tt,
    confirm,
    // WebCrypto's HMAC verify compares in constant time (Node: CRYPTO_memcmp).
    verifyPeer: async (mac) => mac.length === 32 && subtle().verify("HMAC", theirs, mac as Bytes, tt),
    kcA,
    kcB,
    K,
  };
}

/**
 * What a core tells a device that offers no version it runs (`upgrade_required`;
 * in practice a v1-only page or app from before G1): the device must update its
 * Alca page or app and pair again (the code it typed is burned).
 */
export const UPGRADE_MESSAGE =
  "this computer accepts pairing v2 only: update the Alca phone page (reload it) and pair again with a new code";

/**
 * Pick the version: the best one both lists share, or undefined (the caller
 * answers `upgrade_required`). A missing or non-list `pk` (a pre-G1 peer) is
 * undefined: there is no v1 fallback.
 */
export function choosePake(offered: unknown): number | undefined {
  const list = Array.isArray(offered) ? offered.filter((v): v is number => typeof v === "number") : [];
  return PAKE_SUPPORTED.find((v) => list.includes(v));
}
