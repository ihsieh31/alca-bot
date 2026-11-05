// The P-256 group, built with @noble/curves' audited short-Weierstrass code
// (`abstract/weierstrass.js`) from the standard SEC 2 / FIPS 186 parameters.
// Built here rather than imported from `nist.js` so the phone page vendors
// only the group code, not FROST / OPRF / hash-to-curve / Ed25519. A test
// checks these parameters equal noble's own `p256` curve and OpenSSL.
import { weierstrass } from "@noble/curves/abstract/weierstrass.js";

export const P256_PARAMS: Record<"p" | "n" | "h" | "a" | "b" | "Gx" | "Gy", bigint> = {
  p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
  n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
  h: 1n,
  a: 0xffffffff00000001000000000000000000000000fffffffffffffffffffffffcn,
  b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
  Gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  Gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

/** P-256 points (projective, validated on decode). */
export const Point = weierstrass(P256_PARAMS);
export type Point = InstanceType<typeof Point>;
export const ORDER = P256_PARAMS.n;

/** A uniform scalar in [1, n) by rejection sampling (RFC 9382 §7). */
export function randomScalar(): bigint {
  const b = new Uint8Array(32);
  for (;;) {
    globalThis.crypto.getRandomValues(b);
    let k = 0n;
    for (const x of b) k = (k << 8n) | BigInt(x);
    if (k > 0n && k < ORDER) return k;
  }
}
