import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const P256DH = `B${"A".repeat(86)}`;
const AUTH = "A".repeat(22);

describe("push subscriptions (migration 9)", () => {
  it("belong to one device, never move, go with a revoke; the log is append-only", () => {
    const s = openStore(":memory:");
    const dev = (n: string) =>
      s.devices.add({
        name: n,
        kind: "phone",
        platform: "t",
        pubkey: n,
        keyFingerprint: `fp-${n}`,
        scopes: [],
      });
    const a = dev("a");
    const b = dev("b");
    const sub = s.push.upsert(a.id, {
      endpoint: "https://fcm.googleapis.com/fcm/send/1",
      p256dh: P256DH,
      auth: AUTH,
    });
    expect(s.push.upsert(a.id, { endpoint: sub.endpoint, p256dh: P256DH, auth: AUTH }).id).toBe(sub.id);
    expect(() => s.push.upsert(b.id, { endpoint: sub.endpoint, p256dh: P256DH, auth: AUTH })).toThrow(
      /another/,
    );
    expect(() => s.db.prepare("UPDATE push_subscriptions SET device_id = ?").run(b.id)).toThrow(/never/);
    expect(() =>
      s.push.upsert(a.id, { endpoint: "http://evil.example/x", p256dh: P256DH, auth: AUTH }),
    ).toThrow();
    s.push.record(sub, { kind: "approval", ref: "apv_1", outcome: "sent", status: 201 });
    expect(s.push.get(sub.id)?.lastStatus).toBe(201);
    expect(() => s.db.prepare("DELETE FROM push_events").run()).toThrow(/append-only/);
    expect(() =>
      s.db
        .prepare(
          "INSERT INTO push_events (at, device_id, kind, ref, outcome) VALUES ('x','y','chat','z','sent')",
        )
        .run(),
    ).toThrow();
    expect(s.push.live()).toHaveLength(1);
    s.devices.revoke(a.id);
    expect(s.push.live()).toHaveLength(0);
    expect(s.push.forDevice(a.id)).toHaveLength(0);
    expect(s.push.events()[0]).toMatchObject({ kind: "approval", ref: "apv_1" });
    s.close();
  });
});
