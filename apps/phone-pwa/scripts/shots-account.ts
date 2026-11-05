// Screenshots of the 素 Plain first-run screens that need a Google account
// (§3.13): 用 Google 登入, 選擇電腦, the enroll code (and a wrong try), 已連上,
// and /computer-signin. A local fake Google signs the ID token; the phone
// comes back from the "redirect" with `#id_token=…` and its nonce, exactly as
// after accounts.google.com. Portrait 393×852 and landscape 852×393, dark and light.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright ALCA_CHROMIUM=/usr/bin/chromium \
//   node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/shots-account.ts [outDir]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findChromium } from "@alca/browser";
import { generateIdentity, LinkHost } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { startFakeGoogle } from "../../../services/rendezvous/test/fake-google.ts";
import { startDesktop } from "../../desktop/src/start.ts";
import { buildPwa } from "./build.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  screenshot(opts: { path: string }): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(sel: string): Promise<void>;
  addInitScript(script: string): Promise<void>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
}
interface Browser {
  newContext(o: Record<string, unknown>): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  newPage(o: Record<string, unknown>): Promise<Page>;
  close(): Promise<void>;
}

const WEB = "test-web.apps.googleusercontent.com";
const DESKTOP = "test-desktop.apps.googleusercontent.com";
const NONCE = "shots-nonce-0001";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ORIENT = {
  portrait: { w: 393, h: 852, safe: "59,34,0,0" },
  landscape: { w: 852, h: 393, safe: "0,21,59,59" },
} as const;

const outDir = resolve(process.argv[2] ?? "docs/screenshots/phone-plain");
mkdirSync(outDir, { recursive: true });
const modPath = process.env.PLAYWRIGHT_MODULE;
const pw = (await import(modPath ? pathToFileURL(join(modPath, "index.mjs")).href : "playwright")) as {
  chromium: { launch(o: object): Promise<Browser> };
};
const chromium = process.env.ALCA_CHROMIUM || findChromium();
if (!chromium) throw new Error("no Chromium found (set ALCA_CHROMIUM)");
const themes = (process.env.ALCA_THEMES?.split(",") ?? ["dark", "light"]) as Array<"dark" | "light">;

