// Message encryption for Web Push (RFC 8291) in the "aes128gcm" content
// coding (RFC 8188): one record, the sender's ephemeral ECDH public key as the
// key id, a 16-byte random salt, the 0x02 padding delimiter.
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { fromB64u } from "./b64.ts";

/** What the browser hands out in `PushSubscription.toJSON().keys`. */
export interface SubscriptionKeys {
  /** The user agent's ECDH public key, uncompressed P-256 (65 bytes), base64url. */
  p256dh: string;
  /** The 16-byte authentication secret, base64url. */
  auth: string;
}

export class PushKeyError extends Error {}

const RECORD_SIZE = 4096;
/** 4096-byte body − 86-byte header − 1 delimiter − 16 tag (RFC 8291 §4). */
export const MAX_PLAINTEXT = 3993;

const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]) => Buffer.concat(parts);

/** Validate a subscription's keys: a point on P-256 and a 16-byte secret (RFC 8291 §7). */
export function checkKeys(keys: SubscriptionKeys): { uaPublic: Buffer; auth: Buffer } {
  const uaPublic = fromB64u(keys.p256dh ?? "");
  const auth = fromB64u(keys.auth ?? "");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04)
    throw new PushKeyError("p256dh must be 65 bytes (0x04…)");
  if (auth.length !== 16) throw new PushKeyError("auth must be 16 bytes");
  try {
    // computeSecret refuses a point that is not on the curve.
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(uaPublic);
  } catch {
    throw new PushKeyError("p256dh is not a point on P-256");
  }
  return { uaPublic, auth };
}

function derive(ecdhSecret: Buffer, auth: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer) {
  const keyInfo = cat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12));
  return { cek, nonce };
}

export interface EncryptOptions {
  /** Fixed salt (tests against the RFC vector); random otherwise. */
  salt?: Uint8Array;
  /** Fixed sender private key (tests); a fresh ephemeral key otherwise. */
  senderPrivateKey?: Uint8Array;
}

/** Encrypt one push message body. Returns the full HTTP body (header + one record). */
export function encryptPayload(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
  o: EncryptOptions = {},
): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new PushKeyError(`payload over ${MAX_PLAINTEXT} bytes`);
  const { uaPublic, auth } = checkKeys(keys);
  const ecdh = createECDH("prime256v1");
  if (o.senderPrivateKey) ecdh.setPrivateKey(Buffer.from(o.senderPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = o.salt ? Buffer.from(o.salt) : randomBytes(16);
  if (salt.length !== 16) throw new PushKeyError("salt must be 16 bytes");
  const { cek, nonce } = derive(ecdh.computeSecret(uaPublic), auth, uaPublic, asPublic, salt);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = cat(cipher.update(cat(plaintext, Uint8Array.of(0x02))), cipher.final(), cipher.getAuthTag());
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return cat(header, asPublic, body);
}

/**
 * The user agent's side (tests and the mock push endpoint): decrypt a body
 * with the subscription's private key and auth secret.
 */
export function decryptPayload(body: Uint8Array, uaPrivateKey: Uint8Array, auth: Uint8Array): Buffer {
  const buf = Buffer.from(body);
  if (buf.length < 21 + 16) throw new PushKeyError("body too short");
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf.readUInt8(20);
  if (idlen !== 65) throw new PushKeyError("key id must be the sender's 65-byte public key");
  const asPublic = buf.subarray(21, 21 + idlen);
  const record = buf.subarray(21 + idlen);
  if (record.length > rs) throw new PushKeyError("more than one record");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPrivateKey));
  const uaPublic = ecdh.getPublicKey();
  const { cek, nonce } = derive(ecdh.computeSecret(asPublic), Buffer.from(auth), uaPublic, asPublic, salt);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const out = cat(d.update(record.subarray(0, record.length - 16)), d.final());
  // Last non-zero byte must be the 0x02 delimiter of a final record (RFC 8188 §2, RFC 8291 §4).
  let end = out.length - 1;
  while (end >= 0 && out[end] === 0) end--;
  if (end < 0 || out[end] !== 0x02) throw new PushKeyError("bad padding delimiter");
  return out.subarray(0, end);
}
