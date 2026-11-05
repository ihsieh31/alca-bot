// Long-term device identity: one ECDSA P-256 key pair per device (core,
// phone, hands daemon), created once and kept. Peers pin each other's public
// key at pairing time; every later session is signed with it.
import { type Bytes, fromB64u, type Jwk, type Key, type KeyPair, sha256, subtle, toB64u } from "./bytes.ts";
import { LinkError } from "./errors.ts";

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIG = { name: "ECDSA", hash: "SHA-256" } as const;

export interface Identity {
  privateKey: Key;
  /** SEC1 uncompressed public key (65 bytes). */
  publicRaw: Bytes;
}

/** `extractable: false` (phone) keeps the private key inside the browser's key store. */
export async function generateIdentity(extractable = false): Promise<Identity> {
  const kp = (await subtle().generateKey(ALG, extractable, ["sign", "verify"])) as KeyPair;
  return {
    privateKey: kp.privateKey,
    publicRaw: new Uint8Array(await subtle().exportKey("raw", kp.publicKey)),
  };
}

/** Serialized form for a file store (Node daemons). Never sent anywhere. */
export interface IdentityJwk {
  privateJwk: Jwk;
  publicRaw: string;
}

export async function exportIdentity(id: Identity): Promise<IdentityJwk> {
  return {
    privateJwk: (await subtle().exportKey("jwk", id.privateKey)) as Jwk,
    publicRaw: toB64u(id.publicRaw),
  };
}

export async function importIdentity(j: IdentityJwk): Promise<Identity> {
  // biome-ignore lint/suspicious/noExplicitAny: the JWK shape differs between the Node and DOM typings
  const privateKey = await subtle().importKey("jwk", j.privateJwk as any, ALG, true, ["sign"]);
  return { privateKey, publicRaw: fromB64u(j.publicRaw) };
}

export async function sign(id: Identity, data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().sign(SIG, id.privateKey, data as Bytes));
}

export async function verify(publicRaw: Uint8Array, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    const key = await subtle().importKey("raw", publicRaw as Bytes, ALG, false, ["verify"]);
    return await subtle().verify(SIG, key, sig as Bytes, data as Bytes);
  } catch {
    return false;
  }
}

export async function assertSignature(publicRaw: Uint8Array, sig: Uint8Array, data: Uint8Array) {
  if (!(await verify(publicRaw, sig, data))) throw new LinkError("bad_signature", "signature check failed");
}

/** Full SHA-256 fingerprint of a public key, base64url (43 chars). */
export async function fingerprint(publicRaw: Uint8Array): Promise<string> {
  return toB64u(await sha256(publicRaw));
}

/**
 * The core's relay mailbox: the first 128 bits of its key fingerprint. The
 * relay only lets the holder of that key listen on it (signed challenge).
 */
export async function mailboxOf(publicRaw: Uint8Array): Promise<string> {
  return (await fingerprint(publicRaw)).slice(0, 22);
}

/** Human-comparable form: 4 groups of 4 hex digits from the fingerprint. */
export async function safetyNumber(publicRaw: Uint8Array): Promise<string> {
  const h = [...(await sha256(publicRaw)).subarray(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return h.toUpperCase().match(/.{4}/g)!.join(" ");
}