const google = await startFakeGoogle();
const relay = await startRendezvous({
  port: 0,
  google: { clientIds: [WEB, DESKTOP], jwksUrl: google.jwksUrl },
});
const site = buildPwa(mkdtempSync(join(tmpdir(), "alca-site-")), {
  ALCA_RELAY_URL: relay.url,
  ALCA_GOOGLE_CLIENT_ID: WEB,
});
const siteRelay = await startRendezvous({ port: 0, pwaDir: site });
const dataDir = mkdtempSync(join(tmpdir(), "alca-acct-"));
writeFileSync(join(dataDir, "config.json"), JSON.stringify({}));
const app = await startDesktop({
  engine: "demo",
  dataDir,
  port: 0,
  browser: "off",
  vaultKeySource: "file",
  official: { relayUrl: relay.url, siteUrl: siteRelay.url, googleClientId: WEB },
  openUrl: () => false,
} as Parameters<typeof startDesktop>[0]);
const away = new LinkHost({
  relayUrl: relay.url,
  identity: await generateIdentity(true),
  coreName: "家裡的 Mac mini",
  devices: { get: () => undefined, add: () => ({}) as never, seen: () => undefined },
  onSession: () => undefined,
  selfCheckMs: 0,
});
const browser = await pw.chromium.launch({ executablePath: chromium });
const shots: string[] = [];
const errors: string[] = [];
try {
  const sub = "109876543210";
  await away.start();
  await away.registerComputer(google.token({ sub, aud: DESKTOP }), "家裡的 Mac mini");
  await away.close();
  await app.link?.host.registerComputer(google.token({ sub, aud: WEB }), "小明的 MacBook Pro");
  const desk = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "zh-TW",
  });

  for (const theme of themes) {
    let o: keyof typeof ORIENT = "portrait";
    let phone!: Page;
    const shot = async (name: string, settle = 700) => {
      await phone.waitForTimeout(settle);
      const path = join(outDir, `plain-${name}-${o}-${theme}.png`);
      await phone.screenshot({ path });
      shots.push(path);
    };
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        errors.push(`${theme}/${o}/${name}: ${(e as Error).message.split("\n")[0]}`);
      }
    };
    let n = 0;
    for (const orient of ["portrait", "landscape"] as const) {
      o = orient;
      const v = ORIENT[o];
      // A fresh context each time: no saved pairing from the run before.
      const ctx = await browser.newContext({
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        locale: "zh-TW",
        userAgent: IPHONE_UA,
        colorScheme: theme,
      });
      phone = await ctx.newPage();
      await phone.addInitScript(`sessionStorage.setItem("alca.gnonce", ${JSON.stringify(NONCE)})`);
      await phone.setViewportSize({ width: v.w, height: v.h });
      const token = google.token({
        sub,
        aud: WEB,
        email: "xiaoming@example.com",
        name: "小明",
        nonce: NONCE,
      });
      await step("google-signin", async () => {
        await phone.goto(`${siteRelay.url}/?safe=${v.safe}&n=${++n}`);
        await phone.waitForSelector(".gs .g-btn", { timeout: 15_000 });
        await shot("google-signin", 900);
      });
      await step("pick-computer", async () => {
        await phone.goto(`${siteRelay.url}/?safe=${v.safe}&n=${++n}#id_token=${token}`);
        await phone.waitForSelector(".pc-item", { timeout: 15_000 });
        await shot("pick-computer");
      });
      await step("enroll", async () => {
        await phone.click('.pc-item[data-online="true"]');
        await phone.waitForSelector(".sas-num", { timeout: 15_000 });
        await shot("enroll-code", 1400);
      });
      if (o !== "portrait") {
        await ctx.close();
        continue;
      }
      await step("enroll-wrong", async () => {
        const code = String(
          await phone.evaluate(`document.querySelector('.sas-num').textContent.replace(/\\D/g, '')`),
        );
        await desk.goto(app.openUrl);
        await desk.waitForSelector(".nd-sheet[open] .nd-code", { timeout: 15_000 });
        const typo = String((Number(code) + 7) % 1_000_000).padStart(6, "0");
        const enter = async (c: string) => {
          await desk.evaluate(
            `(() => { const i = document.querySelector('.nd-code'); i.value = ${JSON.stringify(c)}; i.dispatchEvent(new Event('input')); })()`,
          );
          await desk.click(".nd-allow");
        };
        await enter(typo);
        await desk.waitForSelector('.nd-msg[data-tone="bad"]', { timeout: 15_000 });
        await shot("enroll-wrong", 500);
        const next = String(
          await phone.evaluate(`document.querySelector('.sas-num').textContent.replace(/\\D/g, '')`),
        );
        await enter(next);
        await phone.waitForSelector(".paired", { timeout: 15_000 });
        await shot("enrolled", 900);
      });
      await ctx.close();
    }
    await step("computer-signin", async () => {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        locale: "zh-TW",
        colorScheme: theme,
      });
      await page.goto(`${siteRelay.url}/computer-signin?state=${"s".repeat(32)}&port=50123&preview=1`);
      await page.waitForSelector(".g-btn", { timeout: 15_000 });
      await page.waitForTimeout(600);
      const path = join(outDir, `plain-computer-signin-${theme}.png`);
      await page.screenshot({ path });
      shots.push(path);
    });
  }
} finally {
  await browser.close();
  await app.close().catch(() => undefined);
  await relay.close();
  await siteRelay.close();
  await google.close();
  for (const d of [dataDir, site]) rmSync(d, { recursive: true, force: true });
}
console.log(shots.join("\n"));
if (errors.length) console.error(`\nFAILED STEPS:\n${errors.join("\n")}`);
process.exit(0);
