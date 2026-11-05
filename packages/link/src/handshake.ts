// Pairing (once per device) and session (every connection) handshakes.
//
// Pairing: SPAKE2 on the short code. PAKE v2 (Phase G1, spake2.ts) is RFC
// 9382 with key confirmation: the device (A) proves it knows the code (cA)
// before the core sends anything keyed by the PAKE, and the core proves it
// (cB, inside its first sealed frame) before the device sends its identity.
// Inside the sealed channel both sides send their long-term identity public
// key and a signature over TT. The device pins the core's key, the core
// stores the device's key; the host burns the code on any failure.
//
//   1 device → core  {t:"pair1", v:1, pk:[2], share2: pA}
//   2 core → device  {t:"pair2", pk:2, share: pB}         nothing keyed by K yet
//   3 device → core  {t:"pair3", c: cA}
//     core: cA wrong → fail wrong_code (one online guess, then the code is gone)
//   4 core → device  sealed {k:"pair.core", pub, sig, name, c: cB}
//   5 device: cB wrong → stop; else sealed {k:"pair.device", …} → pair.done
//
// PAKE v1 (the pre-G1 protocol) is removed. A core answers a pair1 whose `pk`
// has no 2 (a v1 page or app: `pk` absent, only a v1 `share`) with
// `fail upgrade_required` before any PAKE; a device answered without `pk: 2`
// stops with `downgrade`. `pk` stays a list for later versions.
//
// Session: signed ephemeral ECDH (SIGMA-style). The device says who it is,
// the core answers with its ephemeral key signed by the pinned core identity,
// the device signs the same transcript hash; keys come from HKDF over the ECDH
// secret salted with the transcript hash. Fresh ephemerals each time give
// forward secrecy, and a recorded handshake cannot be replayed.
import {
  type Bytes,
  framed,
  fromB64u,
  type Key,
  type KeyPair,
  randomBytes,
  sha256,
  subtle,
  toB64u,
  utf8,
} from "./bytes.ts";
import { deriveChannelKeys, SecureChannel } from "./channel.ts";
import { LinkError, type LinkErrorCode } from "./errors.ts";
import { assertSignature, fingerprint, type Identity, sign } from "./identity.ts";
import {
  choosePake,
  PAKE_SUPPORTED,
  PAKE_V2,
  pakeAad,
  passwordScalarV2,
  spake2Finish,
  spake2Start,
  UPGRADE_MESSAGE,
} from "./spake2.ts";
import { str, type Wire, type WireMessage } from "./wire.ts";

export const LINK_VERSION = 1;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export type DeviceKind = "phone" | "hands";

export interface PairingCode {
  /** Public part: tells the relay which pairing to join (3 or 4 digits). */
  nameplate: string;
  /** Secret part: the PAKE password (6 digits). Never leaves the two ends. */
  secret: string;
}

/** `381-204957`, `381 204 957` and `381204957` all parse; the last 6 digits are the secret. */
export function parseCode(input: string): PairingCode {
  const digits = input.replace(/[\s\-–·.]/g, "");
  if (!/^\d{9,10}$/.test(digits)) throw new LinkError("malformed", "pairing code must be 9–10 digits");
  return { nameplate: digits.slice(0, -6), secret: digits.slice(-6) };
}

export function formatCode(c: PairingCode): string {
  return `${c.nameplate}-${c.secret.slice(0, 3)}-${c.secret.slice(3)}`;
}

export function newSecret(): string {
  const n = new Uint32Array(1);
  let v: number;
  do {
    globalThis.crypto.getRandomValues(n);
    v = n[0] as number;
  } while (v >= 4_294_000_000); // reject the top sliver: uniform over 0..999999
  return (v % 1_000_000).toString().padStart(6, "0");
}

function failOf(m: WireMessage): LinkError | undefined {
  if (m.t !== "fail") return undefined;
  const code = typeof m.code === "string" ? (m.code as LinkErrorCode) : "refused";
  return new LinkError(code, typeof m.message === "string" ? m.message : code);
}

async function expect(wire: Wire, t: string, timeoutMs?: number): Promise<WireMessage> {
  const m = await wire.recv(timeoutMs);
  const f = failOf(m);
  if (f) throw f;
  if (m.t !== t) throw new LinkError("protocol", `expected ${t}, got ${String(m.t)}`);
  return m;
}

