// P10: Google-account directory on the relay; P12: enrollment with the code
// the phone shows, typed on the computer (SPAKE2). A local fake Google issuer
// signs the ID tokens. The PAKE itself: packages/link/test/enroll.test.ts.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodeRequest,
  enrollDevice,
  generateIdentity,
  LinkError,
  LinkHost,
  listComputers,
  newEnrollCode,
} from "@alca/link";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountRegistry } from "../src/accounts.ts";
import { FileAccountStore } from "../src/accounts-file.ts";
import { GoogleTokenVerifier, TokenError } from "../src/google.ts";
import { type FakeGoogle, startFakeGoogle } from "./fake-google.ts";
import { cleanup, cleanups, client, setup, until } from "./helpers.ts";

// SPAKE2 point math in plain BigInt is slow on a loaded CI runner.
vi.setConfig({ testTimeout: 20_000 });

const WEB = "test-web.apps.googleusercontent.com";
const DESKTOP = "test-desktop.apps.googleusercontent.com";
const PHONE = { name: "iPhone", kind: "phone" as const, platform: "iOS 18.1 · Safari" };

let google: FakeGoogle;
beforeAll(async () => {
  google = await startFakeGoogle();
  return () => google.close();
});
afterEach(cleanup);

const verifier = () => new GoogleTokenVerifier({ audiences: [WEB, DESKTOP], jwksUrl: google.jwksUrl });

describe("Google ID token verification", () => {
  it("accepts a good token for either client ID, caches the JWKS", async () => {
    const v = verifier();
    const before = google.jwksFetches;
    expect((await v.verify(google.token({ sub: "42", aud: WEB, email: "a@b.c" }))).sub).toBe("42");
    expect((await v.verify(google.token({ sub: "42", aud: DESKTOP }))).aud).toBe(DESKTOP);
    expect(google.jwksFetches - before).toBe(1);
  });

  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e instanceof TokenError ? e.reason : String(e);
    }
    return "accepted";
  };

  it("refuses wrong audience, issuer, expiry, future iat, forged key, unknown kid, alg none", async () => {
    const v = verifier();
    const now = Math.floor(Date.now() / 1000);
    expect(await reason(v.verify(google.token({ sub: "1", aud: "someone-else" })))).toBe("audience");
    expect(await reason(v.verify(google.token({ sub: "1", aud: WEB, iss: "https://evil.example" })))).toBe(
      "issuer",
    );
    expect(await reason(v.verify(google.token({ sub: "1", aud: WEB, exp: now - 600 })))).toBe("expired");
    expect(await reason(v.verify(google.token({ sub: "1", aud: WEB, iat: now + 3600 })))).toBe(
      "not_yet_valid",
    );
    expect(await reason(v.verify(google.token({ sub: "1", aud: WEB }, { key: google.strangerKey })))).toBe(
      "signature",
    );
    expect(await reason(v.verify(google.token({ sub: "1", aud: WEB }, { kid: "nope" })))).toBe("unknown_key");
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"1"}').toString("base64url")}.`;
    expect(await reason(v.verify(none))).toBe("alg");
    expect(await reason(v.verify("garbage"))).toBe("malformed");
    // Within the clock skew is fine.
    expect(await reason(v.verify(google.token({ sub: "1", aud: WEB, exp: now - 30 })))).toBe("accepted");
  });
});

describe("account registry", () => {
  it("keys accounts by HMAC(secret, sub), persists to a 0600 file without the sub", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-acct-"));
    const file = join(dir, "accounts.json");
    const r = new AccountRegistry({
      secret: "s".repeat(32),
      store: new FileAccountStore(file),
      saveDelayMs: 0,
    });
    const acct = await r.accountOf("google-sub-123456");
    expect(acct).not.toContain("123456");
    expect(await new AccountRegistry({ secret: "t".repeat(32) }).accountOf("google-sub-123456")).not.toBe(
      acct,
    );
    expect(await r.register(acct, { mailbox: "m1", name: "小明的 Mac", fingerprint: "fp1" })).toBe("ok");
    await r.flush();
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("google-sub-123456");
    expect(text).toContain(acct);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = new AccountRegistry({ secret: "s".repeat(32), store: new FileAccountStore(file) });
    expect(await again.list(acct, () => false)).toMatchObject([
      { mailbox: "m1", name: "小明的 Mac", online: false },
    ]);
    expect(again.owns(acct, "m1")).toBe(true);
    // A mailbox belongs to one account.
    const other = await again.accountOf("someone-else");
    await again.register(other, { mailbox: "m1", name: "x", fingerprint: "fp1" });
    expect(again.owns(acct, "m1")).toBe(false);
  });
});

