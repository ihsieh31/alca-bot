// Sealed frames: AES-256-GCM, one key per direction, a 64-bit counter per
// direction used as the nonce. The receiver accepts exactly the next counter:
// a replayed, dropped or reordered frame closes the channel (the transports
// are ordered, so any gap means tampering). The header is authenticated.
//
//   frame = 0x01 ‖ counter (8 bytes, big-endian) ‖ AES-GCM(ciphertext ‖ tag)
//   nonce = 0x00000000 ‖ counter      aad = 0x01 ‖ counter ‖ sessionId (16 bytes)
import { type Bytes, concat, fromB64u, fromUtf8, hkdf, type Key, subtle, toB64u, utf8 } from "./bytes.ts";
import { LinkError } from "./errors.ts";

const VERSION = 1;
const MAX_COUNTER = 2 ** 48;

export interface ChannelKeys {
  sendKey: Bytes;
  recvKey: Bytes;
  sessionId: Bytes;
}

/** Split 64 bytes of key material into the two direction keys (initiator = device). */
export async function deriveChannelKeys(
  secret: Uint8Array,
  salt: Uint8Array,
  label: string,
  side: "core" | "device",
): Promise<ChannelKeys> {
  const okm = await hkdf(secret, salt, label, 80);
  const d2c = okm.subarray(0, 32) as Bytes;
  const c2d = okm.subarray(32, 64) as Bytes;
  const sessionId = okm.subarray(64, 80) as Bytes;
  return side === "core"
    ? { sendKey: d2c, recvKey: c2d, sessionId }
    : { sendKey: c2d, recvKey: d2c, sessionId };
}

function header(counter: number): Bytes {
  const h = new Uint8Array(9);
  h[0] = VERSION;
  const dv = new DataView(h.buffer);
  dv.setUint32(1, Math.floor(counter / 2 ** 32));
  dv.setUint32(5, counter >>> 0);
  return h;
}

function nonce(counter: number): Bytes {
  const n = new Uint8Array(12);
  n.set(header(counter).subarray(1), 4);
  return n;
}

export class SecureChannel {
  readonly sessionId: Bytes;
  private sendCounter = 0;
  private recvCounter = 0;
  private broken: LinkError | undefined;
  private sealChain: Promise<unknown> = Promise.resolve();
  private openChain: Promise<unknown> = Promise.resolve();

  private readonly sendKey: Key;
  private readonly recvKey: Key;

  private constructor(sendKey: Key, recvKey: Key, sessionId: Bytes) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sessionId = sessionId;
  }

  static async create(k: ChannelKeys): Promise<SecureChannel> {
    const imp = (raw: Bytes, use: "encrypt" | "decrypt") =>
      subtle().importKey("raw", raw, { name: "AES-GCM" }, false, [use]);
    return new SecureChannel(await imp(k.sendKey, "encrypt"), await imp(k.recvKey, "decrypt"), k.sessionId);
  }

  get failed(): LinkError | undefined {
    return this.broken;
  }

  /** Encrypt one message. Results resolve in call order (counter order). */
  seal(message: unknown): Promise<string> {
    if (this.broken) return Promise.reject(this.broken);
    const counter = this.sendCounter++;
    if (counter >= MAX_COUNTER) return Promise.reject(new LinkError("closed", "counter exhausted"));
    const body = utf8(JSON.stringify(message));
    const run = async () => {
      const h = header(counter);
      const ct = await subtle().encrypt(
        { name: "AES-GCM", iv: nonce(counter), additionalData: concat(h, this.sessionId) },
        this.sendKey,
        body,
      );
      return toB64u(concat(h, new Uint8Array(ct)));
    };
    const p = this.sealChain.then(run, run);
    this.sealChain = p;
    return p;
  }

  /** Decrypt one frame. Anything but the next counter, or a bad tag, breaks the channel for good. */
  open(frame: string): Promise<unknown> {
    if (this.broken) return Promise.reject(this.broken);
    let raw: Bytes;
    try {
      raw = fromB64u(frame);
    } catch {
      return Promise.reject(this.fail(new LinkError("malformed", "frame is not base64url")));
    }
    if (raw.length < 9 + 16 || raw[0] !== VERSION)
      return Promise.reject(this.fail(new LinkError("malformed", "bad frame header")));
    const dv = new DataView(raw.buffer, raw.byteOffset, 9);
    const counter = dv.getUint32(1) * 2 ** 32 + dv.getUint32(5);
    const want = this.recvCounter;
    if (counter < want)
      return Promise.reject(this.fail(new LinkError("replay", `frame ${counter} replayed`)));
    if (counter > want)
      return Promise.reject(this.fail(new LinkError("out_of_order", `frame ${counter}, expected ${want}`)));
    this.recvCounter++;
    const run = async () => {
      if (this.broken) throw this.broken;
      let pt: ArrayBuffer;
      try {
        pt = await subtle().decrypt(
          { name: "AES-GCM", iv: nonce(counter), additionalData: concat(raw.subarray(0, 9), this.sessionId) },
          this.recvKey,
          raw.subarray(9),
        );
      } catch {
        throw this.fail(new LinkError("tampered", "authentication tag mismatch"));
      }
      try {
        return JSON.parse(fromUtf8(new Uint8Array(pt))) as unknown;
      } catch {
        throw this.fail(new LinkError("malformed", "frame body is not JSON"));
      }
    };
    const p = this.openChain.then(run, run);
    this.openChain = p.catch(() => undefined);
    return p;
  }

  close(): void {
    this.broken ??= new LinkError("closed", "channel closed");
  }

  private fail(e: LinkError): LinkError {
    this.broken ??= e;
    return e;
  }
}
