// Deliver one push message to a subscription's push service (RFC 8030 §5):
// POST the encrypted body with TTL / Urgency, signed with VAPID. The core
// talks to the push service directly; no Alca server is involved.
import { encryptPayload, type SubscriptionKeys } from "./ece.ts";
import { type VapidJwk, vapidAuthorization } from "./vapid.ts";

/**
 * What a push may say: a type and an opaque id, nothing else. The phone shows
 * a fixed local sentence for the type and fetches the details over Link after
 * it is opened.
 */
export const PUSH_KINDS = ["approval", "question", "handoff", "offer", "test"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export interface PushPayload {
  /** Format version. */
  v: 1;
  t: PushKind;
  /** Opaque id (apv_… / qst_… / hof_… / ofr_… / a random test id). */
  id: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Build the payload; refuses anything that is not a known type and a short opaque id. */
export function pushPayload(t: PushKind, id: string): PushPayload {
  if (!PUSH_KINDS.includes(t)) throw new Error(`unknown push kind: ${t}`);
  if (!ID.test(id)) throw new Error("push id must be an opaque token");
  return { v: 1, t, id };
}

export interface PushTarget {
  endpoint: string;
  keys: SubscriptionKeys;
}

export type DeliveryResult =
  | { outcome: "sent"; status: number }
  /** 404 / 410: the subscription is gone; forget it. */
  | { outcome: "gone"; status: number }
  /** 429 / 5xx / network: try again later. */
  | { outcome: "retry"; status: number; retryAfterSec?: number; error?: string }
  /** 400 / 401 / 403 / 413 …: our request was refused. */
  | { outcome: "rejected"; status: number; error?: string };

/** Known browser push services (all https). A subscription elsewhere is refused unless allowed. */
export const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
];

export function knownPushService(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
}

export interface SenderOptions {
  vapid: () => VapidJwk;
  /** VAPID contact (mailto: or https:). */
  contact: string;
  fetch?: typeof fetch;
  /** Allow an endpoint outside the known push services (tests: a loopback mock). */
  allowEndpoint?: (endpoint: string) => boolean;
  now?: () => number;
  /** Seconds a push service keeps an undelivered message (default 1 day). */
  ttlSec?: number;
  timeoutMs?: number;
}

export class PushSender {
  private readonly o: SenderOptions;
  private readonly jwts = new Map<string, { header: string; exp: number }>();

  constructor(o: SenderOptions) {
    if (!/^(mailto:|https:)/.test(o.contact)) throw new Error("VAPID contact must be mailto: or https:");
    this.o = o;
  }

  endpointAllowed(endpoint: string): boolean {
    return knownPushService(endpoint) || (this.o.allowEndpoint?.(endpoint) ?? false);
  }

  /** One Authorization header per push-service origin, reused until an hour before it expires. */
  authorization(endpoint: string): string {
    const aud = new URL(endpoint).origin;
    const now = Math.floor((this.o.now?.() ?? Date.now()) / 1000);
    const hit = this.jwts.get(aud);
    if (hit && hit.exp - 3600 > now) return hit.header;
    const exp = now + 12 * 3600;
    const header = vapidAuthorization(this.o.vapid(), { aud, exp, sub: this.o.contact });
    this.jwts.set(aud, { header, exp });
    return header;
  }

  async send(
    target: PushTarget,
    payload: PushPayload,
    urgency: "high" | "normal" = "high",
  ): Promise<DeliveryResult> {
    if (!this.endpointAllowed(target.endpoint))
      return { outcome: "rejected", status: 0, error: "not a known push service" };
    const body = encryptPayload(new TextEncoder().encode(JSON.stringify(payload)), target.keys);
    const f = this.o.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(target.endpoint, {
        method: "POST",
        headers: {
          TTL: String(this.o.ttlSec ?? 86_400),
          Urgency: urgency,
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "aes128gcm",
          Authorization: this.authorization(target.endpoint),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      return { outcome: "retry", status: 0, error: (e as Error).message };
    }
    const status = res.status;
    const text = status >= 300 ? (await res.text().catch(() => "")).slice(0, 200) : "";
    if (status >= 200 && status < 300) return { outcome: "sent", status };
    if (status === 404 || status === 410) return { outcome: "gone", status };
    if (status === 429 || status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      return { outcome: "retry", status, ...(ra > 0 ? { retryAfterSec: ra } : {}), error: text };
    }
    return { outcome: "rejected", status, error: text };
  }
}
