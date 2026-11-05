// Enrollment of a new device found through the person's Google account
// (P10, code entry since P12).
//
// The relay vouches only that the person signed in with the same Google
// account on both ends; it could still play either side with a key of its
// own. So the phone shows a fresh 6-digit code and the person types it on the
// computer: the code is the password of a SPAKE2 run between the two ends,
// and each long-term key signs the PAKE transcript inside the channel it
// keys. A relay without the code gets one online guess per try and cannot get
// its key accepted by either side — the phone checks the computer's
// signature as much as the computer checks the phone's.
//
// PAKE v2 (Phase G1, spake2.ts = RFC 9382 with key confirmation):
//   1 device → core  {t:"enroll1", v:1, n, pk:[2], share2: pA}
//   2 core → device  {t:"enroll2", pk:2, share: pB}       after the person typed the code
//   3 device → core  {t:"enroll3", c: cA}                 the phone proves the code first
//   4 core → device  {t:"enroll.again", left}             cA wrong: the phone shows a NEW code
//                 or sealed {k:"enroll.ok", c: cB}        the computer proves the code
//   5 device → core  sealed {k:"enroll.device", pub, sig, name, kind, platform}   (after cB verifies)
//   6 core → device  sealed {k:"enroll.done", pub, sig, deviceId, mailbox, scopes, coreName}
//                 or sealed {k:"enroll.refused", reason}
//
//   salt = "enroll|" ‖ mailbox ‖ "|" ‖ b64u(n);  w = passwordScalarV2(code, salt)
//   AAD  = pakeAad("enroll", salt, offered, 2)
//   sig  = sign(framed("alca-link/v2 enroll", TT, mailbox, pub, who))
//   keys = deriveChannelKeys(Ke, "", "alca-link/v2 enroll keys")
//
// A code is never tried twice: after a wrong try the phone draws a new code
// (onWrong hands it to the screen). PAKE v1 is removed: a core answers an
// enroll1 without `pk: 2` (a pre-G1 phone) `fail upgrade_required` before it
// asks for the code; a phone answered without `pk: 2` stops with `downgrade`.
import { type Bytes, framed, fromB64u, randomBytes, toB64u, utf8 } from "./bytes.ts";
import { deriveChannelKeys, SecureChannel } from "./channel.ts";
import { LinkError, type LinkErrorCode } from "./errors.ts";
import {
  type DeviceInfo,
  type DeviceKind,
  LINK_VERSION,
  newSecret,
  type PairedDevice,
  recvSealed,
  sendSealed,
} from "./handshake.ts";
import { assertSignature, fingerprint, type Identity, mailboxOf, sign } from "./identity.ts";
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

/** Tries one code allows (each is one online guess for someone without it). */
export const ENROLL_MAX_TRIES = 5;
/** How long a code shown on the phone is good for. */
export const ENROLL_TTL_MS = 5 * 60_000;

/** A fresh, uniform 6-digit code for the phone to show. */
export const newEnrollCode = (): string => newSecret();

/** `482913` → `482 913`. */
export const formatEnrollCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;
/** Kept for callers of the P10 name. */
export const formatSas = formatEnrollCode;

/** `482 913`, `482-913` → `482913`; undefined when it is not 6 digits. */
export function parseEnrollCode(input: string): string | undefined {
  const d = input.replace(/[\s\-–·.]/g, "");
  return /^\d{6}$/.test(d) ? d : undefined;
}

const saltOf = (mailbox: string, n: Uint8Array) => `enroll|${mailbox}|${toB64u(n)}`;

const authLabel = (tt: Uint8Array, mailbox: string, pub: Uint8Array, who: "core" | "device") =>
  framed(utf8("alca-link/v2 enroll"), tt, utf8(mailbox), pub, utf8(who));

function failOf(m: WireMessage): LinkError | undefined {
  if (m.t !== "fail") return undefined;
  const code = typeof m.code === "string" ? (m.code as LinkErrorCode) : "refused";
  return new LinkError(code, typeof m.message === "string" ? m.message : code);
}

/** Next message before `deadline`; running out of time is `expired`, not a transport timeout. */
async function recvBy(wire: Wire, deadline: number, capMs = Number.POSITIVE_INFINITY): Promise<WireMessage> {
  const ms = Math.min(capMs, left(deadline));
  try {
    return await wire.recv(Math.max(1, ms));
  } catch (e) {
    if (e instanceof LinkError && e.code === "timeout" && Date.now() >= deadline - 5)
      throw new LinkError("expired", "the code expired");
    throw e;
  }
}

