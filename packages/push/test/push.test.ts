import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  b64u,
  checkKeys,
  decryptPayload,
  encryptPayload,
  fromB64u,
  generateVapidKey,
  knownPushService,
  PushKeyError,
  PushSender,
  pushPayload,
  vapidJwt,
  vapidPublicKey,
  verifyVapid,
} from "../src/index.ts";
import { type MockPushService, startMockPushService } from "../testing/mock-push-service.ts";

// RFC 8291 §5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("aes128gcm message encryption (RFC 8291)", () => {
  it("reproduces the RFC 8291 example byte for byte", () => {
    const out = encryptPayload(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: fromB64u(RFC.salt), senderPrivateKey: fromB64u(RFC.asPrivate) },
    );
    expect(b64u(out)).toBe(RFC.body);
    // 86-byte header + 41 + 1 + 16 (the example request says 145; the body it shows is 144 bytes).
    expect(out.length).toBe(144);
  });

  it("decrypts the RFC example as the user agent", () => {
    const pt = decryptPayload(fromB64u(RFC.body), fromB64u(RFC.uaPrivate), fromB64u(RFC.auth));
    expect(pt.toString()).toBe(RFC.plaintext);
  });

  it("uses a fresh salt and sender key each time; a changed byte fails", () => {
    const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
    const a = encryptPayload(Buffer.from("x"), keys);
    const b = encryptPayload(Buffer.from("x"), keys);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
    expect(a.readUInt32BE(16)).toBe(4096);
    expect(a[20]).toBe(65);
    const bad = Buffer.from(a);
    bad[bad.length - 20] = (bad[bad.length - 20] ?? 0) ^ 1;
    expect(() => decryptPayload(bad, fromB64u(RFC.uaPrivate), fromB64u(RFC.auth))).toThrow();
  });

  it("refuses keys that are not a P-256 point or a 16-byte secret", () => {
    const off = Buffer.from(fromB64u(RFC.uaPublic));
    off[64] = (off[64] ?? 0) ^ 1; // y no longer on the curve
    expect(() => checkKeys({ p256dh: b64u(off), auth: RFC.auth })).toThrow(PushKeyError);
    expect(() => checkKeys({ p256dh: RFC.uaPublic, auth: "AAAA" })).toThrow(PushKeyError);
    expect(() => encryptPayload(Buffer.alloc(4000), { p256dh: RFC.uaPublic, auth: RFC.auth })).toThrow(
      /3993/,
    );
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs an ES256 JWT that verifies against k=", () => {
    const k = generateVapidKey();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = vapidJwt(k, { aud: "https://fcm.googleapis.com", exp, sub: "https://example.com" });
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(fromB64u(h ?? "").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(fromB64u(p ?? "").toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp,
      sub: "https://example.com",
    });
    expect(fromB64u(s ?? "").length).toBe(64); // raw r‖s
    const v = verifyVapid(`vapid t=${jwt}, k=${vapidPublicKey(k)}`);
    expect(v.ok).toBe(true);
    expect(fromB64u(vapidPublicKey(k)).length).toBe(65);
    // another key's k= fails
    expect(verifyVapid(`vapid t=${jwt}, k=${vapidPublicKey(generateVapidKey())}`).ok).toBe(false);
    // exp too far ahead fails
    const far = vapidJwt(k, { aud: "https://x", exp: exp + 2 * 86400, sub: "https://example.com" });
    expect(verifyVapid(`vapid t=${far}, k=${vapidPublicKey(k)}`)).toMatchObject({ ok: false });
  });
});

describe("payload and endpoints", () => {
  it("carries only a type and an opaque id", () => {
    expect(pushPayload("approval", "apv_01HX")).toEqual({ v: 1, t: "approval", id: "apv_01HX" });
    expect(() => pushPayload("approval", "付款 1200 元給小明")).toThrow();
    expect(() => pushPayload("chat" as never, "x")).toThrow();
  });

  it("knows the browser push services and nothing else", () => {
    expect(knownPushService("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(knownPushService("https://web.push.apple.com/QGx")).toBe(true);
    expect(knownPushService("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(knownPushService("https://db5p.notify.windows.com/w/?token=x")).toBe(true);
    expect(knownPushService("http://fcm.googleapis.com/x")).toBe(false);
    expect(knownPushService("https://192.168.1.1/push")).toBe(false);
    expect(knownPushService("https://evil.example/push.apple.com")).toBe(false);
    expect(knownPushService("https://push.apple.com.evil.example/x")).toBe(false);
  });
});

describe("PushSender against a mock push service", () => {
  let mock: MockPushService;
  const key = generateVapidKey();
  let sender: PushSender;
  beforeAll(async () => {
    mock = await startMockPushService();
    sender = new PushSender({
      vapid: () => key,
      contact: "https://example.com",
      allowEndpoint: (e) => e.startsWith(mock.url),
    });
  });
  afterAll(() => mock.close());

  it("delivers an encrypted, VAPID-signed message the browser can read", async () => {
    const sub = mock.subscribe(vapidPublicKey(key));
    const r = await sender.send(sub, pushPayload("approval", "apv_123"));
    expect(r).toEqual({ outcome: "sent", status: 201 });
    const got = mock.received.at(-1);
    expect(got?.payload).toEqual({ v: 1, t: "approval", id: "apv_123" });
    expect(got?.urgency).toBe("high");
    expect(got?.ttl).toBe(86400);
    expect(got?.aud).toBe(mock.url);
    expect(got?.sub).toBe("https://example.com");
  });

  it("is refused by a subscription made for another server key", async () => {
    const sub = mock.subscribe(vapidPublicKey(generateVapidKey()));
    const r = await sender.send(sub, pushPayload("test", "t1"));
    expect(r.outcome).toBe("rejected");
    expect(mock.refused.at(-1)?.status).toBe(403);
  });

  it("maps 410 to gone and 429 / 5xx to retry; refuses unknown endpoints without a request", async () => {
    const sub = mock.subscribe(vapidPublicKey(key));
    mock.failNext(503);
    expect((await sender.send(sub, pushPayload("test", "t2"))).outcome).toBe("retry");
    mock.expire(sub.endpoint);
    expect((await sender.send(sub, pushPayload("test", "t3"))).outcome).toBe("gone");
    const n = mock.received.length + mock.refused.length;
    const r = await sender.send(
      { endpoint: "https://192.168.0.10/x", keys: sub.keys },
      pushPayload("test", "t4"),
    );
    expect(r.outcome).toBe("rejected");
    expect(mock.received.length + mock.refused.length).toBe(n);
  });

  it("reuses one VAPID header per push-service origin", () => {
    const a = sender.authorization(`${mock.url}/push/a`);
    const b = sender.authorization(`${mock.url}/push/b`);
    expect(a).toBe(b);
    expect(sender.authorization("https://fcm.googleapis.com/fcm/send/x")).not.toBe(a);
  });
});
