// Byte helpers shared by the Node host and the phone PWA (no Node built-ins here).

export type Bytes = Uint8Array<ArrayBuffer>;

// WebCrypto types, spelled so they resolve both under Node's types and the DOM lib.
export type Subtle = typeof globalThis.crypto.subtle;
export type Key = Awaited<ReturnType<Subtle["importKey"]>>;
export interface KeyPair {
  privateKey: Key;
  publicKey: Key;
}
export interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  [k: string]: unknown;
}

export const subtle = (): Subtle => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available (needs a secure context)");
  return s;
};

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (s: string): Bytes => enc.encode(s) as Bytes;
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Length-prefixed concatenation (4-byte big-endian length before each part): unambiguous transcripts. */
export function framed(...parts: Uint8Array[]): Bytes {
  const pieces: Uint8Array[] = [];
  for (const p of parts) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, p.length);
    pieces.push(len, p);
  }
  return concat(...pieces);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export function toB64u(b: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8) | (b[i + 2] as number);
    s += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = (b[i] as number) << 16;
    s += B64[n >> 18]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8);
    s += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return s;
}

export class EncodingError extends Error {}

export function fromB64u(s: string): Bytes {
  if (typeof s !== "string" || s.length % 4 === 1) throw new EncodingError("bad base64url");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const c of s) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw new EncodingError("bad base64url");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o) as Bytes;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

export async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", concat(...parts))) as Bytes;
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bytes: number): Promise<Bytes> {
  const key = await subtle().importKey("raw", ikm as Bytes, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as Bytes, info: utf8(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits) as Bytes;
}

export function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

export function bigIntToBytes(n: bigint, len: number): Bytes {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new RangeError("integer does not fit");
  return out;
}
