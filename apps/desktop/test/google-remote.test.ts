// P10 + P12 end to end on the desktop: zero settings (the official config
// only), 用 Google 登入 through the phone site (site → loopback callback, state
// and nonce checks), the relay lists the computer, a headless phone (the
// LinkClient the PWA uses) shows a code the person types on the computer's
// sheet (wrong once, then right), reconnect with no prompt, revoke. The old
// Desktop-client path (PKCE + its non-secret secret) stays for self-hosters.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollDevice, generateIdentity, LinkClient, listComputers, newEnrollCode } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type FakeGoogle, startFakeGoogle } from "../../../services/rendezvous/test/fake-google.ts";
import { computerParams, computerReturn, googleUrl, nonceFor } from "../../phone-pwa/app/computer-signin.ts";
import { deviceLabel } from "../src/link-remote.ts";
import { startDesktop } from "../src/start.ts";

vi.setConfig({ testTimeout: 30_000 });

const WEB = "test-web.apps.googleusercontent.com";
const DESKTOP = "test-desktop.apps.googleusercontent.com";
const SECRET = "GOCSPX-not-really-secret";
const SITE = "https://alca.example.com";
let google: FakeGoogle;
beforeAll(async () => {
  google = await startFakeGoogle({ clientSecret: SECRET });
});
afterAll(() => google.close());
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const until = async (f: () => boolean | Promise<boolean>, ms = 8000, what = "condition") => {
  const t = Date.now();
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function boot(mode: "official" | "desktop-client") {
  const relay = await startRendezvous({
    port: 0,
    google: { clientIds: [WEB, DESKTOP], jwksUrl: google.jwksUrl },
  });
  const dir = mkdtempSync(join(tmpdir(), "alca-google-"));
  const opened: string[] = [];
  const app = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "direct",
    browser: "off",
    openUrl: (u) => {
      opened.push(u);
      return true;
    },
    ...(mode === "official"
      ? // Nothing but what a release carries: no --rendezvous, no client ID, no secret.
        { official: { relayUrl: relay.url, siteUrl: SITE, googleClientId: WEB } }
      : {
          official: {},
          rendezvous: relay.url,
          google: {
            clientId: DESKTOP,
            clientSecret: SECRET,
            authEndpoint: google.authEndpoint,
            tokenEndpoint: google.tokenEndpoint,
          },
        }),
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => relay.close(),
    () => app.close(),
  );
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { app, relay, api, dir, opened };
}

/** What the site + the browser do: Google (faked by a token with the nonce), back to the site, on to the loopback port. */
async function siteSignIn(authUrl: string, o: { nonce?: string; sub?: string } = {}) {
  const u = new URL(authUrl);
  expect(`${u.origin}${u.pathname}`).toBe(`${SITE}/computer-signin`);
  const p = computerParams(u.search);
  if (!p) throw new Error("bad computer-signin link");
  const g = new URL(await googleUrl(WEB, SITE, p));
  expect(g.searchParams.get("client_id")).toBe(WEB);
  expect(g.searchParams.get("redirect_uri")).toBe(`${SITE}/`);
  expect(g.searchParams.get("response_type")).toBe("id_token");
  expect(g.searchParams.get("nonce")).toBe(await nonceFor(p.state));
  const token = google.token({
    sub: o.sub ?? "g-77",
    aud: WEB,
    email: "xiaoming@example.com",
    nonce: o.nonce ?? (g.searchParams.get("nonce") as string),
  });
  const back = await computerReturn(
    `#id_token=${token}&state=${g.searchParams.get("state")}`,
    JSON.stringify(p),
  );
  return { p, token, back };
}

/** The loopback callback page, as the browser would load and run it. */
async function callback(go: string, origin?: string) {
  const u = new URL(go);
  const page = await fetch(`${u.origin}${u.pathname}`);
  expect(page.headers.get("content-security-policy")).toMatch(/script-src 'sha256-/);
  const f = new URLSearchParams(u.hash.slice(1));
  const res = await fetch(`${u.origin}/google-callback`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: origin ?? u.origin },
    body: JSON.stringify({ id_token: f.get("id_token") ?? "", state: f.get("state") ?? "", error: "" }),
  });
  return { status: res.status, body: (await res.json()) as { title: string } };
}

