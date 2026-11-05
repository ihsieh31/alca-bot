import { generateVapidKey, vapidPublicKey } from "@alca/push";
import { startMockPushService } from "@alca/push/testing";
import type { PushSubscriptionRecord, Store } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { PushNotifier } from "../src/push.ts";

/**
 * B8: after a revoke the core never pushes to that phone — not a new card,
 * and not a retry that was scheduled before the revoke. The store here does
 * NOT drop the subscription on revoke (the real one does, by trigger), so the
 * notifier's own check is what is tested.
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function setup() {
  const mock = await startMockPushService();
  closers.push(() => mock.close());
  const vapid = generateVapidKey();
  const sub = mock.subscribe(vapidPublicKey(vapid));
  const devices = new Map([["dev_1", { id: "dev_1", revokedAt: null as string | null }]]);
  const rec: PushSubscriptionRecord = {
    id: "sub_1",
    deviceId: "dev_1",
    endpoint: sub.endpoint,
    keys: sub.keys,
    userAgent: "",
    createdAt: new Date().toISOString(),
    lastSentAt: null,
    lastStatus: null,
    failures: 0,
  };
  const store = {
    devices: { get: (id: string) => devices.get(id) },
    push: {
      // Like the real live(): only devices that are not revoked.
      live: () => (devices.get("dev_1")?.revokedAt ? [] : [rec]),
      get: () => rec,
      record: () => undefined,
      remove: () => true,
      removeForDevice: () => 1,
      forDevice: () => [rec],
    },
  } as unknown as Store;
  const n = new PushNotifier({
    core: {} as never,
    store,
    vapid,
    allowEndpoint: (e) => e.startsWith(mock.url),
    retrySec: 0.05,
  });
  closers.push(() => n.close());
  const revoke = () => {
    const d = devices.get("dev_1");
    if (d) d.revokedAt = "now";
  };
  return { mock, n, revoke };
}

describe("Web Push after a revoke (B8)", () => {
  it("a retry scheduled before the revoke is not sent after it", async () => {
    const { mock, n, revoke } = await setup();
    mock.failNext(503, 1);
    const r = await n.notify("approval", "apv_1");
    expect(r[0]?.outcome).toBe("retry");
    revoke();
    await new Promise((x) => setTimeout(x, 250));
    expect(mock.received).toHaveLength(0);
  });

  it("a card after the revoke sends nothing; before it, one push", async () => {
    const { mock, n, revoke } = await setup();
    expect((await n.notify("approval", "apv_1"))[0]?.outcome).toBe("sent");
    expect(mock.received).toHaveLength(1);
    revoke();
    expect(await n.notify("approval", "apv_2")).toEqual([]);
    expect(mock.received).toHaveLength(1);
  });
});
