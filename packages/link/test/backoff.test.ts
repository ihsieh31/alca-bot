import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RETRY_MS,
  generateIdentity,
  jittered,
  LinkClient,
  LinkHost,
  MAX_RETRY_MS,
  nextRetry,
  type WebSocketCtor,
} from "../src/index.ts";

afterEach(() => vi.restoreAllMocks());

/** A WebSocket that cannot even be constructed: every attempt fails at once and is timed. */
function failing(at: number[]): WebSocketCtor {
  return class {
    constructor() {
      at.push(performance.now());
      throw new Error("relay down");
    }
  } as unknown as WebSocketCtor;
}

const gaps = (at: number[]) => at.slice(1).map((t, i) => t - (at[i] as number));

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("reconnect backoff (PERF-2026-11 patch 03)", () => {
  it("jitters ±20 % and doubles up to the cap", () => {
    expect(jittered(1000, () => 0)).toBe(800);
    expect(jittered(1000, () => 0.5)).toBe(1000);
    expect(jittered(1000, () => 0.999_999)).toBe(1200);
    let ms = FIRST_RETRY_MS;
    const steps: number[] = [];
    for (let i = 0; i < 10; i++) {
      steps.push(ms);
      ms = nextRetry(ms);
    }
    expect(steps.slice(0, 4)).toEqual([250, 500, 1000, 2000]);
    expect(steps.at(-1)).toBe(MAX_RETRY_MS);
    expect(nextRetry(MAX_RETRY_MS)).toBe(MAX_RETRY_MS);
    expect(nextRetry(400, 600)).toBe(600);
  });

  it("the core's host retries first after ~250 ms (was 1 s), then doubles", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: exact steps
    const at: number[] = [];
    const host = new LinkHost({
      relayUrl: "ws://127.0.0.1:9",
      identity: await generateIdentity(),
      coreName: "test",
      devices: { get: () => undefined, add: () => ({}) as never, seen: () => undefined },
      onSession: () => undefined,
      WebSocketImpl: failing(at),
      selfCheckMs: 0,
    });
    void host.start(0);
    await until(() => at.length >= 4);
    await host.close();
    const [a, b, c] = gaps(at);
    expect(a).toBeGreaterThanOrEqual(240);
    expect(a).toBeLessThan(600);
    expect(b).toBeGreaterThanOrEqual(490);
    expect(c).toBeGreaterThanOrEqual(990);
  }, 10_000);

  it("the host's waits carry jitter", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // −20 %
    const at: number[] = [];
    const host = new LinkHost({
      relayUrl: "ws://127.0.0.1:9",
      identity: await generateIdentity(),
      coreName: "test",
      devices: { get: () => undefined, add: () => ({}) as never, seen: () => undefined },
      onSession: () => undefined,
      WebSocketImpl: failing(at),
      selfCheckMs: 0,
      backoff: { first: 1000, max: 1000 },
    });
    void host.start(0);
    await until(() => at.length >= 3);
    await host.close();
    for (const g of gaps(at)) {
      expect(g).toBeGreaterThanOrEqual(790);
      expect(g).toBeLessThan(960); // 800 ms, not 1000
    }
  }, 10_000);

  it("the phone's client (shared packages/link code) also starts at ~250 ms", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const at: number[] = [];
    const client = new LinkClient({
      credentials: {
        relayUrl: "ws://127.0.0.1:9",
        mailbox: "m",
        corePublicKey: "AA",
        coreFingerprint: "f",
        coreName: "test",
        deviceId: "dev_x",
        scopes: [],
      },
      identity: await generateIdentity(),
      WebSocketImpl: failing(at),
      pingSec: 0,
    });
    client.start();
    await until(() => at.length >= 3);
    client.stop();
    const [a, b] = gaps(at);
    expect(a).toBeGreaterThanOrEqual(240);
    expect(a).toBeLessThan(600);
    expect(b).toBeGreaterThanOrEqual(490);
    expect(b).toBeLessThan(900);
  }, 10_000);
});
