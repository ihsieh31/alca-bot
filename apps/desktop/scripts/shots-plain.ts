// 素 Plain review shots: the desktop screens in light and dark at 1440×900,
// against the offline demo. Faster than screenshot.ts when iterating on the UI.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright ALCA_CHROMIUM=/usr/bin/chromium \
//   ALCA_PLAIN=chat,browser,workers,library,connect,team,settings \
//   node --disable-warning=ExperimentalWarning apps/desktop/scripts/shots-plain.ts <outDir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findChromium } from "@alca/browser";
import { generateIdentity, LinkClient, pairDevice } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { DEMO_PARALLEL_REQUEST } from "../src/demo-agents.ts";
import { startDesktop } from "../src/start.ts";
import { seedConnectors } from "./seed-connectors.ts";
import { seedMemory } from "./seed-memory.ts";
import { seedTeam } from "./seed-team.ts";
import { browserLocale } from "./shots-locale.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  screenshot(opts: { path: string }): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(sel: string): Promise<void>;
  hover(sel: string): Promise<void>;
  mouse: { move(x: number, y: number): Promise<void> };
}
interface Browser {
  newPage(opts: Record<string, unknown>): Promise<Page>;
  close(): Promise<void>;
}

const outDir = resolve(process.argv[2] ?? "docs/screenshots");
mkdirSync(outDir, { recursive: true });
const sets = new Set(
  (process.env.ALCA_PLAIN ?? "chat,browser,workers,library,connect,team,settings").split(","),
);
const chromium = process.env.ALCA_CHROMIUM || findChromium();
const modPath = process.env.PLAYWRIGHT_MODULE;
const pw = (await import(modPath ? pathToFileURL(join(modPath, "index.mjs")).href : "playwright")) as {
  chromium: { launch(opts?: Record<string, unknown>): Promise<Browser> };
};