/** Receive one sealed frame. A bad tag right after a PAKE means the codes differed. */
export async function recvSealed(
  wire: Wire,
  ch: SecureChannel,
  tamperedAs: LinkErrorCode = "tampered",
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const m = await expect(wire, "f", timeoutMs);
  if (typeof m.d !== "string") throw new LinkError("malformed", "sealed frame without data");
  try {
    const v = await ch.open(m.d);
    if (!v || typeof v !== "object") throw new LinkError("malformed", "sealed body is not an object");
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof LinkError && e.code === "tampered") throw new LinkError(tamperedAs, e.message);
    throw e;
  }
}

export async function sendSealed(wire: Wire, ch: SecureChannel, body: unknown): Promise<void> {
  wire.send({ t: "f", d: await ch.seal(body) });
}

const fail = (wire: Wire, code: LinkErrorCode, message?: string) => {
  wire.send({ t: "fail", code, ...(message ? { message } : {}) });
  wire.close(code);
};

// ── Pairing ─────────────────────────────────────────────────────────────

export interface DeviceInfo {
  name: string;
  kind: DeviceKind;
  platform: string;
}

export interface PairResult {
  deviceId: string;
  corePublicRaw: Bytes;
  coreFingerprint: string;
  mailbox: string;
  scopes: string[];
  coreName: string;
  /** The PAKE version the pairing ran (always 2 since v1 was removed). */
  pake: number;
}

const pairLabel = (tt: Uint8Array, who: "core" | "device") =>
  framed(utf8("alca-link/v2 pair"), tt, utf8(who));
const pairContext = (nameplate: string) => `pair|${nameplate}`;
const offeredList = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];

/** The device's half of the PAKE: v2 (RFC 9382 with cA first), the only version it runs. */
async function devicePake(
  wire: Wire,
  code: PairingCode,
): Promise<{ ch: SecureChannel; tt: Bytes; pake: number; verifyCore(c: unknown): Promise<boolean> }> {
  const offered = [...PAKE_SUPPORTED];
  const st2 = spake2Start("A", await passwordScalarV2(code.secret, pairContext(code.nameplate)));
  wire.send({ t: "pair1", v: LINK_VERSION, pk: offered, share2: toB64u(st2.share) });
  const p2 = await expect(wire, "pair2");
  if (p2.pk !== PAKE_V2) {
    // A pre-G1 computer (v1 only), or someone stripping v2: either way, stop.
    fail(wire, "downgrade");
    throw new LinkError("downgrade", "the computer answered with pairing v1, which is no longer supported");
  }
  const aad = pakeAad({ purpose: "pair", context: code.nameplate, offered, chosen: PAKE_V2 });
  const r = await spake2Finish(st2, fromB64u(str(p2, "share")), aad);
  wire.send({ t: "pair3", c: toB64u(r.confirm) });
  const keys = await deriveChannelKeys(r.ke, new Uint8Array(0), "alca-link/v2 pair keys", "device");
  return {
    ch: await SecureChannel.create(keys),
    tt: r.tt,
    pake: PAKE_V2,
    verifyCore: async (c) => typeof c === "string" && r.verifyPeer(fromB64u(c)),
  };
}

export async function pairAsDevice(
  wire: Wire,
  o: {
    code: PairingCode;
    identity: Identity;
    device: DeviceInfo;
    expectFingerprint?: string;
  },
): Promise<PairResult> {
  try {
    const { ch, tt, pake, verifyCore } = await devicePake(wire, o.code);
    let core: Record<string, unknown>;
    try {
      core = await recvSealed(wire, ch, "wrong_code");
    } catch (e) {
      if (e instanceof LinkError && e.code === "wrong_code") fail(wire, "wrong_code");
      throw e;
    }
    if (core.k !== "pair.core") throw new LinkError("protocol", "expected pair.core");
    // The core proves the code (cB) before this device sends its identity.
    if (!(await verifyCore(core.c))) {
      fail(wire, "wrong_code");
      throw new LinkError("wrong_code", "the computer's key confirmation did not verify");
    }
    const corePub = fromB64u(str(core, "pub"));
    await assertSignature(corePub, fromB64u(str(core, "sig")), pairLabel(tt, "core"));
    const fp = await fingerprint(corePub);
    if (o.expectFingerprint && o.expectFingerprint !== fp) {
      fail(wire, "fingerprint_mismatch");
      throw new LinkError("fingerprint_mismatch", "the core's key is not the one in the QR code");
    }
    await sendSealed(wire, ch, {
      k: "pair.device",
      pub: toB64u(o.identity.publicRaw),
      sig: toB64u(await sign(o.identity, pairLabel(tt, "device"))),
      ...o.device,
    });
    const done = await recvSealed(wire, ch);
    if (done.k === "pair.refused") throw new LinkError("refused", String(done.reason ?? "refused"));
    if (done.k !== "pair.done") throw new LinkError("protocol", "expected pair.done");
    ch.close();
    return {
      deviceId: str(done, "deviceId"),
      corePublicRaw: corePub,
      coreFingerprint: fp,
      mailbox: str(done, "mailbox"),
      scopes: Array.isArray(done.scopes) ? done.scopes.filter((s) => typeof s === "string") : [],
      coreName: typeof done.coreName === "string" ? done.coreName : "Alca",
      pake,
    };
  } finally {
    wire.close("paired");
  }
}

