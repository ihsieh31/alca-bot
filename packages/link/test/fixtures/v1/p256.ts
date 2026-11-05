// FROZEN v1 point adapter (moved here from src/p256.ts when v1 was removed,
// pake-v1-remove). Test fixture only; only fixtures/v1/pake.ts uses it.
//
// P-256 point arithmetic for the PAKE. Since Phase G1 every group operation
// (add, negate, scalar multiply, point validation) is done by @noble/curves
// (the P-256 group from curve.ts, pinned exact version, see docs/CRYPTO.md), not by hand:
// its secret-scalar multiply uses a fixed window with blinding, and it has
// public third-party audits. What remains here is a thin adapter that keeps
// the old `{x, y}` interface the v1 compatibility path (pake.ts) and its
// known-answer tests use, plus `hashToPoint`, which only the v1 path calls,
// only on public labels (M and N of the v1 suite).
//
// JavaScript cannot promise constant time (JIT, GC, BigInt); noble documents
// the same limit. The v2 protocol (spake2.ts) uses noble directly.
import { type Bytes, bytesToBigInt, sha256, utf8 } from "../../../src/bytes.ts";
import { Point as CurvePoint } from "../../../src/curve.ts";

export const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
export const G: Point = {
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

export interface Point {
  x: bigint;
  y: bigint;
}
/** `null` is the point at infinity. */
export type MaybePoint = Point | null;

/** noble's point class (projective, validated). */
export const NoblePoint = CurvePoint;
export type NoblePoint = CurvePoint;

const mod = (a: bigint, m = P) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function powMod(b: bigint, e: bigint, m = P): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

export function onCurve(p: Point): boolean {
  if (p.x < 0n || p.x >= P || p.y < 0n || p.y >= P) return false;
  return mod(p.y * p.y - (p.x * p.x * p.x + A * p.x + B)) === 0n;
}

/** {x, y} → noble point (validated: on the curve, not infinity). */
export function toNoble(p: MaybePoint): NoblePoint {
  if (!p) return NoblePoint.ZERO;
  const q = NoblePoint.fromAffine({ x: p.x, y: p.y });
  q.assertValidity();
  return q;
}

/** noble point → {x, y}, or null for infinity. */
export function fromNoble(q: NoblePoint): MaybePoint {
  if (q.is0()) return null;
  const a = q.toAffine();
  return { x: a.x, y: a.y };
}

export function negate(p: MaybePoint): MaybePoint {
  return p ? fromNoble(toNoble(p).negate()) : null;
}

export function add(p: MaybePoint, q: MaybePoint): MaybePoint {
  return fromNoble(toNoble(p).add(toNoble(q)));
}

/** k·p (k reduced mod n). noble's `multiply` is its constant-time-intended path for secret scalars. */
export function multiply(p: MaybePoint, k: bigint): MaybePoint {
  k = mod(k, N);
  if (!p || k === 0n) return null;
  return fromNoble(toNoble(p).multiply(k));
}

/** SEC1 uncompressed encoding (WebCrypto "raw" ECDH / ECDSA public keys). */
export function encodePoint(p: Point): Bytes {
  return new Uint8Array(toNoble(p).toBytes(false)) as Bytes;
}

/** SEC1 uncompressed only, on the curve, not infinity (noble validates). */
export function decodePoint(b: Uint8Array): Point {
  if (b.length !== 65 || b[0] !== 4) throw new RangeError("expected an uncompressed P-256 point");
  let q: NoblePoint;
  try {
    q = NoblePoint.fromBytes(b);
  } catch {
    throw new RangeError("point is not on P-256");
  }
  const p = fromNoble(q);
  if (!p) throw new RangeError("point is not on P-256");
  return p;
}

/**
 * v1 only (the M and N of the v1 suite, public labels): hash a label to an x
 * coordinate, increment until it is on the curve, take the even y.
 * (P ≡ 3 mod 4, so the square root is a single exponentiation.) The v2 suite
 * uses RFC 9382's fixed M and N and never hashes to the curve.
 */
export async function hashToPoint(label: string): Promise<Point> {
  for (let i = 0; i < 1000; i++) {
    const x = mod(bytesToBigInt(await sha256(utf8(`${label}#${i}`))));
    const rhs = mod(x * x * x + A * x + B);
    const y = powMod(rhs, (P + 1n) / 4n);
    if (mod(y * y) !== rhs) continue;
    return { x, y: y % 2n === 0n ? y : mod(-y) };
  }
  throw new Error("hashToPoint: no point found");
}
