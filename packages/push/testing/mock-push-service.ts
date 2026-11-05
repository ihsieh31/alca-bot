// A local stand-in for a browser push service plus the browser's side of
// one subscription: hands out a subscription (endpoint + p256dh + auth),
// checks each POST like a push service would (aes128gcm, TTL, VAPID JWT
// signed by the subscription's applicationServerKey, aud = our origin) and
// decrypts the body like the browser would. Tests and the e2e use it.
import { createECDH, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { b64u } from "../src/b64.ts";
import { decryptPayload } from "../src/ece.ts";
import { verifyVapid } from "../src/vapid.ts";

export interface ReceivedPush {
  subscription: string;
  ttl: number;
  urgency: string | null;
  vapidKey: string;
  aud: string;
  sub: string;
  /** Decrypted body (what the service worker's `event.data.json()` would see). */
  payload: unknown;
  /** Raw body length (the push service sees only this). */
  bodyBytes: number;
}

export interface MockSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The applicationServerKey the subscription was made with (base64url). */
  serverKey: string;
}

export interface MockPushService {
  url: string;
  received: ReceivedPush[];
  /** Every refused request and why. */
  refused: Array<{ status: number; why: string }>;
  subscribe(applicationServerKey: string): MockSubscription;
  /** Make a subscription answer 410 Gone from now on. */
  expire(endpoint: string): void;
  /** Answer the next n requests with this status. */
  failNext(status: number, n?: number): void;
  close(): Promise<void>;
}

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export async function startMockPushService(): Promise<MockPushService> {
  const subs = new Map<string, { priv: Buffer; auth: Buffer; serverKey: string; gone: boolean }>();
  const received: ReceivedPush[] = [];
  const refused: Array<{ status: number; why: string }> = [];
  let fail: { status: number; n: number } | undefined;
  let origin = "";

  const server: Server = createServer((req, res) => {
    void (async () => {
      const deny = (status: number, why: string) => {
        refused.push({ status, why });
        res.writeHead(status, { "content-type": "text/plain" }).end(why);
      };
      const body = await read(req);
      const id = (req.url ?? "").replace(/^\/push\//, "");
      const sub = subs.get(id);
      if (req.method !== "POST" || !sub) return deny(404, "no such subscription");
      if (sub.gone) return deny(410, "gone");
      if (fail && fail.n > 0) {
        fail.n--;
        return deny(fail.status, "induced failure");
      }
      if (req.headers["content-encoding"] !== "aes128gcm")
        return deny(400, "content-encoding must be aes128gcm");
      const ttl = Number(req.headers.ttl);
      if (!Number.isInteger(ttl) || ttl < 0) return deny(400, "TTL required");
      const v = verifyVapid(String(req.headers.authorization ?? ""));
      if (!v.ok) return deny(401, v.why);
      if (v.publicKey !== sub.serverKey) return deny(403, "VAPID key differs from the subscription's");
      if (v.claims.aud !== origin) return deny(403, `aud ${v.claims.aud} is not ${origin}`);
      if (body.length > 4096) return deny(413, "payload too large");
      let payload: unknown;
      try {
        payload = JSON.parse(decryptPayload(body, sub.priv, sub.auth).toString("utf8"));
      } catch (e) {
        return deny(400, `cannot decrypt: ${(e as Error).message}`);
      }
      received.push({
        subscription: id,
        ttl,
        urgency: (req.headers.urgency as string | undefined) ?? null,
        vapidKey: v.publicKey,
        aud: v.claims.aud,
        sub: v.claims.sub,
        payload,
        bodyBytes: body.length,
      });
      res.writeHead(201, { location: `/msg/${received.length}` }).end();
    })().catch((e: unknown) => res.writeHead(500).end(String(e)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    url: origin,
    received,
    refused,
    subscribe(serverKey) {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      const id = b64u(randomBytes(12));
      const auth = randomBytes(16);
      subs.set(id, { priv: ecdh.getPrivateKey(), auth, serverKey, gone: false });
      return {
        endpoint: `${origin}/push/${id}`,
        keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) },
        serverKey,
      };
    },
    expire(endpoint) {
      const s = subs.get(endpoint.split("/push/")[1] ?? "");
      if (s) s.gone = true;
    },
    failNext(status, n = 1) {
      fail = { status, n };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