export interface PairedDevice extends DeviceInfo {
  publicRaw: Bytes;
  fingerprint: string;
}

export async function pairAsCore(
  wire: Wire,
  o: {
    code: PairingCode;
    identity: Identity;
    coreName: string;
    /** Store the device; returns its id, scopes and the core's mailbox. Throw to refuse. */
    accept(d: PairedDevice): Promise<{ deviceId: string; scopes: string[]; mailbox: string }>;
    /** Called once the PAKE version is known (for the audit log and the UI). */
    onPake?(version: number): void;
  },
): Promise<PairedDevice & { pake: number }> {
  try {
    const p1 = await expect(wire, "pair1", 30_000);
    if (p1.v !== LINK_VERSION) throw new LinkError("protocol", "unsupported link version");
    // A pre-G1 device offers no `pk` (v1 only): refused before any PAKE runs.
    const pake = choosePake(p1.pk);
    if (pake === undefined) {
      fail(wire, "upgrade_required", UPGRADE_MESSAGE);
      throw new LinkError("upgrade_required", "the device offered only pairing v1, which was removed");
    }
    o.onPake?.(pake);
    const offered = offeredList(p1.pk);
    const st = spake2Start("B", await passwordScalarV2(o.code.secret, pairContext(o.code.nameplate)));
    const aad = pakeAad({ purpose: "pair", context: o.code.nameplate, offered, chosen: PAKE_V2 });
    const r = await spake2Finish(st, fromB64u(str(p1, "share2")), aad);
    wire.send({ t: "pair2", pk: PAKE_V2, share: toB64u(st.share) });
    // Nothing keyed by K leaves before the device proved the code.
    const p3 = await expect(wire, "pair3");
    if (!(await r.verifyPeer(fromB64u(str(p3, "c"))))) {
      fail(wire, "wrong_code");
      throw new LinkError("wrong_code", "the device's key confirmation did not verify");
    }
    const tt = r.tt;
    const ch = await SecureChannel.create(
      await deriveChannelKeys(r.ke, new Uint8Array(0), "alca-link/v2 pair keys", "core"),
    );
    await sendSealed(wire, ch, {
      k: "pair.core",
      pub: toB64u(o.identity.publicRaw),
      sig: toB64u(await sign(o.identity, pairLabel(tt, "core"))),
      name: o.coreName,
      c: toB64u(r.confirm),
    });
    const dev = await recvSealed(wire, ch, "wrong_code");
    if (dev.k !== "pair.device") throw new LinkError("protocol", "expected pair.device");
    const pub = fromB64u(str(dev, "pub"));
    await assertSignature(pub, fromB64u(str(dev, "sig")), pairLabel(tt, "device"));
    const kind: DeviceKind = dev.kind === "hands" ? "hands" : "phone";
    const paired: PairedDevice = {
      name: str(dev, "name").slice(0, 60) || "裝置",
      kind,
      platform: typeof dev.platform === "string" ? dev.platform.slice(0, 80) : "",
      publicRaw: pub,
      fingerprint: await fingerprint(pub),
    };
    let accepted: { deviceId: string; scopes: string[]; mailbox: string };
    try {
      accepted = await o.accept(paired);
    } catch (e) {
      await sendSealed(wire, ch, { k: "pair.refused", reason: e instanceof Error ? e.message : "refused" });
      throw new LinkError("refused", "pairing refused");
    }
    await sendSealed(wire, ch, { k: "pair.done", ...accepted, coreName: o.coreName });
    return { ...paired, pake };
  } finally {
    // Give the last frame a moment to leave before the channel closes.
    setTimeout(() => wire.close("paired"), 50);
  }
}

