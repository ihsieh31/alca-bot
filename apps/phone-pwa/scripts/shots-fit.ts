// Full-screen fit check for the Home Screen app: iPhone 15 size (393×852,
// DPR 3) with the `?safe=59,34` preview hook standing in for the Dynamic
// Island and the home indicator, which are drawn on top as outlines so a
// screenshot shows at a glance whether anything sits under them. Shoots the
// Google sign-in screen, the chat with its composer, a bottom sheet and a
// full-screen sheet, in dark and light.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright ALCA_CHROMIUM=/usr/bin/chromium \
//   node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/shots-fit.ts [outDir]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findChromium } from "@alca/browser";
import { startRendezvous } from "@alca/rendezvous";
import { browserLocale } from "../../desktop/scripts/shots-locale.ts";
import { startDesktop } from "../../desktop/src/start.ts";
import { buildPwa } from "./build.ts";
import { pairingCode } from "./pairing-code.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  screenshot(opts: { path: string }): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(sel: string): Promise<void>;
  fill(sel: string, text: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
}
interface Browser {
  newContext(opts: Record<string, unknown>): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  close(): Promise<void>;
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const SAFE_TOP = 59;
const SAFE_BOTTOM = 34;

/** Dynamic Island + home indicator outlines, and dashed lines at the safe-area edges (CSSOM: the CSP blocks style attributes). */
const OVERLAY = `(() => {
  const box = (css) => {
    const e = document.createElement("div");
    for (const [k, v] of Object.entries(css)) e.style.setProperty(k, v);
    return e;
  };
  const d = box({ position: "fixed", inset: "0", "pointer-events": "none", "z-index": "2147483647" });
  d.setAttribute("aria-hidden", "true");
  d.append(
    box({ position: "absolute", left: "50%", top: "11px", width: "126px", height: "37px", "margin-left": "-63px", "border-radius": "19px", background: "#000", outline: "1px solid #f0f" }),
    box({ position: "absolute", left: "50%", bottom: "8px", width: "134px", height: "5px", "margin-left": "-67px", "border-radius": "3px", background: "#888", outline: "1px solid #f0f" }),
    box({ position: "absolute", left: "0", right: "0", top: "${SAFE_TOP}px", "border-top": "1px dashed #f0f" }),
    box({ position: "absolute", left: "0", right: "0", bottom: "${SAFE_BOTTOM}px", "border-top": "1px dashed #f0f" }),
  );
  document.body.append(d);
})()`;

export async function captureFit(
  outDir: string,
  playwright: { chromium: { launch(o: object): Promise<Browser> } },
) {
  const chromium = process.env.ALCA_CHROMIUM || findChromium();
  if (!chromium) throw new Error("no Chromium found (set ALCA_CHROMIUM)");
  const shots: string[] = [];
  const plain = buildPwa(mkdtempSync(join(tmpdir(), "alca-fit-")), {});
  const google = buildPwa(mkdtempSync(join(tmpdir(), "alca-fit-g-")), {
    ALCA_GOOGLE_CLIENT_ID: "000-test.apps.googleusercontent.com",
  });
  const relay = await startRendezvous({ port: 0, pwaDir: plain });
  const relayG = await startRendezvous({ port: 0, pwaDir: google });
  const dataDir = mkdtempSync(join(tmpdir(), "alca-fit-data-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({}));
  const app = await startDesktop({
    engine: "demo",
    dataDir,
    port: 0,
    browser: "off",
    rendezvous: relay.url,
    composioMock: true,
    vaultKeySource: "file",
  } as Parameters<typeof startDesktop>[0]);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const browser = await playwright.chromium.launch({ executablePath: chromium });
  try {
    for (const theme of ["dark", "light"] as const) {
      const ctx = await browser.newContext({
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        locale: browserLocale,
        userAgent: IPHONE_UA,
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      const paint = `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`;
      const shot = async (name: string, settle = 700) => {
        await page.evaluate(paint);
        await page.waitForTimeout(settle);
        await page.evaluate(OVERLAY);
        const path = join(outDir, `fit-${name}-${theme}.png`);
        await page.screenshot({ path });
        await page.evaluate("document.body.lastElementChild?.remove()");
        shots.push(path);
      };
      // Sign-in (a site with a Google client ID).
      await page.goto(`${relayG.url}/?safe=${SAFE_TOP},${SAFE_BOTTOM}`);
      await page.waitForSelector(".gs");
      await shot("signin");
      // Pairing, then the chat with a reply in it.
      const pairing = await api("POST", "/api/link/pairings", { scopes: ["chat", "approve"] });
      await page.goto(`${relay.url}/?safe=${SAFE_TOP},${SAFE_BOTTOM}`);
      await page.waitForSelector(".code-input");
      await page.fill(".code-input", pairingCode(pairing));
      await page.click(".pair-form button[type=submit]");
      await page.waitForSelector(".paired", { timeout: 15_000 });
      await page.click(".paired .btn");
      await page.waitForSelector(".tb-sub[data-state='online']", { timeout: 10_000 });
      await shot("chat-empty");
      await page.fill(".composer-input", "幫我整理一下今天要做的事");
      await page.click(".send-btn");
      await page.waitForTimeout(2500);
      await page.evaluate("document.activeElement?.blur()");
      await shot("chat");
      // A bottom sheet (診斷) and a full-screen one (記憶與技能).
      await page.goto(`${relay.url}/?safe=${SAFE_TOP},${SAFE_BOTTOM}#diag`);
      await page.waitForSelector(".sheet-layer[data-open='true'] .sheet", { timeout: 10_000 });
      await shot("sheet", 1200);
      await page.goto(`${relay.url}/?safe=${SAFE_TOP},${SAFE_BOTTOM}&full=1#memory`);
      await page.waitForSelector(".sheet-layer[data-open='true'] .sheet[data-size='full']", {
        timeout: 10_000,
      });
      await shot("sheet-full", 1200);
      await page.goto(`${relay.url}/?safe=${SAFE_TOP},${SAFE_BOTTOM}&drawer=1`);
      await page.waitForSelector(".topbar");
      await page.click(".topbar .icon-btn[aria-label='對話列表']");
      await page.waitForSelector(".drawer-layer[data-open='true']");
      await shot("drawer");
      await ctx.close();
    }
  } finally {
    await browser.close();
    await app.close();
    await relay.close();
    await relayG.close();
    for (const d of [dataDir, plain, google]) rmSync(d, { recursive: true, force: true });
  }
  return shots;
}

const outDir = resolve(process.argv[2] ?? "docs/screenshots");
mkdirSync(outDir, { recursive: true });
const modPath = process.env.PLAYWRIGHT_MODULE;
const playwright = (await import(
  modPath ? pathToFileURL(join(modPath, "index.mjs")).href : "playwright"
)) as {
  chromium: { launch(o: object): Promise<Browser> };
};
console.log((await captureFit(outDir, playwright)).join("\n"));