// 新增手機 / 連線 need Link on: a local relay.
const relay = sets.has("link") ? await startRendezvous({ port: 0 }) : undefined;
const dataDir = mkdtempSync(join(tmpdir(), "alca-plain-"));
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ engineering: { workers: { watchdogSec: 1 } } }));
const app = await startDesktop({
  engine: "demo",
  dataDir,
  port: 0,
  browser: chromium ? "headless" : "off",
  ...(chromium ? { chromium } : {}),
  composioMock: true,
  vaultKeySource: "file",
  ...(relay ? { rendezvous: relay.url } : {}),
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle = async (threadId: string) => {
  for (let i = 0; i < 400; i++) {
    const t = (await api("GET", `/api/threads/${threadId}`)) as { thread: { busy: boolean } };
    if (!t.thread.busy) return;
    await sleep(25);
  }
};
const pending = async (kind: "approvals" | "questions") => {
  for (let i = 0; i < 400; i++) {
    const p =
      kind === "approvals"
        ? app.core.store.human.pendingApprovals()
        : app.core.store.human.pendingQuestions();
    if (p[0]) return p[0].id;
    await sleep(25);
  }
  throw new Error(`no pending ${kind}`);
};
const thread = async () => (await api("POST", "/api/threads", {})).id as string;

const browser = await pw.chromium.launch(chromium ? { executablePath: chromium } : {});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: browserLocale,
});
const files: string[] = [];
const theme = async (t: "dark" | "light", ready = ".thread-item, .empty") => {
  await page.evaluate(`localStorage.setItem('alca.theme','${t}')`);
  await page.reload();
  await page.waitForSelector(ready, { timeout: 15_000 });
};
const shot = async (file: string, settle = 600) => {
  await page.mouse.move(1430, 6);
  await page.waitForTimeout(settle);
  await page.screenshot({ path: join(outDir, file) });
  files.push(file);
};
const both = async (name: string, go: () => Promise<void>, ready?: string) => {
  for (const t of ["light", "dark"] as const) {
    await theme(t, ready);
    await go();
    await shot(`${name}-${t}.png`);
  }
};
const clickText = (sel: string, needle: string) =>
  page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.includes(${JSON.stringify(needle)}))?.click()`,
  );

try {
  await page.goto(app.openUrl);
  if (sets.has("chat")) {
    const a = await thread();
    await api("POST", `/api/threads/${a}/messages`, { text: "幫我寫一則筆記：週六早上去南門市場買菜" });
    await api("POST", `/api/approvals/${await pending("approvals")}`, { decision: "approved" });
    await idle(a);
    const c = await thread();
    await api("POST", `/api/threads/${c}/messages`, { text: "你好，今天可以幫我做什麼？" });
    await idle(c);
    await api("POST", `/api/threads/${c}/messages`, { text: "刪除購物清單" });
    await pending("approvals");
    await sleep(600);
    // A question left open in its own conversation (asked after the delete card is up).
    const b = await thread();
    await api("POST", `/api/threads/${b}/messages`, { text: "問我下午的會議要排幾點" });
    await pending("questions").catch(() => undefined);
    await sleep(400);
    await both("chat-approval", async () => {
      await clickText(".thread-item", "你好");
      await page.waitForSelector(".card[data-state='pending']", { timeout: 10_000 });
    });
    await both("chat-question", async () => {
      await clickText(".thread-item", "會議");
      await page.waitForSelector(".card[data-state='pending']", { timeout: 10_000 });
    });
    await both("chat-note", async () => {
      await clickText(".thread-item", "筆記");
      await page.waitForSelector(".msg-assistant", { timeout: 10_000 });
    });
    await both("empty", async () => {
      await page.click("#new-thread");
      await page.waitForSelector(".empty");
    });
    await theme("light");
    await page.hover(".thread-row:nth-of-type(3)");
    await shot("sidebar-hover-light.png", 300);
  }
  if (sets.has("browser") && chromium && app.browser) {
    const d = await thread();
    await api("POST", `/api/threads/${d}/messages`, { text: "幫我在示範商店結帳" });
    const waitCard = async (cls: string) => {
      for (let i = 0; i < 400; i++) {
        const hit = app.core.store.human.pendingApprovals().find((x) => x.actionClass === cls);
        if (hit) return hit.id;
        await sleep(25);
      }
      throw new Error(`no ${cls} card`);
    };
    await api("POST", `/api/approvals/${await waitCard("network")}`, { decision: "approved" });
    await waitCard("payment");
    await sleep(600);
    await both("browser", async () => {
      await clickText(".thread-item", "示範商店");
      await page.waitForSelector(".bp-frame img[src]", { timeout: 10_000 });
      await page.waitForTimeout(600);
    });
  }
  if (sets.has("workers") && chromium && app.browser) {
    const e = await thread();
    await api("POST", `/api/threads/${e}/messages`, { text: DEMO_PARALLEL_REQUEST });
    for (let i = 0; i < 600; i++) {
      const hit = app.core.store.human
        .pendingApprovals()
        .find(
          (x) => x.actionClass === "network" && x.runId && app.core.store.runs.get(x.runId)?.threadId === e,
        );
      if (hit) {
        await api("POST", `/api/approvals/${hit.id}`, { decision: "approved" });
        break;
      }
      await sleep(25);
    }
    await sleep(4000);
    await both("workers", async () => {
      await clickText(".thread-item", "同時幫我");
      await page.waitForSelector("#workers-toggle:not([hidden])", { timeout: 10_000 });
      await page.click("#workers-toggle");
      await page.waitForSelector(".wp-item", { timeout: 10_000 });
    });
    await both("worker-detail", async () => {
      await clickText(".thread-item", "同時幫我");
      await page.waitForSelector("#workers-toggle:not([hidden])", { timeout: 10_000 });
      await page.click("#workers-toggle");
      await page.waitForSelector(".wp-item", { timeout: 10_000 });
      await page.click(".wp-item");
      await page.waitForTimeout(500);
    });
  }
  if (sets.has("library")) {
    await seedMemory({ api, thread, idle, pending, app, shop: Boolean(chromium && app.browser) });
    await both(
      "memory",
      async () => {
        await page.click("#library-toggle");
        await page.waitForSelector(".lb-row", { timeout: 10_000 });
      },
      "#library-toggle:not([hidden])",
    );
    await both(
      "skills",
      async () => {
        await page.click("#library-toggle");
        await page.waitForSelector(".lb-row", { timeout: 10_000 });
        await clickText(".lb-tab", "技能");
        await page.waitForTimeout(400);
      },
      "#library-toggle:not([hidden])",
    );
  }
  if (sets.has("connect")) {
    await seedConnectors({ api, app });
    await both(
      "connectors",
      async () => {
        await page.click("#connect-toggle");
        await page.waitForTimeout(900);
      },
      "#connect-toggle:not([hidden])",
    );
    await page.evaluate("document.querySelector('.connect .lb-scroll')?.scrollTo(0, 1e6)");
    await shot("connectors-end-dark.png");
    await both(
      "routines",
      async () => {
        await page.click("#routines-toggle");
        await page.waitForTimeout(900);
      },
      "#routines-toggle:not([hidden])",
    );
  }
  if (sets.has("team")) {
    await seedTeam({ api, app, thread, idle });
    await both(
      "team",
      async () => {
        await page.click("#team-toggle");
        await page.waitForSelector(".tm-row[data-bot]", { timeout: 10_000 });
      },
      "#team-toggle:not([hidden])",
    );
    await both(
      "team-activity",
      async () => {
        await page.click("#team-toggle");
        await page.waitForSelector(".tm-row[data-bot]", { timeout: 10_000 });
        await clickText(".lb-tab", "協作");
        await page.waitForSelector(".tm-peer-row", { timeout: 10_000 });
        await page.click(".tm-peer-row");
        await page.waitForTimeout(700);
      },
      "#team-toggle:not([hidden])",
    );
    await both(
      "bot-edit",
      async () => {
        await page.click("#team-toggle");
        await page.waitForSelector(".tm-row[data-bot]", { timeout: 10_000 });
        await page.click(".tm-row[data-bot]");
        await page.waitForSelector(".tm-editor", { timeout: 10_000 });
        await page.evaluate("document.querySelector('.be-adv')?.setAttribute('open','')");
        await page.waitForTimeout(500);
      },
      "#team-toggle:not([hidden])",
    );
    await both(
      "team-chat",
      async () => {
        await clickText(".thread-item", "請研究員");
        await page.waitForSelector(".msg-by", { timeout: 10_000 });
      },
      "#team-toggle:not([hidden])",
    );
  }
  if (sets.has("settings")) {
    for (const cat of ["general", "model", "devices", "browser", "data", "about"]) {
      await both(
        `settings-${cat}`,
        async () => {
          await page.click("#settings-toggle");
          await page.waitForSelector(".st-window[open] .st-cat", { timeout: 10_000 });
          await page.click(`.st-cat[data-cat='${cat}']`);
          await page.waitForTimeout(900);
        },
        "#settings-toggle",
      );
    }
  }
  if (sets.has("providers")) {
    await both(
      "providers",
      async () => {
        await page.click("#providers-toggle");
        await page.waitForSelector(".pv-row", { timeout: 10_000 });
        await page.waitForTimeout(500);
      },
      "#providers-toggle",
    );
    await both(
      "provider-open",
      async () => {
        await page.click("#providers-toggle");
        await page.waitForSelector(".pv-row", { timeout: 10_000 });
        await page
          .click(".pv-row[data-id='openrouter']")
          .catch(() => page.click(".pv-row[data-id='openai']"));
        await page.waitForSelector(".pv-model, .pv-empty", { timeout: 10_000 });
        await page.waitForTimeout(800);
      },
      "#providers-toggle",
    );
  }
  if (sets.has("link") && relay) {
    // One phone already paired (a headless Link client, online), then a fresh code + QR.
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
    for (let i = 0; i < 400 && phone.status !== "online"; i++) await sleep(25);
    const openLink = async () => {
      await page.evaluate("document.getElementById('phone-toggle')?.click()");
      await page.waitForSelector(".lk-devices li", { timeout: 10_000 });
    };
    await both("link-empty", openLink, "#settings-toggle");
    // Making a code needs the approve key: a fresh launch URL (its code is single-use) per theme.
    for (const t of ["light", "dark"] as const) {
      await page.evaluate(`localStorage.setItem('alca.theme','${t}')`);
      await page.goto("about:blank");
      await page.goto(app.openUrl);
      await page.waitForSelector("#settings-toggle", { timeout: 15_000 });
      await openLink();
      await page.click(".lk-pair .btn-primary");
      await page.waitForSelector("img.lk-qr", { timeout: 10_000 });
      await shot(`link-${t}.png`);
    }
    await api("POST", "/api/link/connection/check");
    await both(
      "connection",
      async () => {
        await openLink();
        await clickText(".lk-status .lb-act", "連線");
        await page.waitForSelector(".lc-state", { timeout: 10_000 });
        await page.evaluate("document.querySelector('.lc-tech')?.setAttribute('open','')");
      },
      "#settings-toggle",
    );
    await both(
      "telegram",
      async () => {
        await openLink();
        await clickText(".lk-status .lb-act", "Telegram");
        await page.waitForTimeout(700);
      },
      "#settings-toggle",
    );
    phone.stop();
  }
} catch (e) {
  console.error("plain shots failed:", e);
  await page.screenshot({ path: join(outDir, "failure.png") }).catch(() => undefined);
} finally {
  // A close that never settles would drain the loop (exit 13) before the list prints.
  const capped = (p: Promise<unknown> | undefined) => Promise.race([p, sleep(5000)]);
  await capped(browser.close());
  await capped(app.close());
  await capped(relay?.close());
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(`plain shots: ${files.join(", ")}`);
process.exit(0);
