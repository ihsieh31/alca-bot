// Device side of the Google-account path (P10): list the computers registered
// under the signed-in Google account, and enroll this device with one of them
// (// computer). Since P12 the phone shows a 6-digit code the person types on
// the computer (a SPAKE2 password, see enroll.ts). Browser-safe: WebSocket + WebCrypto only.
import { toB64u } from "./bytes.ts";
import type { LinkCredentials } from "./client.ts";
import { type EnrollAttempt, enrollAsDevice } from "./enroll.ts";
import { LinkError } from "./errors.ts";
import type { DeviceInfo } from "./handshake.ts";
import type { Identity } from "./identity.ts";
import { type ComputerListing, RELAY_VERSION, relayWsUrl } from "./relay-protocol.ts";
import { defaultWebSocket, openDeviceWire, type WebSocketCtor, type WebSocketLike } from "./transport.ts";
import type { WireMessage } from "./wire.ts";

const RELAY_ERRORS: Record<string, LinkError["code"]> = {
  bad_token: "bad_token",
  rate_limited: "rate_limited",
  not_enabled: "relay",
};

/** The computers this Google account registered on the relay (one-shot request). */
export function listComputers(
  relayUrl: string,
  idToken: string,
  o: { WebSocketImpl?: WebSocketCtor; timeoutMs?: number } = {},
): Promise<ComputerListing[]> {
  const url = relayWsUrl(relayUrl);
  return new Promise((resolve, reject) => {
    let ws: WebSocketLike;
    try {
      ws = new (o.WebSocketImpl ?? defaultWebSocket())(url);
    } catch (e) {
      return reject(new LinkError("offline", e instanceof Error ? e.message : "cannot connect"));
    }
    let done = false;
    const finish = (err: LinkError | undefined, v?: ComputerListing[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(v ?? []);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
    const timer = setTimeout(
      () => finish(new LinkError("timeout", "relay did not answer")),
      o.timeoutMs ?? 10_000,
    );
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ op: "computers.list", v: RELAY_VERSION, idToken })),
    );
    ws.addEventListener("message", (ev) => {
      let m: WireMessage;
      try {
        m = JSON.parse(String(ev.data)) as WireMessage;
      } catch {
        return;
      }
      if (m.op === "computers" && Array.isArray(m.computers)) return finish(undefined, sanitize(m.computers));
      if (m.op === "error")
        finish(new LinkError(RELAY_ERRORS[String(m.code)] ?? "relay", String(m.message ?? m.code)));
    });
    ws.addEventListener("close", (ev) => finish(new LinkError("offline", ev.reason || "connection closed")));
    ws.addEventListener("error", () => undefined);
  });
}

function sanitize(list: unknown[]): ComputerListing[] {
  const out: ComputerListing[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const c = x as Record<string, unknown>;
    if (typeof c.mailbox !== "string" || typeof c.fingerprint !== "string") continue;
    out.push({
      mailbox: c.mailbox,
      name: typeof c.name === "string" ? c.name.slice(0, 60) : "電腦",
      fingerprint: c.fingerprint,
      registeredAt: typeof c.registeredAt === "string" ? c.registeredAt : "",
      lastSeen: typeof c.lastSeen === "string" ? c.lastSeen : "",
      online: c.online === true,
    });
  }
  return out;
}

/**
 * Enroll with one computer: the relay checks the Google token owns that
 * computer and opens a channel; show `code` on the phone; resolves with
 * ordinary credentials once the person typed it on the computer. Every later
 * connection is a plain `dial` with the device key — no token, no prompt.
 */
export async function enrollDevice(o: {
  relayUrl: string;
  computer: Pick<ComputerListing, "mailbox" | "fingerprint">;
  idToken: string;
  identity: Identity;
  device: DeviceInfo;
  /** The 6 digits shown on the phone (newEnrollCode()). */
  code: string;
  onWrong?(a: EnrollAttempt): void;
  WebSocketImpl?: WebSocketCtor;
  ttlMs?: number;
  maxTries?: number;
}): Promise<LinkCredentials & { pake: number }> {
  const relayUrl = relayWsUrl(o.relayUrl);
  const wire = await openDeviceWire(
    relayUrl,
    { op: "connect", mailbox: o.computer.mailbox, idToken: o.idToken },
    o.WebSocketImpl ? { WebSocketImpl: o.WebSocketImpl } : {},
  );
  const r = await enrollAsDevice(wire, {
    mailbox: o.computer.mailbox,
    identity: o.identity,
    device: o.device,
    code: o.code,
    expectFingerprint: o.computer.fingerprint,
    ...(o.onWrong ? { onWrong: o.onWrong } : {}),
    ...(o.ttlMs ? { ttlMs: o.ttlMs } : {}),
    ...(o.maxTries ? { maxTries: o.maxTries } : {}),
  });
  return {
    relayUrl,
    mailbox: r.mailbox,
    corePublicKey: toB64u(r.corePublicRaw),
    coreFingerprint: r.coreFingerprint,
    coreName: r.coreName,
    deviceId: r.deviceId,
    scopes: r.scopes,
    pake: r.pake,
  };
}
