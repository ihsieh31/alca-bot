// P10/P12 screenshots: 用 Google 登入. A local fake Google (JWKS + ID tokens)
// stands in for accounts.google.com; the phone page gets a stand-in for
// Google Identity Services that draws Google's dark pill button and returns a
// token the relay accepts. The computer runs with the official config only
// (relay, site, Web client: no settings). Shots: the phone's sign-in, the
// account's computers, the code the phone shows, the computer's sheet
// 「輸入手機上的驗證碼」 (empty, then a wrong try), and the site's
// /computer-signin page the computer opens in the browser.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, LinkHost } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { startFakeGoogle } from "../../../services/rendezvous/test/fake-google.ts";
import { buildPwa } from "../../phone-pwa/scripts/build.ts";
import { startDesktop } from "../src/start.ts";
import { browserLocale } from "./shots-locale.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  screenshot(opts: { path: string }): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(sel: string): Promise<void>;
  addInitScript(script: string): Promise<void>;
}
interface Browser {
  newContext(o: Record<string, unknown>): Promise<{ newPage(): Promise<Page> }>;
  newPage(o: Record<string, unknown>): Promise<Page>;
  close(): Promise<void>;
}
export interface Pw {
  chromium: { launch(o?: Record<string, unknown>): Promise<Browser> };
}

const WEB = "test-web.apps.googleusercontent.com";
const DESKTOP = "test-desktop.apps.googleusercontent.com";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

/** Stand-in for Google Identity Services: Google's dark pill button; a tap signs in with `token`. */
const fakeGis = (token: string) => `
  window.google = { accounts: { id: {
    _cb: null,
    initialize(o) { this._cb = o.callback; },
    prompt() {},
    disableAutoSelect() {},
    renderButton(el, o) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fake-gsi';
      b.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;width:' + o.width + 'px;height:44px;border-radius:22px;border:1px solid #8e918f;background:#131314;color:#e3e3e3;font:500 15px/1 Roboto,"Noto Sans TC",sans-serif;letter-spacing:.25px;padding:0 16px;cursor:pointer';
      b.innerHTML = '<svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg><span>使用 Google 帳戶繼續</span>';
      b.onclick = () => this._cb && this._cb({ credential: ${JSON.stringify(token)} });
      el.replaceChildren(b);
    },
  } } };`;

export async function shootP10(o: { pw: Pw; chromium: string; outDir: string }): Promise<string[]> {
  const shots: string[] = [];
  const google = await startFakeGoogle();
  const relay = await startRendezvous({
    port: 0,
    google: { clientIds: [WEB, DESKTOP], jwksUrl: google.jwksUrl },
  });
  const site = buildPwa(mkdtempSync(join(tmpdir(), "alca-site-")), {
    ALCA_RELAY_URL: relay.url,
    ALCA_GOOGLE_CLIENT_ID: WEB,
  });
  // The relay serves the built site too (on Vercel it would be its own origin).
  const siteRelay = await startRendezvous({ port: 0, pwaDir: site });
  const dataDir = mkdtempSync(join(tmpdir(), "alca-p10-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({}));
  const app = await startDesktop({
    engine: "demo",
    dataDir,
    port: 0,
    browser: "off",
    vaultKeySource: "file",
    official: { relayUrl: relay.url, siteUrl: siteRelay.url, googleClientId: WEB },
    openUrl: () => false,
  });
  // A second computer on the same account that has been away for a while.
  const away = new LinkHost({
    relayUrl: relay.url,
    identity: await generateIdentity(true),
    coreName: "家裡的 Mac mini",
    devices: { get: () => undefined, add: () => ({}) as never, seen: () => undefined },
    onSession: () => undefined,
    selfCheckMs: 0,
  });
  const browser = await o.pw.chromium.launch({ executablePath: o.chromium });
  try {
    const sub = "109876543210";
    await away.start();
    await away.registerComputer(google.token({ sub, aud: DESKTOP }), "家裡的 Mac mini");
    await away.close();
    await app.link?.host.registerComputer(google.token({ sub, aud: WEB }), "小明的 MacBook Pro");

    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      locale: browserLocale,
      userAgent: IPHONE_UA,
      colorScheme: "dark",
    });
    const phone = await ctx.newPage();
    const token = google.token({ sub, aud: WEB, email: "xiaoming@example.com", name: "小明" });
    await phone.addInitScript(fakeGis(token));
    const shot = async (p: Page, name: string, settle = 700) => {
      await p.waitForTimeout(settle);
      const path = join(o.outDir, name);
      await p.screenshot({ path });
      shots.push(path);
    };
    await phone.goto(`${siteRelay.url}/?safe=47,34`);
    await phone.waitForSelector(".gs .g-btn", { timeout: 15_000 });
    await shot(phone, "phone-google-signin-dark.png", 1200);
    await phone.click(".fake-gsi");
    await phone.waitForSelector(".pc-item", { timeout: 15_000 });
    await shot(phone, "phone-pick-computer-dark.png");
    await phone.click('.pc-item[data-online="true"]');
    await phone.waitForSelector(".sas-num", { timeout: 15_000 });
    await shot(phone, "phone-enroll-code-dark.png", 1400);
    const code = String(
      await phone.evaluate(`document.querySelector('.sas-num').textContent.replace(/\\D/g, '')`),
    );

    const desk = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      locale: browserLocale,
    });
    await desk.goto(app.openUrl);
    await desk.evaluate(`localStorage.setItem('alca.theme','dark')`);
    await desk.reload();
    await desk.waitForSelector(".nd-sheet[open] .nd-code", { timeout: 15_000 });
    await shot(desk, "desktop-enter-code-dark.png", 900);
    // A typo first: the sheet says so, and the phone hears it too.
    const typo = String((Number(code) + 7) % 1_000_000).padStart(6, "0");
    await desk.evaluate(
      `(() => { const i = document.querySelector('.nd-code'); i.value = ${JSON.stringify(typo)}; i.dispatchEvent(new Event('input')); })()`,
    );
    await desk.click(".nd-allow");
    await desk.waitForSelector('.nd-msg[data-tone="bad"]', { timeout: 15_000 });
    await shot(desk, "desktop-enter-code-wrong-dark.png", 500);
    await shot(phone, "phone-enroll-wrong-dark.png", 200);
    await desk.evaluate(
      `(() => { const i = document.querySelector('.nd-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input')); })()`,
    );
    await desk.click(".nd-allow");
    await phone.waitForSelector(".paired", { timeout: 15_000 });
    await desk.waitForSelector('.nd-msg[data-tone="ok"]', { timeout: 15_000 });
    await shot(desk, "desktop-enter-code-done-dark.png", 300);

    // The page the computer opens in the browser for 用 Google 登入 (preview: does not go on to Google).
    const site = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      locale: browserLocale,
    });
    await site.goto(`${siteRelay.url}/computer-signin?state=${"s".repeat(32)}&port=50123&preview=1`);
    await site.waitForSelector(".g-btn", { timeout: 15_000 });
    await shot(site, "site-computer-signin-dark.png", 600);
  } finally {
    await browser.close();
    await app.close();
    await siteRelay.close();
    await relay.close();
    await google.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(site, { recursive: true, force: true });
  }
  return shots;
}