async function expect(wire: Wire, t: string, deadline: number, capMs?: number): Promise<WireMessage> {
  const m = await recvBy(wire, deadline, capMs);
  const f = failOf(m);
  if (f) throw f;
  if (m.t !== t) throw new LinkError("protocol", `expected ${t}, got ${String(m.t)}`);
  return m;
}

const fail = (wire: Wire, code: LinkErrorCode, message?: string) => {
  wire.send({ t: "fail", code, ...(message ? { message } : {}) });
  wire.close(code);
};

const left = (deadline: number) => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new LinkError("expired", "the code expired");
  return ms;
};

export interface EnrollResult {
  deviceId: string;
  corePublicRaw: Bytes;
  coreFingerprint: string;
  mailbox: string;
  scopes: string[];
  coreName: string;
  pake: number;
}

/** What the device hears after each try the computer rejected. */
export interface EnrollAttempt {
  /** Tries still allowed. */
  left: number;
  /** The new code to show: the rejected one is never used again (G1). */
  code: string;
}

/**
 * Device side. Show `code` (formatEnrollCode) before calling; the promise
 * settles when the person typed it on the computer (`wrong_code` after the
 * last wrong try, `expired` after `ttlMs`, `denied` if they cancelled there).
 */
export async function enrollAsDevice(
  wire: Wire,
  o: {
    mailbox: string;
    identity: Identity;
    device: DeviceInfo;
    /** The 6 digits shown on this device. */
    code: string;
    /** The fingerprint the relay listed (a consistency check; the PAKE is what authenticates). */
    expectFingerprint?: string;
    /** A try was wrong; `left` more are allowed. */
    onWrong?(a: EnrollAttempt): void;
    maxTries?: number;
    ttlMs?: number;
  },
): Promise<EnrollResult> {
  const max = o.maxTries ?? ENROLL_MAX_TRIES;
  const deadline = Date.now() + (o.ttlMs ?? ENROLL_TTL_MS);
  if (!parseEnrollCode(o.code)) throw new LinkError("malformed", "the code must be 6 digits");
  let code = o.code;
  const offered = [...PAKE_SUPPORTED];
  try {
    for (let attempt = 1; ; attempt++) {
      const n = randomBytes(16);
      const salt = saltOf(o.mailbox, n);
      const st2 = spake2Start("A", await passwordScalarV2(code, salt));
      wire.send({ t: "enroll1", v: LINK_VERSION, n: toB64u(n), pk: offered, share2: toB64u(st2.share) });
      const m2 = await expect(wire, "enroll2", deadline);
      if (m2.pk !== PAKE_V2) {
        // A pre-G1 computer (v1 only), or someone stripping v2: either way, stop.
        fail(wire, "downgrade");
        throw new LinkError(
          "downgrade",
          "the computer answered with pairing v1, which is no longer supported",
        );
      }
      const pake = PAKE_V2;
      const pub = o.identity.publicRaw;
      const aad = pakeAad({ purpose: "enroll", context: salt, offered, chosen: PAKE_V2 });
      const r = await spake2Finish(st2, fromB64u(str(m2, "share")), aad);
      const tt = r.tt;
      const ch = await SecureChannel.create(
        await deriveChannelKeys(r.ke, new Uint8Array(0), "alca-link/v2 enroll keys", "device"),
      );
      wire.send({ t: "enroll3", c: toB64u(r.confirm) });
      const m3 = await recvBy(wire, deadline);
      const f3 = failOf(m3);
      if (f3) throw f3;
      let m4: WireMessage;
      if (m3.t !== "enroll.again") {
        // Only after the computer proved the code does anything of ours go out sealed.
        if (m3.t !== "f" || typeof m3.d !== "string") throw new LinkError("protocol", "expected enroll.ok");
        let ok: Record<string, unknown>;
        try {
          const v = await ch.open(m3.d);
          ok = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
        } catch {
          throw new LinkError("tampered", "the computer's answer did not open");
        }
        if (ok.k !== "enroll.ok" || typeof ok.c !== "string" || !(await r.verifyPeer(fromB64u(ok.c)))) {
          fail(wire, "wrong_code");
          throw new LinkError("wrong_code", "the computer's key confirmation did not verify");
        }
        await sendSealed(wire, ch, {
          k: "enroll.device",
          pub: toB64u(pub),
          sig: toB64u(await sign(o.identity, authLabel(tt, o.mailbox, pub, "device"))),
          ...o.device,
        });
        m4 = await recvBy(wire, deadline);
      } else m4 = m3;
      const f = failOf(m4);
      if (f) throw f;
      if (m4.t === "enroll.again") {
        // Unauthenticated, so it can only cost us a try, never let anything in.
        if (attempt >= max) {
          fail(wire, "wrong_code");
          throw new LinkError("wrong_code", "too many wrong tries");
        }
        // The rejected code is spent: show a new one.
        code = newEnrollCode();
        o.onWrong?.({ left: max - attempt, code });
        continue;
      }
      if (m4.t !== "f" || typeof m4.d !== "string") throw new LinkError("protocol", "expected enroll.done");
      let done: Record<string, unknown>;
      try {
        const v = await ch.open(m4.d);
        done = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
      } catch {
        throw new LinkError("tampered", "the computer's answer did not open");
      }
      if (done.k === "enroll.refused") throw new LinkError("denied", String(done.reason ?? "denied"));
      if (done.k !== "enroll.done") throw new LinkError("protocol", "expected enroll.done");
      const corePub = fromB64u(str(done, "pub"));
      const coreFp = await fingerprint(corePub);
      if ((await mailboxOf(corePub)) !== o.mailbox || str(done, "mailbox") !== o.mailbox)
        throw new LinkError("fingerprint_mismatch", "the computer's key does not own this mailbox");
      if (o.expectFingerprint && o.expectFingerprint !== coreFp)
        throw new LinkError("fingerprint_mismatch", "the computer's key is not the one listed");
      await assertSignature(corePub, fromB64u(str(done, "sig")), authLabel(tt, o.mailbox, corePub, "core"));
      ch.close();
      return {
        deviceId: str(done, "deviceId"),
        corePublicRaw: corePub,
        coreFingerprint: coreFp,
        mailbox: o.mailbox,
        scopes: Array.isArray(done.scopes) ? done.scopes.filter((s) => typeof s === "string") : [],
        coreName: typeof done.coreName === "string" ? done.coreName : "Alca",
        pake,
      };
    }
  } finally {
    wire.close("enrolled");
  }
}