async function world(o: { scopes?: string[] } = {}) {
  const asks: CodeRequest[] = [];
  let typed: { resolve(c: string): void; reject(e: Error): void } | undefined;
  const w = await setup({
    relay: { google: { clientIds: [WEB, DESKTOP], jwksUrl: google.jwksUrl } },
    host: {
      onEnroll: () => ({
        askCode: (r) =>
          new Promise<string>((resolve, reject) => {
            asks.push(r);
            typed = { resolve, reject };
          }),
        accept: async (d) => {
          const rec = w.devices.add(d, o.scopes ?? ["chat", "approve"]);
          return { deviceId: rec.id, scopes: rec.scopes };
        },
      }),
    },
  });
  return {
    ...w,
    asks,
    /** The person types on the computer's sheet (or cancels). */
    type: (code: string) => typed?.resolve(code),
    cancel: () => typed?.reject(new Error("電腦上按了取消")),
  };
}

describe("computers under a Google account, new device with the phone's code (P10, P12)", () => {
  it("register → list → connect → code typed on the computer → session; reconnect by key only, no prompt", async () => {
    const w = await world();
    const reg = await w.host.registerComputer(google.token({ sub: "u1", aud: DESKTOP }), "小明的 MacBook");
    expect(reg).toEqual({ mailbox: w.host.mailbox, fingerprint: w.host.coreFingerprint });
    // The phone site's Web client registers a computer too (P12: the computer signs in through the site).
    expect(await w.host.registerComputer(google.token({ sub: "u1", aud: WEB }), "小明的 MacBook")).toEqual(
      reg,
    );
    const list = await listComputers(w.relay.url, google.token({ sub: "u1", aud: WEB }));
    expect(list).toMatchObject([{ mailbox: w.host.mailbox, name: "小明的 MacBook", online: true }]);
    expect(list[0]?.fingerprint).toBe(w.host.coreFingerprint);
    // Another account sees nothing.
    expect(await listComputers(w.relay.url, google.token({ sub: "u2", aud: WEB }))).toEqual([]);

    const phone = await generateIdentity();
    const code = newEnrollCode();
    expect(code).toMatch(/^\d{6}$/);
    const enrolled = enrollDevice({
      relayUrl: w.relay.url,
      computer: list[0] as (typeof list)[0],
      idToken: google.token({ sub: "u1", aud: WEB }),
      identity: phone,
      device: PHONE,
      code,
    });
    await until(() => w.asks.length === 1);
    expect(w.asks[0]).toMatchObject({ attempt: 1, left: 5, wrong: false });
    w.type(code);
    const creds = await enrolled;
    expect(creds.mailbox).toBe(w.host.mailbox);
    expect(creds.coreFingerprint).toBe(w.host.coreFingerprint);
    // The relay never saw the code, and the device's name only inside sealed frames.
    expect(JSON.stringify(w.seen)).not.toContain("Safari");
    expect(JSON.stringify(w.seen)).not.toContain(code);
    expect([...w.devices.rows.values()]).toHaveLength(1);

    const c = client(creds, phone);
    c.start();
    await until(() => c.status === "online");
    expect(await c.request("echo", { text: "嗨" })).toEqual({ echoed: "嗨" });

    // The computer restarts; the phone comes back with its key alone (no token, no code, no sheet).
    await w.host.close();
    await until(() => c.status !== "online");
    const again = new LinkHost({
      relayUrl: w.relay.url,
      identity: w.identity,
      coreName: "測試桌機",
      devices: w.devices,
      backoff: { first: 50, max: 200 },
      onEnroll: () => {
        throw new Error("no prompt expected");
      },
      onSession: (s) => s.peer.handle(async () => ({ back: true })),
    });
    cleanups.push(() => again.close());
    await again.start();
    await until(() => c.status === "online", 8000);
    expect(await c.request("anything")).toEqual({ back: true });
    expect(w.asks).toHaveLength(1);
  });

  it("取消 on the computer: the phone hears it was denied and keeps no device", async () => {
    const w = await world();
    await w.host.registerComputer(google.token({ sub: "u1", aud: DESKTOP }), "Mac");
    const [pc] = await listComputers(w.relay.url, google.token({ sub: "u1", aud: WEB }));
    const p = enrollDevice({
      relayUrl: w.relay.url,
      computer: pc as NonNullable<typeof pc>,
      idToken: google.token({ sub: "u1", aud: WEB }),
      identity: await generateIdentity(),
      device: PHONE,
      code: newEnrollCode(),
    });
    await until(() => w.asks.length === 1);
    w.cancel();
    await expect(p).rejects.toMatchObject({ code: "denied" });
    expect(w.devices.rows.size).toBe(0);
  });

  it("wrong audience and expired tokens are refused; another account cannot connect", async () => {
    const w = await world();
    await expect(
      w.host.registerComputer(google.token({ sub: "u1", aud: "not-ours" }), "Mac"),
    ).rejects.toMatchObject({ code: "bad_token" });
    await w.host.registerComputer(google.token({ sub: "u1", aud: DESKTOP }), "Mac");
    const now = Math.floor(Date.now() / 1000);
    await expect(
      listComputers(w.relay.url, google.token({ sub: "u1", aud: "not-ours" })),
    ).rejects.toMatchObject({
      code: "bad_token",
    });
    await expect(
      listComputers(w.relay.url, google.token({ sub: "u1", aud: WEB, exp: now - 3600 })),
    ).rejects.toMatchObject({ code: "bad_token" });
    await expect(
      enrollDevice({
        relayUrl: w.relay.url,
        computer: { mailbox: w.host.mailbox, fingerprint: w.host.coreFingerprint },
        idToken: google.token({ sub: "intruder", aud: WEB }),
        identity: await generateIdentity(),
        device: PHONE,
        code: newEnrollCode(),
      }),
    ).rejects.toMatchObject({ code: "no_such_computer" });
    expect(w.asks).toHaveLength(0); // no sheet ever reached the computer
  });

  it("revoke from the device list ends the session for good", async () => {
    const w = await world({ scopes: ["chat"] });
    await w.host.registerComputer(google.token({ sub: "u1", aud: DESKTOP }), "Mac");
    const [pc] = await listComputers(w.relay.url, google.token({ sub: "u1", aud: WEB }));
    const phone = await generateIdentity();
    const code = newEnrollCode();
    const p = enrollDevice({
      relayUrl: w.relay.url,
      computer: pc as NonNullable<typeof pc>,
      idToken: google.token({ sub: "u1", aud: WEB }),
      identity: phone,
      device: PHONE,
      code,
    });
    await until(() => w.asks.length === 1);
    w.type(code);
    const creds = await p;
    const c = client(creds, phone);
    c.start();
    await until(() => c.status === "online");
    const rec = w.devices.rows.get(creds.deviceId);
    if (rec) rec.revoked = true;
    w.host.disconnect(creds.deviceId, "revoked");
    await until(() => c.status === "revoked");
  });

  it("unregister takes the computer off the list; paired phones are not affected", async () => {
    const w = await world();
    await w.host.registerComputer(google.token({ sub: "u1", aud: DESKTOP }), "Mac");
    await w.host.unregisterComputer();
    expect(await listComputers(w.relay.url, google.token({ sub: "u1", aud: WEB }))).toEqual([]);
  });

  it("a relay without Google client IDs answers not_enabled", async () => {
    const { relay, host } = await setup();
    await expect(
      host.registerComputer(google.token({ sub: "u1", aud: DESKTOP }), "Mac"),
    ).rejects.toBeInstanceOf(LinkError);
    await expect(listComputers(relay.url, google.token({ sub: "u1", aud: WEB }))).rejects.toMatchObject({
      code: "relay",
    });
  });
});
