// Capture screenshots of the desktop UI with the offline demo engine, then
// (unless ALCA_SHOTS_PHONE=0) the phone PWA at iPhone size over Alca Link
// (apps/phone-pwa/scripts/screenshot.ts).
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright ALCA_CHROMIUM=/usr/bin/chromium \
//   node --disable-warning=ExperimentalWarning apps/desktop/scripts/screenshot.ts [outDir]
//
// Playwright is not a dependency of the repo; point PLAYWRIGHT_MODULE at any
// install (default: "playwright" resolved normally). Needs a CJK font on Linux
// (e.g. fonts-noto-cjk) for Traditional Chinese to render.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findChromium } from "@alca/browser";
import { generateIdentity, LinkClient, pairDevice } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { capturePhone, type Playwright } from "../../phone-pwa/scripts/screenshot.ts";
import { DEMO_LOOP_REQUEST, DEMO_PARALLEL_REQUEST } from "../src/demo-agents.ts";
import { startDesktop } from "../src/start.ts";
import { seedConnectors } from "./seed-connectors.ts";
import { seedHarness } from "./seed-harness.ts";
import { seedMemory } from "./seed-memory.ts";
import { seedTeam } from "./seed-team.ts";
import { browserLocale } from "./shots-locale.ts";
import { shootP6 } from "./shots-p6.ts";
import { shootP10 } from "./shots-p10.ts";
import { shootP11 } from "./shots-p11.ts";
import { shootP13 } from "./shots-p13.ts";
import { shootSettings } from "./shots-settings.ts";
import { shootTeam } from "./shots-team.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number; state?: string }): Promise<unknown>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(sel: string): Promise<void>;
  mouse: { move(x: number, y: number): Promise<void> };
}
interface Browser {
  newPage(opts: Record<string, unknown>): Promise<Page>;
  close(): Promise<void>;
}

const outDir = resolve(process.argv[2] ?? "docs/screenshots");
mkdirSync(outDir, { recursive: true });
const modPath = process.env.PLAYWRIGHT_MODULE;
// Playwright's own browser download is not available everywhere (e.g. linux-arm64): reuse ours.
const chromium = process.env.ALCA_CHROMIUM || findChromium();
const pw = (await import(modPath ? pathToFileURL(join(modPath, "index.mjs")).href : "playwright")) as {
  chromium: { launch(opts?: Record<string, unknown>): Promise<Browser> };
};

// ALCA_SHOTS_ONLY=p10: just the Google-account shots (phone sign-in, computers, number; the computer's sheet).
if (process.env.ALCA_SHOTS_ONLY === "p10") {
  if (!chromium) throw new Error("the P10 shots need Chromium (ALCA_CHROMIUM)");
  const files = await shootP10({ pw: pw as never, chromium, outDir });
  console.log(`p10 screenshots: ${files.join(", ")}`);
  process.exit(0);
}

// ALCA_SHOTS_ONLY=p11: just 模型與供應商 (the settings sheet, the model picker, a custom provider).
if (process.env.ALCA_SHOTS_ONLY === "p11") {
  if (!chromium) throw new Error("the P11 shots need Chromium (ALCA_CHROMIUM)");
  const files = await shootP11({ pw: pw as never, chromium, outDir });
  console.log(`p11 screenshots: ${files.join(", ")}`);
  process.exit(0);
}

