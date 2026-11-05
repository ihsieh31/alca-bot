// VAPID (RFC 8292): the core identifies itself to a push service with an
// ES256-signed JWT and its P-256 public key. The key pair is generated and
// kept on the core's computer; the public half is the `applicationServerKey`
// a phone subscribes with, so only this core can push to that subscription.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  sign,
  verify,
} from "node:crypto";
import { b64u, fromB64u } from "./b64.ts";

export interface VapidJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
}

export function isVapidJwk(v: unknown): v is VapidJwk {
  const k = v as Partial<VapidJwk> | null;
  return (
    !!k &&
    k.kty === "EC" &&
    k.crv === "P-256" &&
    typeof k.x === "string" &&
    typeof k.y === "string" &&
    typeof k.d === "string"
  );
}

export function generateVapidKey(): VapidJwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
  return { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string, d: jwk.d as string };
}

/** Uncompressed public point (65 bytes), base64url: the `applicationServerKey` and the `k=` parameter. */
export function vapidPublicKey(k: VapidJwk): string {
  return b64u(Buffer.concat([Uint8Array.of(0x04), fromB64u(k.x), fromB64u(k.y)]));
}

export interface VapidClaims {
  /** Origin of the push resource (scheme://host[:port]). */
  aud: string;
  /** Seconds since the epoch; at most 24 h ahead (RFC 8292 §2). */
  exp: number;
  /** Contact: a mailto: or https: URI. */
  sub: string;
}

const json = (v: unknown) => b64u(Buffer.from(JSON.stringify(v)));

/** ES256 JWT over the claims, signature in the raw r‖s form JWS uses. */
export function vapidJwt(k: VapidJwk, claims: VapidClaims): string {
  const input = `${json({ typ: "JWT", alg: "ES256" })}.${json(claims)}`;
  const key = createPrivateKey({ key: { ...k }, format: "jwk" });
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(sig)}`;
}

/** `Authorization: vapid t=<jwt>, k=<public key>` (RFC 8292 §3). */
export function vapidAuthorization(k: VapidJwk, claims: VapidClaims): string {
  return `vapid t=${vapidJwt(k, claims)}, k=${vapidPublicKey(k)}`;
}

/** Parse and verify a `vapid` Authorization header (the mock push service and tests). */
export function verifyVapid(
  header: string,
  now = Date.now() / 1000,
): { ok: true; claims: VapidClaims; publicKey: string } | { ok: false; why: string } {
  const m = /^vapid\s+t=([A-Za-z0-9_\-.]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header.trim());
  if (!m) return { ok: false, why: "not a vapid header" };
  const [, token, k] = m as unknown as [string, string, string];
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, why: "not a JWT" };
  const [h, p, s] = parts as [string, string, string];
  const head = JSON.parse(fromB64u(h).toString()) as { alg?: string; typ?: string };
  if (head.alg !== "ES256") return { ok: false, why: "alg must be ES256" };
  const raw = fromB64u(k);
  if (raw.length !== 65 || raw[0] !== 4) return { ok: false, why: "bad k" };
  const pub = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) },
    format: "jwk",
  });
  if (!verify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, fromB64u(s)))
    return { ok: false, why: "bad signature" };
  const claims = JSON.parse(fromB64u(p).toString()) as VapidClaims;
  if (typeof claims.exp !== "number" || claims.exp < now) return { ok: false, why: "expired" };
  if (claims.exp > now + 24 * 3600 + 60) return { ok: false, why: "exp more than 24 h ahead" };
  if (typeof claims.sub !== "string" || !/^(mailto:|https:)/.test(claims.sub))
    return { ok: false, why: "sub must be mailto: or https:" };
  return { ok: true, claims, publicKey: k };
}
