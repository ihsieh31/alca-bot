// FROZEN v1 PAKE (moved here from src/pake.ts when v1 was removed from the
// product, pake-v1-remove). Test fixture only: plays an old phone / old core
// so the tests can show a v1 peer is refused. Do not edit, do not import from src.
//
// PAKE v1 — the pre-G1 SPAKE2 variant, kept only so phones and computers
// from before Phase G1 can still pair when the owner opts in (accepted only
// with engineering.link.pakeV1 = "allow"; default "deny"; to be removed). New pairings run v2
// (spake2.ts: RFC 9382 with key confirmation). v1 has no key confirmation:
// the first sealed frame is what tells a wrong code. A relay without the code
// gets one online guess per run; a pairing code is burned after any failure
// (host.ts), an enrollment code after its first wrong try (enroll.ts). Point
// math is noble's via p256.ts; see docs/CRYPTO.md for the threat model.
//
//   core  (A): X = x·G (WebCrypto ECDH key)   pA = X + w·M
//   phone (B): Y = y·G                         pB = Y + w·N
//   A: K = x·(pB − w·N)   B: K = y·(pA − w·M)   (x-coordinate via ECDH deriveBits)
//
// M and N are hashed onto the curve from public labels (no known discrete
// log). w is derived from the code and the nameplate. The secret scalars x, y
// never leave WebCrypto.
import {
  type Bytes,
  bigIntToBytes,
  bytesToBigInt,
  framed,
  hkdf,
  type Key,
  type KeyPair,
  sha256,
  subtle,
  utf8,
} from "../../../src/bytes.ts";
import { LinkError } from "../../../src/errors.ts";
import { add, decodePoint, encodePoint, hashToPoint, multiply, N, negate, type Point } from "./p256.ts";

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
export const PAKE_LABEL = "alca-link/v1 spake2-p256";

let constants: Promise<{ M: Point; N: Point }> | undefined;
export function pakeConstants(): Promise<{ M: Point; N: Point }> {
  constants ??= (async () => ({
    M: await hashToPoint(`${PAKE_LABEL} M`),
    N: await hashToPoint(`${PAKE_LABEL} N`),
  }))();
  return constants;
}

/** Password scalar in [1, n-1]: 48 bytes of HKDF output reduced mod n-1 (negligible bias). */
export async function passwordScalar(secret: string, nameplate: string): Promise<bigint> {
  const okm = await hkdf(utf8(secret), utf8(nameplate), `${PAKE_LABEL} w`, 48);
  return (bytesToBigInt(okm) % (N - 1n)) + 1n;
}

export type PakeRole = "core" | "device";

export interface PakeState {
  role: PakeRole;
  w: bigint;
  nameplate: string;
  priv: Key;
  /** This side's blinded share (65 bytes). */
  share: Bytes;
}

export async function pakeStart(role: PakeRole, secret: string, nameplate: string): Promise<PakeState> {
  const { M, N: NN } = await pakeConstants();
  const w = await passwordScalar(secret, nameplate);
  const kp = (await subtle().generateKey(ECDH, false, ["deriveBits"])) as KeyPair;
  const pub = decodePoint(new Uint8Array(await subtle().exportKey("raw", kp.publicKey)));
  const blinded = add(pub, multiply(role === "core" ? M : NN, w));
  if (!blinded) throw new LinkError("protocol", "degenerate share");
  return { role, w, nameplate, priv: kp.privateKey, share: encodePoint(blinded) };
}

/**
 * Finish with the peer's share. Returns the transcript hash: identical on
 * both sides only when both used the same code (and nobody altered a share).
 */
export async function pakeFinish(st: PakeState, peerShare: Uint8Array): Promise<Bytes> {
  const { M, N: NN } = await pakeConstants();
  let peer: Point;
  try {
    peer = decodePoint(peerShare);
  } catch {
    throw new LinkError("malformed", "bad PAKE share");
  }
  const unblinded = add(peer, negate(multiply(st.role === "core" ? NN : M, st.w)));
  if (!unblinded) throw new LinkError("protocol", "degenerate share");
  const pubKey = await subtle().importKey("raw", encodePoint(unblinded), ECDH, false, []);
  const k = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: pubKey }, st.priv, 256));
  const [pA, pB] = st.role === "core" ? [st.share, peerShare] : [peerShare, st.share];
  return sha256(framed(utf8(PAKE_LABEL), utf8(st.nameplate), pA, pB, k, bigIntToBytes(st.w, 32)));
}