/** What the computer's sheet is asked for on each try. */
export interface CodeRequest {
  /** 1 for the first try. */
  attempt: number;
  /** Tries left, this one included. */
  left: number;
  /** The previous try was wrong. */
  wrong: boolean;
  /** When the sheet stops taking the code (ms since the epoch). */
  expiresAt: number;
}

/** Computer side, per new-device channel: ask the person for the code, store the device. */
export interface EnrollHandler {
  /** Show 「輸入手機上的驗證碼」; resolve with what they typed, reject to refuse. */
  askCode(r: CodeRequest): Promise<string>;
  /** The code was right and the phone proved its key: store it (no further prompt). */
  accept(d: PairedDevice): Promise<{ deviceId: string; scopes: string[] }>;
  /** The channel is over (`ok` = a device was stored). */
  end?(r: { ok: boolean; error?: LinkErrorCode; device?: PairedDevice }): void;
}

/** Core side. */
export async function enrollAsCore(
  wire: Wire,
  o: {
    identity: Identity;
    mailbox: string;
    coreName: string;
    handler: EnrollHandler;
    maxTries?: number;
    ttlMs?: number;
    /** Called once per try with the PAKE version (audit log / UI). */
    onPake?(version: number): void;
  },
): Promise<PairedDevice & { deviceId: string; pake: number }> {
  const max = o.maxTries ?? ENROLL_MAX_TRIES;
  const deadline = Date.now() + (o.ttlMs ?? ENROLL_TTL_MS);
  let result: (PairedDevice & { deviceId: string; pake: number }) | undefined;
  let error: LinkErrorCode | undefined;
  try {
    for (let attempt = 1; ; attempt++) {
      const m1 = await expect(wire, "enroll1", deadline, attempt === 1 ? 20_000 : undefined);
      if (m1.v !== LINK_VERSION) {
        fail(wire, "protocol");
        throw new LinkError("protocol", "unsupported link version");
      }
      const n = fromB64u(str(m1, "n"));
      if (n.length !== 16) throw new LinkError("malformed", "bad nonce");
      // A pre-G1 phone offers no `pk` (v1 only): refused before the code is asked for.
      const pake = choosePake(m1.pk);
      if (pake === undefined) {
        fail(wire, "upgrade_required", UPGRADE_MESSAGE);
        throw new LinkError("upgrade_required", "the phone offered only pairing v1, which was removed");
      }
      o.onPake?.(pake);
      let typed: string;
      try {
        typed = await race(
          o.handler.askCode({ attempt, left: max - attempt + 1, wrong: attempt > 1, expiresAt: deadline }),
          left(deadline),
          wire,
        );
      } catch (e) {
        const code: LinkErrorCode = e instanceof LinkError ? e.code : "denied";
        if (!wire.closed) fail(wire, code);
        throw e instanceof LinkError ? e : new LinkError("denied", "cancelled on the computer");
      }
      const code = parseEnrollCode(typed) ?? "";
      const salt = saltOf(o.mailbox, n);
      const offered = Array.isArray(m1.pk) ? m1.pk.filter((x): x is number => Number.isInteger(x)) : [];
      const st = spake2Start("B", await passwordScalarV2(code || "x", salt));
      const aad = pakeAad({ purpose: "enroll", context: salt, offered, chosen: PAKE_V2 });
      const r = await spake2Finish(st, fromB64u(str(m1, "share2")), aad);
      wire.send({ t: "enroll2", pk: PAKE_V2, share: toB64u(st.share) });
      // Nothing keyed by K leaves before the phone proved the code.
      const m3 = await expect(wire, "enroll3", deadline, left(deadline));
      if (!(await r.verifyPeer(fromB64u(str(m3, "c"))))) {
        if (attempt >= max) {
          fail(wire, "wrong_code");
          throw new LinkError("wrong_code", "too many wrong tries");
        }
        wire.send({ t: "enroll.again", left: max - attempt });
        continue;
      }
      const tt = r.tt;
      const ch = await SecureChannel.create(
        await deriveChannelKeys(r.ke, new Uint8Array(0), "alca-link/v2 enroll keys", "core"),
      );
      await sendSealed(wire, ch, { k: "enroll.ok", c: toB64u(r.confirm) });
      const body = await recvSealed(wire, ch, "tampered", left(deadline));
      if (body.k !== "enroll.device") throw new LinkError("protocol", "expected enroll.device");
      const pub = fromB64u(str(body, "pub"));
      try {
        await assertSignature(pub, fromB64u(str(body, "sig")), authLabel(tt, o.mailbox, pub, "device"));
      } catch (e) {
        fail(wire, "bad_signature");
        throw e;
      }
      const kind: DeviceKind = body.kind === "hands" ? "hands" : "phone";
      const device: PairedDevice = {
        name: (typeof body.name === "string" ? body.name : "").slice(0, 60) || "裝置",
        kind,
        platform: typeof body.platform === "string" ? body.platform.slice(0, 80) : "",
        publicRaw: pub,
        fingerprint: await fingerprint(pub),
      };
      let accepted: { deviceId: string; scopes: string[] };
      try {
        accepted = await o.handler.accept(device);
      } catch (e) {
        await sendSealed(wire, ch, {
          k: "enroll.refused",
          reason: e instanceof Error ? e.message : "refused",
        });
        throw new LinkError("refused", e instanceof Error ? e.message : "refused");
      }
      const me = o.identity.publicRaw;
      await sendSealed(wire, ch, {
        k: "enroll.done",
        pub: toB64u(me),
        sig: toB64u(await sign(o.identity, authLabel(tt, o.mailbox, me, "core"))),
        ...accepted,
        mailbox: o.mailbox,
        coreName: o.coreName,
      });
      result = { ...device, deviceId: accepted.deviceId, pake };
      return result;
    }
  } catch (e) {
    error = e instanceof LinkError ? e.code : "protocol";
    throw e;
  } finally {
    o.handler.end?.({
      ok: !!result,
      ...(error ? { error } : {}),
      ...(result ? { device: result } : {}),
    });
    setTimeout(() => wire.close("enrolled"), 50);
  }
}

/** The person's answer, unless the code expires or the phone goes away first. */
function race<T>(p: Promise<T>, ms: number, wire: Wire): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new LinkError("expired", "the code expired")), ms);
    wire.onClose(() => reject(new LinkError("closed", "the phone went away")));
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