describe("用 Google 登入 (P12: through the phone site, code typed on the computer)", () => {
  it("zero config: sign in through the site → listed → phone's code (one typo) → chat; reconnect with no prompt; revoke", async () => {
    const b = await boot("official");
    expect(b.app.link).toBeTruthy(); // Link is on from the official relay alone
    const before = (await b.api("GET", "/api/link/remote")).body;
    expect(before).toMatchObject({ available: true, via: "site", state: "off" });
    const start = (await b.api("POST", "/api/link/remote")).body;
    expect(start).toMatchObject({ state: "signing_in", opened: true });
    expect(b.opened).toEqual([start.authUrl]); // the core opened the system browser itself
    const s = await siteSignIn(String(start.authUrl));
    if (!s.back || !("go" in s.back)) throw new Error("the site did not send the browser back");
    expect(s.back.go).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/google-callback#id_token=/);
    // A forged post from another origin is refused, a wrong state ignored; the sign-in keeps waiting.
    expect((await callback(s.back.go, "https://evil.example")).status).toBe(403);
    const wrongState = s.back.go.replace(/state=[^&]+/, "state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect((await callback(wrongState)).status).toBe(400);
    expect((await b.api("GET", "/api/link/remote")).body.state).toBe("signing_in");
    expect((await callback(s.back.go)).body.title).toBe("已登入");
    await until(async () => (await b.api("GET", "/api/link/remote")).body.state === "on", 8000, "registered");
    expect((await b.api("GET", "/api/link/remote")).body).toMatchObject({ email: "xiaoming@example.com" });
    expect(readFileSync(join(b.dir, "link.json"), "utf8")).not.toContain("eyJ"); // no token kept

    const [pc] = await listComputers(b.relay.url, google.token({ sub: "g-77", aud: WEB }));
    expect(pc).toMatchObject({ online: true, mailbox: b.app.link?.host.mailbox });
    const phone = await generateIdentity();
    const code = newEnrollCode();
    const wrong: number[] = [];
    const shown = [code];
    const creds = enrollDevice({
      relayUrl: b.relay.url,
      computer: pc as NonNullable<typeof pc>,
      idToken: google.token({ sub: "g-77", aud: WEB }),
      identity: phone,
      device: { name: "iPhone", kind: "phone", platform: "iOS 18.1 · Safari" },
      code,
      onWrong: (a) => {
        wrong.push(a.left);
        shown.push(a.code);
      },
    });
    let sheet: Record<string, unknown> | undefined;
    await until(async () => {
      const e = (await b.api("GET", "/api/link/enrollments")).body.enrollments as Array<
        Record<string, unknown>
      >;
      sheet = e[0];
      return sheet?.state === "code";
    });
    expect(sheet).toMatchObject({ left: 5, wrong: false });
    const typo = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const first = await b.api("POST", `/api/link/enrollments/${String(sheet?.id)}`, { code: typo });
    expect(first.body).toEqual({ ok: false, error: "wrong_code", left: 4 });
    await until(async () => shown.length === 2);
    expect(wrong).toEqual([4]);
    // G1: the code the phone showed first is spent; it now shows a new one.
    const fresh = shown[1] as string;
    expect(fresh).not.toBe(code);
    const old = await b.api("POST", `/api/link/enrollments/${String(sheet?.id)}`, { code });
    expect(old.body).toEqual({ ok: false, error: "wrong_code", left: 3 });
    // That wrong try spent `fresh` as well: only the newest code shown works.
    await until(async () => shown.length === 3);
    const newest = shown[shown.length - 1] as string;
    expect(newest).not.toBe(fresh);
    const second = await b.api("POST", `/api/link/enrollments/${String(sheet?.id)}`, {
      code: `${newest.slice(0, 3)} ${newest.slice(3)}`,
    });
    expect(second.body).toEqual({ ok: true, label: "iPhone · Safari" });
    const c = new LinkClient({ credentials: await creds, identity: phone, pingSec: 0 });
    cleanups.push(() => c.stop());
    c.start();
    await until(() => c.status === "online");
    expect(await c.request("threads.list")).toBeTruthy();
    // Reconnect: no sheet, no code, no Google.
    c.stop();
    const c2 = new LinkClient({ credentials: await creds, identity: phone, pingSec: 0 });
    cleanups.push(() => c2.stop());
    c2.start();
    await until(() => c2.status === "online");
    expect(((await b.api("GET", "/api/link/enrollments")).body.enrollments as unknown[]).length).toBe(0);
    const link = (await b.api("GET", "/api/link")).body as {
      devices: Array<{ id: string; name: string; scopes: string[] }>;
    };
    const dev = link.devices.find((d) => d.name === "iPhone");
    expect(dev?.scopes).toEqual(["chat", "approve"]);
    expect((await b.api("POST", `/api/link/devices/${String(dev?.id)}/revoke`)).body.revoked).toBe(true);
    await until(() => c2.status === "revoked");
  });

  it("a token without this sign-in's nonce is refused (by the site and by the computer)", async () => {
    const b = await boot("official");
    const start = (await b.api("POST", "/api/link/remote")).body;
    const s = await siteSignIn(String(start.authUrl), { nonce: "someone-elses-nonce" });
    expect(s.back).toMatchObject({ error: expect.stringContaining("nonce") });
    // A browser that skipped the site's check still gets nowhere at the computer.
    const u = new URL(String(start.authUrl));
    const go = `http://127.0.0.1:${u.searchParams.get("port")}/google-callback#id_token=${s.token}&state=${s.p.state}`;
    expect((await callback(go)).body.title).toBe("登入沒有完成");
    await until(async () => (await b.api("GET", "/api/link/remote")).body.state === "error");
    expect(String((await b.api("GET", "/api/link/remote")).body.error)).toContain("nonce");
    // The site refuses a return whose state is not the one it stored.
    expect(
      await computerReturn(`#id_token=${s.token}&state=c.${"B".repeat(32)}`, JSON.stringify(s.p)),
    ).toMatchObject({
      error: expect.any(String),
    });
    expect(computerParams("?state=short&port=80")).toBeUndefined();
  });

  it("取消 on the code sheet refuses the phone; 停用 takes the computer off the list", async () => {
    const b = await boot("official");
    const start = (await b.api("POST", "/api/link/remote")).body;
    const s = await siteSignIn(String(start.authUrl), { sub: "g-88" });
    if (!s.back || !("go" in s.back)) throw new Error("no way back");
    await callback(s.back.go);
    await until(async () => (await b.api("GET", "/api/link/remote")).body.state === "on");
    const [pc] = await listComputers(b.relay.url, google.token({ sub: "g-88", aud: WEB }));
    const p = enrollDevice({
      relayUrl: b.relay.url,
      computer: pc as NonNullable<typeof pc>,
      idToken: google.token({ sub: "g-88", aud: WEB }),
      identity: await generateIdentity(),
      device: { name: "Android 手機", kind: "phone", platform: "Android 15 · Chrome 141" },
      code: newEnrollCode(),
    });
    let id = "";
    await until(async () => {
      const e = (await b.api("GET", "/api/link/enrollments")).body.enrollments as Array<{ id: string }>;
      id = e[0]?.id ?? "";
      return !!id;
    });
    await b.api("POST", `/api/link/enrollments/${id}`, { cancel: true });
    await expect(p).rejects.toMatchObject({ code: "denied" });
    expect(((await b.api("GET", "/api/link")).body.devices as unknown[]).length).toBe(0);
    expect((await b.api("DELETE", "/api/link/remote")).body.state).toBe("off");
    expect(await listComputers(b.relay.url, google.token({ sub: "g-88", aud: WEB }))).toEqual([]);
  });

  it("self-host: the Desktop client path (PKCE + its non-secret secret) still works", async () => {
    const b = await boot("desktop-client");
    google.signInAs = { sub: "g-99", email: "self@example.com" };
    const start = (await b.api("POST", "/api/link/remote")).body;
    expect(start).toMatchObject({ via: "desktop", state: "signing_in" });
    const u = new URL(String(start.authUrl));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("client_id")).toBe(DESKTOP);
    const g = await fetch(String(start.authUrl), { redirect: "manual" });
    const back = g.headers.get("location") ?? "";
    expect(back).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?code=/);
    expect(await (await fetch(back)).text()).toContain("已登入");
    await until(async () => (await b.api("GET", "/api/link/remote")).body.state === "on");
    expect(google.tokenRequests.at(-1)?.client_secret).toBe(SECRET);
  });

  it("labels the device from the phone's browser", () => {
    expect(deviceLabel("iPhone", "iOS 18.1 · Safari")).toBe("iPhone · Safari");
    expect(deviceLabel("Android 手機", "Android 15 · Chrome 141")).toBe("Android 手機 · Chrome");
    expect(deviceLabel("手機", "")).toBe("手機");
  });
});
