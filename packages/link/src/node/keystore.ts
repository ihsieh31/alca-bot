// File-backed identity + credentials for Node devices (hands daemon, test
// clients) and the core. Written owner-only (0600).

import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Jwk, toB64u } from "../bytes.ts";
import type { LinkCredentials } from "../client.ts";
import {
  exportIdentity,
  generateIdentity,
  type Identity,
  type IdentityJwk,
  importIdentity,
} from "../identity.ts";

/** Synchronous identity creation (for code paths that cannot await), same format as `exportIdentity`. */
export function generateIdentityJwkSync(): IdentityJwk {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const raw = publicKey.export({ format: "der", type: "spki" });
  // SPKI for P-256 ends with the 65-byte uncompressed point.
  return {
    privateJwk: privateKey.export({ format: "jwk" }) as Jwk,
    publicRaw: toB64u(new Uint8Array(raw.subarray(raw.length - 65))),
  };
}

export function isIdentityJwk(v: unknown): v is IdentityJwk {
  const o = v as IdentityJwk | null;
  return !!o && typeof o.publicRaw === "string" && !!o.privateJwk && o.privateJwk.kty === "EC";
}

export interface DeviceFile {
  identity: IdentityJwk;
  credentials?: LinkCredentials;
}

export function readDeviceFile(path: string): DeviceFile | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as DeviceFile;
}

export function writeDeviceFile(path: string, f: DeviceFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Load (or create) the identity in a device file. */
export async function loadDeviceIdentity(path: string): Promise<{ identity: Identity; file: DeviceFile }> {
  let f = readDeviceFile(path);
  if (!f) {
    f = { identity: await exportIdentity(await generateIdentity(true)) };
    writeDeviceFile(path, f);
  }
  return { identity: await importIdentity(f.identity), file: f };
}