// A local relay, so Link is on and the 手機 dialog has something real to show.
const relay = await startRendezvous({ port: 0 });
const dataDir = mkdtempSync(join(tmpdir(), "alca-shot-"));
// The watchdog looks every second here, so the looping-worker shot does not wait long.
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ engineering: { workers: { watchdogSec: 1 } } }));
const app = await startDesktop({
  engine: "demo",
  dataDir,
  port: 0,
  browser: chromium ? "headless" : "off",
  ...(chromium ? { chromium } : {}),
  // 設定 → 瀏覽器: the switch is live only when the app's download is on (Chromium is found here, so nothing downloads).
  ...(chromium && process.env.ALCA_SHOTS_ONLY === "settings" ? { browserDownload: true } : {}),
  rendezvous: relay.url,
  composioMock: true,
  vaultKeySource: "file",
});
const base = app.server.url;
const api = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await res.json()) as Record<string, unknown>;
};
const idle = async (threadId: string) => {
  for (let i = 0; i < 400; i++) {
    const t = (await api("GET", `/api/threads/${threadId}`)) as { thread: { busy: boolean } };
    if (!t.thread.busy) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};
const pending = async (kind: "approvals" | "questions") => {
  for (let i = 0; i < 400; i++) {
    const p =
      kind === "approvals"
        ? app.core.store.human.pendingApprovals()
        : app.core.store.human.pendingQuestions();
    if (p[0]) return p[0].id;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no pending ${kind}`);
};
const thread = async () => (await api("POST", "/api/threads", {})).id as string;
/** ALCA_SHOTS_ONLY=team: just the team shots (P7), desktop and phone. */
const only = process.env.ALCA_SHOTS_ONLY;
const newPage = async (b: Browser) =>
  b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: browserLocale });

try {
  if (only === "p9") {
    // A stand-in `codex` on PATH (installed, logged in), so the bot editor shows Codex CLI as 可用.
    const bin = mkdtempSync(join(tmpdir(), "alca-p9-bin-"));
    writeFileSync(
      join(bin, "codex"),
      '#!/bin/sh\n[ "$1" = --version ] && echo "codex-cli 0.55.0"\nexit 0\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    // 連線 (P9): the stable-address dialog after a self-check, with an example own domain typed in.
    await api("POST", "/api/link/connection/check");
    const browser = await pw.chromium.launch(chromium ? { executablePath: chromium } : {});
    const page = await newPage(browser);
    await page.goto(app.openUrl);
    await page.evaluate(`localStorage.setItem('alca.theme','dark')`);
    await page.reload();
    // #phone-toggle is a hidden trigger (新增手機 opens from 設定 › 裝置與連線 too).
    await page.waitForSelector("#phone-toggle", { state: "attached" });
    await page.evaluate("document.getElementById('phone-toggle').click()");
    await page.waitForSelector(".lk-status .lb-act", { timeout: 10_000 });
    await page.click(".lk-status .lb-act");
    await page.waitForSelector(".lc-state", { timeout: 10_000 });
    await page.evaluate(
      `(() => { const i = document.querySelector('.lc-dialog input.field'); i.value = 'https://relay.example.com'; const t = document.querySelector('.lc-dialog textarea'); t.value = 'wss://my-mac.example.ts.net'; })()`,
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, "desktop-connection-dark.png") });
    // The bot editor (P9): 進階 open, the engine set to 「Codex CLI」, 記憶整理 on 也請模型整理.
    await page.reload();
    await page.waitForSelector("#team-toggle:not([hidden])", { timeout: 10_000 });
    await page.click("#team-toggle");
    await page.waitForSelector(".tm-row[data-bot]", { timeout: 10_000 });
    await page.evaluate(`document.querySelector('.tm-row[data-bot]')?.click()`);
    await page.waitForSelector(".tm-editor", { timeout: 10_000 });
    await page.evaluate(`document.querySelector('.be-adv').open = true`);
    // P11: the engine is picked in 選供應商 → 選模型.
    await page.waitForSelector(".be-pick .pv-chosen", { timeout: 10_000 });
    await page.click(".be-pick .pv-chosen");
    await page.click('.be-pick .pv-row[data-id="codex"]');
    await page.waitForSelector('.tm-editor .pv-model[data-id="gpt-6.1-sol"]', { timeout: 10_000 });
    await page.click('.tm-editor .pv-model[data-id="gpt-6.1-sol"]');
    await page.evaluate(`(() => {
      [...document.querySelectorAll('#be-extract button')].find(b => b.textContent.includes('模型'))?.click();
      document.activeElement?.blur?.();
      document.querySelector('.be-pick').parentElement.scrollIntoView({ block: 'start' });
    })()`);
    await page.mouse.move(4, 890);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, "desktop-bot-edit-codex-dark.png") });
    await browser.close();
    console.log("p9 desktop screenshot written");
  } else if (only === "settings") {
    // P13 B3 / A6: 設定 and the conversation list's 封存 / 刪除 / 載入更多.
    const browser = await pw.chromium.launch(chromium ? { executablePath: chromium } : {});
    const files = await shootSettings({ app, browser: browser as never, outDir, relayUrl: relay.url });
    await browser.close();
    console.log(`settings screenshots: ${files.join(", ")}`);
  } else if (only === "p13") {
    // P13: the bot editor's folder / review / 提前做, the 復原 strip and dialog, 提前做 in 例行工作.
    const browser = await pw.chromium.launch(chromium ? { executablePath: chromium } : {});
    const files = await shootP13({ app, api, thread, idle, browser: browser as never, outDir });
    await browser.close();
    console.log(`p13 screenshots: ${files.join(", ")}`);
  } else if (only === "p6") {
    // Phase 6: the worker panel (harness), its snapshots, the bot editor's harness settings.
    const seed = await seedHarness({ api, app });
    const browser = await pw.chromium.launch(chromium ? { executablePath: chromium } : {});
    const files = await shootP6((await newPage(browser)) as never, app.openUrl, outDir, seed);
    await browser.close();
    console.log(`p6 screenshots: ${files.join(", ")}`);
  } else if (only === "team") {
    const seed = await seedTeam({ api, app, thread, idle });
    const browser = await pw.chromium.launch(chromium ? { executablePath: chromium } : {});
    const page = await newPage(browser);
    await page.goto(app.openUrl);
    const files = await shootTeam(page as never, outDir, seed);
    await browser.close();
    console.log(`team screenshots: ${files.join(", ")}`);
  } else {
    // Some history in the sidebar.
    const a = await thread();
    await api("POST", `/api/threads/${a}/messages`, { text: "幫我寫一則筆記：週六早上去南門市場買菜" });
    await api("POST", `/api/approvals/${await pending("approvals")}`, { decision: "approved" });
    await idle(a);
    const b = await thread();
    await api("POST", `/api/threads/${b}/messages`, { text: "問我下午的會議要排幾點" });
    await api("POST", `/api/questions/${await pending("questions")}`, { answer: "15:30" });
    await idle(b);

    // The thread on screen: a reply, then a delete that waits for the user.
    const c = await thread();
    await api("POST", `/api/threads/${c}/messages`, { text: "你好，今天可以幫我做什麼？" });
    await idle(c);
    await api("POST", `/api/threads/${c}/messages`, { text: "刪除購物清單" });
    await pending("approvals");
    await new Promise((r) => setTimeout(r, 600)); // let the streamed lead-in finish

    const browser = await pw.chromium.launch(chromium ? { executablePath: chromium } : {});
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      locale: browserLocale,
    });
    const shoot = async (theme: "dark" | "light", ready: string, file: string) => {
      await page.evaluate(`localStorage.setItem('alca.theme','${theme}')`);
      await page.reload();
      await page.waitForSelector(ready, { timeout: 10_000 });
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(outDir, file) });
    };
    await page.goto(app.openUrl);
    await page.waitForSelector(".card[data-state='pending']", { timeout: 10_000 });
    await shoot("dark", ".card[data-state='pending']", "desktop-dark.png");
    await shoot("light", ".card[data-state='pending']", "desktop-light.png");

    // A fresh thread shows the empty state (centered lockup + composer + starters).
    await page.click("#new-thread");
    await page.waitForSelector(".empty");
    await shoot("dark", ".empty", "desktop-empty-dark.png");
    await shoot("light", ".empty", "desktop-empty.png");

    // Alca Browser: the demo opens a fake shop; 每步確認 asks to open it, then the pay button is gated.
    if (chromium && app.browser) {
      const d = await thread();
      await api("POST", `/api/threads/${d}/messages`, { text: "幫我在示範商店結帳" });
      const waitCard = async (cls: string) => {
        for (let i = 0; i < 400; i++) {
          const hit = app.core.store.human.pendingApprovals().find((a) => a.actionClass === cls);
          if (hit) return hit.id;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`no ${cls} card`);
      };
      await api("POST", `/api/approvals/${await waitCard("network")}`, { decision: "approved" });
      await waitCard("payment");
      await new Promise((r) => setTimeout(r, 600));
      // A real reload per theme, so every themed bit (the sidebar's theme icon too) matches.
      const openShop = async (theme: "dark" | "light") => {
        await page.evaluate(`localStorage.setItem('alca.theme','${theme}')`);
        await page.reload();
        await page.waitForSelector(".thread-item");
        await page.evaluate(
          `[...document.querySelectorAll('.thread-item')].find(b => b.textContent.includes('示範商店'))?.click()`,
        );
        await page.waitForSelector(".bp-approval", { timeout: 10_000 });
        await page.waitForSelector(".bp-frame img[src]", { timeout: 10_000 });
        await page.waitForTimeout(900);
      };
      await openShop("dark");
      await page.screenshot({ path: join(outDir, "desktop-browser-dark.png") });
      await openShop("light");
      await page.screenshot({ path: join(outDir, "desktop-browser-light.png") });

      // 接手: the person drives the same page; the agent's next step waits.
      await openShop("dark");
      await page.click(".takeover-btn");
      await page.waitForSelector(".bp-frame[data-controller='user']");
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(outDir, "desktop-browser-takeover-dark.png") });
      await page.click(".takeover-btn"); // hand back

      // Router / workers (P3): two workers at once — one stops at a payment card in its own
      // Space, the other is spilled and recalled — then a looping worker the watchdog stops.
      const e = await thread();
      const cardOf = async (cls: string) => {
        for (let i = 0; i < 600; i++) {
          const hit = app.core.store.human
            .pendingApprovals()
            .find(
              (a) => a.actionClass === cls && a.runId && app.core.store.runs.get(a.runId)?.threadId === e,
            );
          if (hit) return hit.id;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`no ${cls} card in the worker thread`);
      };
      const said = async (needle: string) => {
        for (let i = 0; i < 800; i++) {
          if (app.core.messages(e).some((m) => m.role === "assistant" && m.content.includes(needle))) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`router never said ${needle}`);
      };
      await api("POST", `/api/threads/${e}/messages`, { text: DEMO_PARALLEL_REQUEST });
      await api("POST", `/api/approvals/${await cardOf("network")}`, { decision: "approved" });
      await cardOf("payment");
      await said("比價報告整理好了");
      await api("POST", `/api/threads/${e}/messages`, { text: DEMO_LOOP_REQUEST });
      await said("被看門狗停下了");
      const openWorkerThread = async (theme: "dark" | "light") => {
        await page.evaluate(`localStorage.setItem('alca.theme','${theme}')`);
        await page.reload();
        await page.waitForSelector(".thread-item");
        await page.evaluate(
          `[...document.querySelectorAll('.thread-item')].find(b => b.textContent.includes('同時幫我'))?.click()`,
        );
        await page.waitForSelector(".item.report", { timeout: 10_000 });
        await page.click("#workers-toggle");
        await page.waitForSelector(".wp-item", { timeout: 10_000 });
        await page.waitForTimeout(800);
      };
      await openWorkerThread("dark");
      await page.screenshot({ path: join(outDir, "desktop-workers-dark.png") });
      await openWorkerThread("light");
      await page.screenshot({ path: join(outDir, "desktop-workers-light.png") });

      // One worker's own live stream (its payment card included), with the stop button.
      await openWorkerThread("dark");
      await page.click(".wp-item[data-status='waiting']");
      await page.waitForSelector(".wp-stream .card[data-state='pending']", { timeout: 10_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(outDir, "desktop-worker-stream-dark.png") });
    }
    // 記憶與技能 (P5): memory learned from chat (confirmed and inferred, with provenance), one edited
    // item, a saved skill that was reused, and a fresh proposal from a paid checkout.
    await seedMemory({ api, thread, idle, pending, app, shop: !!(chromium && app.browser) });
    const openLibrary = async (tab: "記憶" | "技能") => {
      await page.evaluate(`localStorage.setItem('alca.theme','dark')`);
      await page.reload();
      await page.waitForSelector("#library-toggle:not([hidden])");
      await page.click("#library-toggle");
      await page.waitForSelector(".lb-row", { timeout: 10_000 });
      if (tab === "技能") {
        await page.evaluate(
          `[...document.querySelectorAll('.lb-tab')].find(b => b.textContent.includes('技能'))?.click()`,
        );
        await page.waitForSelector(".lb-skills", { timeout: 10_000 });
      }
      await page.waitForTimeout(700);
    };
    await openLibrary("記憶");
    await page.screenshot({ path: join(outDir, "desktop-memory-dark.png") });
    await openLibrary("技能");
    await page.screenshot({ path: join(outDir, "desktop-skills-dark.png") });
    if (chromium && app.browser) {
      // The same proposal where it was learned: a card at the end of that chat.
      await page.reload();
      await page.waitForSelector(".thread-item");
      await page.evaluate(`document.querySelector('.thread-item')?.click()`);
      await page.waitForSelector(".sk-card", { timeout: 10_000 });
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(outDir, "desktop-skill-card-dark.png") });
    }

    // 手機 dialog: one phone already paired (a headless Link client, online), then a fresh code + QR.
    const pairing = await api("POST", "/api/link/pairings", {});
    const identity = await generateIdentity();
    const credentials = await pairDevice({
      relayUrl: relay.url,
      code: String(pairing.display),
      identity,
      device: { name: "我的 iPhone", kind: "phone", platform: "headless" },
      expectFingerprint: String(pairing.coreFingerprint),
    });
    const phone = new LinkClient({ credentials, identity, pingSec: 0 });
    phone.start();
    for (let i = 0; i < 400 && phone.status !== "online"; i++) await new Promise((r) => setTimeout(r, 25));
    await page.evaluate(`localStorage.setItem('alca.theme','dark')`);
    await page.reload();
    await page.waitForSelector("#phone-toggle", { state: "attached" });
    await page.evaluate("document.getElementById('phone-toggle').click()");
    await page.waitForSelector(".lk-devices li", { timeout: 10_000 });
    await page.click(".lk-pair .btn-primary");
    await page.waitForSelector(".lk-qr", { timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, "desktop-link-dark.png") });
    phone.stop();

    // 連接 + 例行工作 (P6), with the local Composio stand-in: two Gmail accounts and a calendar,
    // per-bot access, a trigger; a routine with a reply draft ahead, a quiet one, a read failure.
    await seedConnectors({ api, app });
    await page.evaluate(`localStorage.setItem('alca.theme','dark')`);
    await page.reload();
    await page.waitForSelector("#connect-toggle:not([hidden])", { timeout: 10_000 });
    await page.click("#connect-toggle");
    await page.waitForSelector(".connect .cn-acct, .connect li", { timeout: 10_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, "desktop-connectors-dark.png") });
    await page.click("#routines-toggle");
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(outDir, "desktop-routines-dark.png") });
    // 團隊 (P7).
    const seed = await seedTeam({ api, app, thread, idle });
    await shootTeam(page as never, outDir, seed);
    await browser.close();
    console.log(`screenshots written to ${outDir}`);
  }
} finally {
  await app.close();
  await relay.close();
  rmSync(dataDir, { recursive: true, force: true });
}

// The P13 shots are desktop only.
if (chromium && process.env.ALCA_SHOTS_PHONE !== "0" && only !== "p13" && only !== "settings") {
  const shots = await capturePhone({
    outDir,
    playwright: pw as unknown as Playwright,
    chromium,
    ...(only === "team" || only === "p9" || only === "p6" ? { only } : {}),
  });
  console.log(`phone screenshots: ${shots.length}`);
}