// ── Session ─────────────────────────────────────────────────────────────

async function ephemeral(): Promise<{ priv: Key; pub: Bytes }> {
  const kp = (await subtle().generateKey(ECDH, false, ["deriveBits"])) as KeyPair;
  return { priv: kp.privateKey, pub: new Uint8Array(await subtle().exportKey("raw", kp.publicKey)) };
}

async function ecdh(priv: Key, peer: Uint8Array): Promise<Bytes> {
  let key: Key;
  try {
    key = await subtle().importKey("raw", peer as Bytes, ECDH, false, []);
  } catch {
    throw new LinkError("malformed", "bad ephemeral key");
  }
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: key }, priv, 256));
}

async function sessionHash(
  mailbox: string,
  deviceId: string,
  eD: Uint8Array,
  nD: Uint8Array,
  eC: Uint8Array,
  nC: Uint8Array,
) {
  return sha256(framed(utf8("alca-link/v1 session"), utf8(mailbox), utf8(deviceId), eD, nD, eC, nC));
}
const sessionLabel = (th: Uint8Array, who: "core" | "device") =>
  framed(utf8("alca-link/v1 session auth"), th, utf8(who));

export interface DeviceSession {
  channel: SecureChannel;
  /** The core's first sealed message (`{k: "ready", …}`). */
  ready: Record<string, unknown>;
}

export async function sessionAsDevice(
  wire: Wire,
  o: { deviceId: string; identity: Identity; corePublicRaw: Uint8Array; mailbox: string },
): Promise<DeviceSession> {
  const eph = await ephemeral();
  const nD = randomBytes(16);
  wire.send({ t: "hello", v: LINK_VERSION, device: o.deviceId, e: toB64u(eph.pub), n: toB64u(nD) });
  const w = await expect(wire, "welcome");
  const eC = fromB64u(str(w, "e"));
  const nC = fromB64u(str(w, "n"));
  const th = await sessionHash(o.mailbox, o.deviceId, eph.pub, nD, eC, nC);
  try {
    await assertSignature(o.corePublicRaw, fromB64u(str(w, "sig")), sessionLabel(th, "core"));
  } catch (e) {
    fail(wire, "bad_signature");
    throw e;
  }
  const keys = await deriveChannelKeys(await ecdh(eph.priv, eC), th, "alca-link/v1 session keys", "device");
  wire.send({ t: "auth", sig: toB64u(await sign(o.identity, sessionLabel(th, "device"))) });
  const channel = await SecureChannel.create(keys);
  const ready = await recvSealed(wire, channel);
  if (ready.k !== "ready") throw new LinkError("protocol", "expected ready");
  return { channel, ready };
}

export type DeviceLookup = (deviceId: string) => { publicRaw: Uint8Array } | "revoked" | undefined;

export async function sessionAsCore(
  wire: Wire,
  o: { identity: Identity; mailbox: string; lookup: DeviceLookup },
): Promise<{ channel: SecureChannel; deviceId: string }> {
  const h = await expect(wire, "hello", 20_000);
  if (h.v !== LINK_VERSION) {
    fail(wire, "protocol", "unsupported link version");
    throw new LinkError("protocol", "unsupported link version");
  }
  const deviceId = str(h, "device");
  const dev = o.lookup(deviceId);
  if (dev === "revoked" || dev === undefined) {
    const code = dev === "revoked" ? "revoked" : "unknown_device";
    fail(wire, code);
    throw new LinkError(code, `device ${deviceId}: ${code}`);
  }
  const eD = fromB64u(str(h, "e"));
  const nD = fromB64u(str(h, "n"));
  const eph = await ephemeral();
  const nC = randomBytes(16);
  const th = await sessionHash(o.mailbox, deviceId, eD, nD, eph.pub, nC);
  const secret = await ecdh(eph.priv, eD);
  wire.send({
    t: "welcome",
    e: toB64u(eph.pub),
    n: toB64u(nC),
    sig: toB64u(await sign(o.identity, sessionLabel(th, "core"))),
  });
  const a = await expect(wire, "auth");
  try {
    await assertSignature(dev.publicRaw, fromB64u(str(a, "sig")), sessionLabel(th, "device"));
  } catch (e) {
    fail(wire, "bad_signature");
    throw e;
  }
  const channel = await SecureChannel.create(
    await deriveChannelKeys(secret, th, "alca-link/v1 session keys", "core"),
  );
  return { channel, deviceId };
}
