// Screenshots of the 素 Plain redesign (docs/design/DESIGN-SYSTEM.md): the phone
// at iPhone portrait (393×852, `?safe=59,34`) and landscape (852×393,
// `?safe=0,21,59,59`), dark and light, against the real stack (rendezvous +
// desktop core with the demo engines and a headless Alca Browser).
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright ALCA_CHROMIUM=/usr/bin/chromium \
//   node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/shots-plain.ts [outDir]
//
// ALCA_SHOTS_ONLY=chats,approval-pay,… limits the set; ALCA_THEMES=dark limits the themes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findChromium } from "@alca/browser";
import { startRendezvous } from "@alca/rendezvous";
import { seedConnectors } from "../../desktop/scripts/seed-connectors.ts";
import { seedHarness } from "../../desktop/scripts/seed-harness.ts";
import { seedMemory } from "../../desktop/scripts/seed-memory.ts";
import { seedTeam } from "../../desktop/scripts/seed-team.ts";
import { DEMO_PARALLEL_REQUEST } from "../../desktop/src/demo-agents.ts";
import { startDesktop } from "../../desktop/src/start.ts";
import { buildPwa } from "./build.ts";
import { pairingCode } from "./pairing-code.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number; state?: string }): Promise<unknown>;
  screenshot(opts: { path: string }): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(sel: string): Promise<void>;
  fill(sel: string, text: string): Promise<void>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  setDefaultTimeout(ms: number): void;
}
interface Browser {
  newContext(opts: Record<string, unknown>): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  close(): Promise<void>;
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ORIENT = {
  portrait: { w: 393, h: 852, safe: "59,34,0,0" },
  landscape: { w: 852, h: 393, safe: "0,21,59,59" },
} as const;

const outDir = resolve(process.argv[2] ?? "docs/screenshots/phone-plain");
mkdirSync(outDir, { recursive: true });
const modPath = process.env.PLAYWRIGHT_MODULE;
const playwright = (await import(
  modPath ? pathToFileURL(join(modPath, "index.mjs")).href : "playwright"
)) as {
  chromium: { launch(o: object): Promise<Browser> };
};
const chromium = process.env.ALCA_CHROMIUM || findChromium();
if (!chromium) throw new Error("no Chromium found (set ALCA_CHROMIUM)");
const only = process.env.ALCA_SHOTS_ONLY?.split(",");
const themes = (process.env.ALCA_THEMES?.split(",") ?? ["dark", "light"]) as Array<"dark" | "light">;

const pwa = buildPwa(mkdtempSync(join(tmpdir(), "alca-plain-")), {});
const relay = await startRendezvous({ port: 0, pwaDir: pwa });
const dataDir = mkdtempSync(join(tmpdir(), "alca-plain-data-"));
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ engineering: { workers: { watchdogSec: 1 } } }));
const app = await startDesktop({
  engine: "demo",
  dataDir,
  port: 0,
  browser: "headless",
  chromium,
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
const thread = async () => (await api("POST", "/api/threads", {})).id as string;
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
const seed = await seedHarness({ api, app });
if (!only || only.some((x) => ["memory", "skills", "library"].includes(x)))
  await seedMemory({ api, thread, idle, pending, app, shop: false }).catch((e) =>
    console.error("seedMemory", e),
  );
await seedConnectors({ api, app }).catch((e) => console.error("seedConnectors", e));
await seedTeam({ api, app, thread, idle }).catch((e) => console.error("seedTeam", e));
const browser = await playwright.chromium.launch({ executablePath: chromium });
const shots: string[] = [];
const errors: string[] = [];
try {
  for (const theme of themes) {
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: "zh-TW",
      userAgent: IPHONE_UA,
      colorScheme: theme,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10_000);
    const pairing = await api("POST", "/api/link/pairings", {
      scopes: ["chat", "approve", "view_screen", "control_computer"],
    });
    const first = async (name: string, orient: keyof typeof ORIENT, settle = 700) => {
      if (only && !only.includes(name)) return;
      await page.waitForTimeout(settle);
      const path = join(outDir, `plain-${name}-${orient}-${theme}.png`);
      await page.screenshot({ path });
      shots.push(path);
    };
    // First run (§3.13): the pairing screen in both orientations, then 已連上.
    await page.setViewportSize({ width: ORIENT.landscape.w, height: ORIENT.landscape.h });
    await page.goto(`${relay.url}/?safe=${ORIENT.landscape.safe}`);
    await page.waitForSelector(".code-input");
    await page.evaluate("document.activeElement?.blur()");
    await first("pairing", "landscape");
    await page.setViewportSize({ width: ORIENT.portrait.w, height: ORIENT.portrait.h });
    await page.goto(`${relay.url}/?safe=${ORIENT.portrait.safe}`);
    await page.waitForSelector(".code-input");
    await page.evaluate("document.activeElement?.blur()");
    await first("pairing", "portrait");
    await page.fill(".code-input", pairingCode(pairing));
    await page.click(".pair-form button[type=submit]");
    await page.waitForSelector(".paired", { timeout: 15_000 });
    await first("paired", "portrait", 600);
    await page.click(".paired .btn");
    await page.waitForSelector(".app-shell", { timeout: 10_000 });
    await page.waitForSelector(".chat-sub[data-state='online']", { timeout: 15_000, state: "attached" });

    let o: keyof typeof ORIENT = "portrait";
    const shot = async (name: string, settle = 700) => {
      if (only && !only.includes(name)) return;
      await page.waitForTimeout(settle);
      const path = join(outDir, `plain-${name}-${o}-${theme}.png`);
      await page.screenshot({ path });
      shots.push(path);
    };
    const want = (...names: string[]) => !only || names.some((n) => only.includes(n));
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        errors.push(`${theme}/${o}/${name}: ${(e as Error).message.split("\n")[0]}`);
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    };
    let n = 0;
    const load = async (hash = "") => {
      const v = ORIENT[o];
      await page.goto(`${relay.url}/?safe=${v.safe}&n=${++n}${hash}`);
      await page.waitForSelector(".chat-sub[data-state='online']", { timeout: 15_000, state: "attached" });
      await page.waitForTimeout(300);
    };
    const tab = async (id: string) => {
      // Back out of an open conversation first: the chat layer covers the tab bar.
      await page.evaluate(
        `document.querySelector(".app-shell[data-chat='true'] .chat-bar .nav-back")?.click()`,
      );
      await page.waitForTimeout(350);
      await page.click(`.tab[data-tab='${id}']`);
      await page.waitForTimeout(350);
    };
    const openThreadTitled = async (title: string) => {
      await tab("chats");
      await page.evaluate(
        `[...document.querySelectorAll('.thread-row')].find(b => b.textContent.includes(${JSON.stringify(title)}))?.click()`,
      );
      await page.waitForTimeout(700);
    };

    for (const orient of ["portrait", "landscape"] as const) {
      o = orient;
      await page.setViewportSize({ width: ORIENT[o].w, height: ORIENT[o].h });
      await load();
      await step("chats", async () => shot("chats"));
      if (want("chat-empty", "approval-delete", "chat", "keyboard"))
        await step("chat-empty", async () => {
          await page.click(".threads-screen .nav-trail .icon-btn");
          await page.waitForSelector(".chat .suggestion");
          await page.evaluate("document.activeElement?.blur()");
          await shot("chat-empty");
        });
      if (o === "portrait" && want("approval-delete", "chat", "receipt"))
        await step("approval-delete", async () => {
          await page.fill(".composer-input", "刪除購物清單");
          await page.click(".send-btn");
          await page.waitForSelector(".approval[data-tier='danger']", { timeout: 20_000 });
          await shot("approval-delete", 1200);
          await page.click(".approval [data-role='approve']");
          await page.waitForSelector(".receipt", { timeout: 15_000 });
          await page.evaluate("document.activeElement?.blur()");
          await shot("receipt", 900);
        });
      if (o === "portrait" && want("approval-network", "approval-pay", "chat", "chat-pending", "activity"))
        await step("approval-pay", async () => {
          await page.fill(".composer-input", DEMO_PARALLEL_REQUEST);
          await page.click(".send-btn");
          await page.waitForSelector(".approval[data-tier='routine']", { timeout: 20_000 });
          await shot("approval-network", 1200);
          await page.click(".approval [data-role='approve']");
          await page.waitForSelector(".approval[data-tier='confirm']", { timeout: 30_000 });
          await shot("approval-pay", 1200);
          await page.keyboard.press("Escape");
          await page.waitForSelector(".pending-row", { timeout: 5_000 });
          for (let i = 0; i < 100; i++) {
            const done = await page.evaluate(
              "[...document.querySelectorAll('.item.report')].some(e => e.textContent.includes('比價'))",
            );
            if (done) break;
            await page.waitForTimeout(100);
          }
          await page.evaluate("document.activeElement?.blur()");
          await shot("chat", 600);
          await page.evaluate("document.querySelector('.act-sum')?.click()");
          await shot("chat-activity-open", 500);
          await page.evaluate(`(() => {
            const r = document.documentElement;
            r.style.setProperty("--vvh", Math.round(innerHeight * 0.6) + "px");
            r.style.setProperty("--vvt", "0px");
            r.dataset.keyboard = "open";
          })()`);
          await shot("keyboard", 500);
          await page.evaluate(`(() => {
            const r = document.documentElement;
            r.style.removeProperty("--vvh");
            r.style.removeProperty("--vvt");
            delete r.dataset.keyboard;
          })()`);
          await page.click(".chat-bar .nav-back");
          await tab("activity");
          await shot("activity", 900);
          await page.click(".pending-row, .activity-body [data-card]").catch(() => undefined);
          await page.waitForTimeout(300);
          await page.keyboard.press("Escape");
        });
      if (o === "landscape" && want("chat", "approval-pay"))
        await step("chat-landscape", async () => {
          await openThreadTitled("藍牙耳機");
          await page.evaluate("document.activeElement?.blur()");
          await shot("chat", 700);
          await page.evaluate("document.querySelector('.pending-row')?.click()");
          await page.waitForSelector(".approval", { timeout: 5_000 });
          await shot("approval-pay", 1200);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
          await page.click(".chat-bar .nav-back");
        });
      if (want("task-asking", "activity-harness", "tasks"))
        await step("task", async () => {
          await openThreadTitled(seed.threadTitle);
          await page.click(".chat-bar .nav-back");
          await tab("activity");
          await shot("activity-harness", 800);
          await page.click(`.activity-body [data-worker="${seed.asking}"]`);
          await page.waitForSelector(".task-page .wh-ask, .task-page .task-title", { timeout: 10_000 });
          await shot("task-asking", 1000);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
          await page.click(`.activity-body [data-worker="${seed.coding}"]`);
          await page.waitForSelector(".task-page .task-title", { timeout: 10_000 });
          await shot("task-coding", 1000);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
        });
      await step("library", async () => {
        await tab("library");
        await shot("library");
      });
      for (const [name, sel] of [
        ["memory", ".row[data-row='memory']"],
        ["skills", ".row[data-row='skills']"],
        ["team", ".row[data-row='team']"],
        ["connect", ".row[data-row='connect']"],
      ] as const)
        if (want(name))
          await step(name, async () => {
            await tab("library");
            await page.click(sel);
            await page.waitForSelector(".page-layer[data-open='true']", { timeout: 5_000 });
            await shot(name, 1200);
            await page.keyboard.press("Escape");
            await page.waitForTimeout(400);
          });
      await step("settings", async () => {
        await tab("settings");
        await shot("settings");
      });
      if (want("devices"))
        await step("devices", async () => {
          await tab("settings");
          await page.click(".row[data-row='devices']");
          await page.waitForSelector(".page-layer[data-open='true']", { timeout: 5_000 });
          await shot("devices", 1000);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
        });
      if (want("diag"))
        await step("diag", async () => {
          await tab("settings");
          await page.click(".row[data-row='diag']");
          await page.waitForSelector(".sheet-layer[data-open='true']", { timeout: 5_000 });
          await shot("diag", 1200);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
        });
      if (want("browser"))
        await step("browser", async () => {
          await load("#browser");
          await page.waitForSelector(".sheet-layer[data-open='true']", { timeout: 10_000 });
          await shot("browser", 1500);
          await page.keyboard.press("Escape");
        });
      if (want("routines"))
        await step("routines", async () => {
          await load("#routines");
          await page.waitForSelector(".sheet-layer[data-open='true']", { timeout: 10_000 });
          await shot("routines", 1200);
        });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.close().catch(() => undefined);
  await relay.close();
  for (const d of [dataDir, pwa]) rmSync(d, { recursive: true, force: true });
}
console.log(shots.join("\n"));
if (errors.length) console.error(`\nFAILED STEPS:\n${errors.join("\n")}`);
process.exit(0);
