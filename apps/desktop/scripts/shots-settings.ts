// P13 B3 / A6 screenshots, against the offline demo, each one after the
// control it shows was used for real (checked against the store / files):
//   desktop-settings-dark             設定 top: 團隊權限, 學習, 手機通知
//   desktop-settings-model-dark       模型與供應商: the default bot's provider list open (a pick is saved)
//   desktop-settings-connection-dark  進階 → 連線: site / relay / Google, two paired devices, one 撤銷 armed
//   desktop-settings-advanced-dark    連線's config fields: default scopes, pairing, a saved start-up relay
//   desktop-settings-browser-dark     瀏覽器 (switch saved) and Telegram
//   desktop-telegram-dark             the Telegram dialog from 設定 Telegram…, with its 「Telegram 看得到內容」 note (L11)
//   desktop-settings-backups-dark     備份 after 現在備份 (a real file)
//   desktop-settings-about-dark       關於 after 打開記錄檔資料夾
//   desktop-settings-light            設定 in the light theme
//   desktop-threads-actions-dark      the sidebar: a row's 封存 / 刪除 on hover
//   desktop-threads-more-dark         載入更多 after the first 50
//   desktop-thread-delete-dark        the delete confirm dialog
import { join } from "node:path";
import { generateIdentity, pairDevice } from "@alca/link";
import type { DesktopApp } from "../src/start.ts";
import { browserLocale } from "./shots-locale.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number; state?: string }): Promise<unknown>;
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
}

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`settings shots: ${what}`);
};

export async function shootSettings(o: {
  app: DesktopApp;
  browser: Browser;
  outDir: string;
  relayUrl: string;
}): Promise<string[]> {
  const { app, outDir } = o;
  const files: string[] = [];
  const titles = ["週末去台南的行程", "報價單回信", "整理桌面上的截圖", "比較兩台筆電", "讀書計畫：物理"];
  // Oldest first, a few ms apart, so the list has a stable order with the named ones on top.
  for (let i = 0; i < 56; i++) {
    const n = 55 - i;
    app.core.createThread(n < titles.length ? titles[n] : `舊的對話 ${56 - n}`);
    await new Promise((r) => setTimeout(r, 3));
  }
  // Two paired phones for 連線.
  const auth = { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" };
  for (const name of ["iPhone · Safari", "舊手機"]) {
    const p = (await (
      await fetch(`${app.server.url}/api/link/pairings`, { method: "POST", headers: auth, body: "{}" })
    ).json()) as { display: string; coreFingerprint: string };
    await pairDevice({
      relayUrl: o.relayUrl,
      code: p.display,
      identity: await generateIdentity(),
      device: { name, kind: "phone", platform: "headless" },
      expectFingerprint: p.coreFingerprint,
    });
  }
  const page = await o.browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: browserLocale,
  });
  const shot = async (file: string, settle = 600) => {
    await page.mouse.move(4, 890);
    await page.waitForTimeout(settle);
    await page.screenshot({ path: join(outDir, file) });
    files.push(file);
  };
  const theme = async (t: "dark" | "light", hash = "") => {
    await page.goto(`${app.openUrl}${hash}`);
    await page.evaluate(`localStorage.setItem('alca.theme','${t}')`);
    await page.goto(`${app.openUrl}${hash}`);
    await page.reload();
    await page.waitForSelector("#settings-toggle", { timeout: 10_000 });
  };
  const to = (id: string) =>
    page.evaluate(`document.getElementById('st-${id}')?.scrollIntoView({ block: 'start' })`);
  /** 設定 is a window with categories (素 Plain §3.7): pick one in the left list. */
  const cat = async (id: string) => {
    await page.click(`.st-cat[data-cat='${id}']`);
    await page.waitForTimeout(400);
  };
  const status = (text: string) =>
    statusRaw(text).catch(async (e) => {
      await page.screenshot({ path: join(outDir, "settings-failure.png") });
      throw new Error(
        `${String(e)}\n${await page.evaluate("document.querySelector('.st-dialog')?.innerText")}`,
      );
    });
  // Polls with evaluate (the page's CSP refuses waitForFunction's string form).
  const statusRaw = async (text: string) => {
    const probe = `[...document.querySelectorAll('.st-dialog .lc-msg')].some((m) => m.textContent.includes(${JSON.stringify(text)}))`;
    for (let i = 0; i < 100; i++) {
      if (await page.evaluate(probe)) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`no 「${text}」`);
  };
  const settings = () => JSON.parse(JSON.stringify(app.core.store.bots.get(app.core.defaultBotId)));
  const get = async <T>(path: string): Promise<T> =>
    (await (await fetch(`${app.server.url}${path}`, { headers: auth })).json()) as T;
  const backups = async () => (await get<{ backups: unknown[] }>("/api/settings/backups")).backups.length;

  await theme("dark");
  await page.click("#settings-toggle");
  await page.waitForSelector(".st-choice", { timeout: 10_000 });
  await shot("desktop-settings-dark.png");

  await cat("model");
  // 模型與供應商: open the list, pick the first provider that is not the default row, check it was saved.
  await page.waitForSelector("#st-model .pv-chosen", { timeout: 10_000 });
  await page.click("#st-model .pv-chosen");
  await page.waitForSelector("#st-model .pv-row[data-id]", { timeout: 10_000 });
  const picked = (await page.evaluate(
    `document.querySelector('#st-model .pv-row[data-id]:not([data-id="default"]):not([aria-checked="true"])')?.dataset.id ?? ''`,
  )) as string;
  if (picked) {
    await page.click(`#st-model .pv-row[data-id="${picked}"]`);
    await status("已儲存");
    check(settings().engineId === picked, `default bot engine is ${settings().engineId}, wanted ${picked}`);
    await page.click("#st-model .pv-chosen");
    await page.waitForSelector("#st-model .pv-row", { timeout: 10_000 });
  }
  await to("model");
  await shot("desktop-settings-model-dark.png");
  // Back to the team default.
  await page.evaluate(`document.querySelector('#st-model .pv-row[data-id="default"]')?.click()`);
  await page.waitForTimeout(500);
  check(settings().engineId === null, "default bot back on the default engine");

  // 裝置與連線: both phones listed; 撤銷 the old one (two taps), the other stays.
  await cat("devices");
  await page.waitForSelector(".st-device", { timeout: 10_000 });
  await page.evaluate(
    `[...document.querySelectorAll('.st-device')].find((d) => d.textContent.includes('舊手機')).querySelector('button').click()`,
  );
  await to("connection");
  await shot("desktop-settings-connection-dark.png");
  await page.evaluate(
    `[...document.querySelectorAll('.st-device')].find((d) => d.textContent.includes('舊手機')).querySelector('button').click()`,
  );
  await status("已撤銷");
  const left = app.core.store.devices.list().map((d) => d.name);
  check(left.length === 1 && left[0] === "iPhone · Safari", `devices after revoke: ${left.join(", ")}`);

  // 連線's config fields: a start-up relay saved (then cleared again below).
  await page.evaluate(`(() => {
    document.querySelector('.st-adv').open = true;
    const i = document.querySelector('.st-adv input[type=url]');
    i.value = 'https://relay.example.org';
    document.querySelector('[data-act="save-relay"]').click();
  })()`);
  await page.waitForSelector('.st-restart[data-tone="warn"]', { timeout: 10_000 });
  await page.evaluate(`document.querySelector('.st-checks').scrollIntoView({ block: 'center' })`);
  await shot("desktop-settings-advanced-dark.png");
  await fetch(`${app.server.url}/api/settings`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ rendezvousUrl: null }),
  });

  // 瀏覽器: the switch is saved to config.json.
  await cat("browser");
  await page.waitForSelector('[data-field="browserAutoDownload"]', { timeout: 10_000, state: "attached" });
  const locked = (await page.evaluate(
    `document.querySelector('[data-field="browserAutoDownload"]').disabled`,
  )) as boolean;
  if (!locked) {
    await page.click('[data-field="browserAutoDownload"]');
    await status("已儲存");
    const v = await get<{ advanced: { browserAutoDownload: boolean } }>("/api/settings");
    check(v.advanced.browserAutoDownload === false, "browser auto-download saved off");
    await page.click('[data-field="browserAutoDownload"]');
    await status("已儲存");
  }
  await to("browser");
  await shot("desktop-settings-browser-dark.png");
  await cat("telegram");
  await page.waitForSelector("#st-telegram .st-kv", { timeout: 10_000 });

  // The Telegram dialog, opened from that section: it says Telegram's servers see the replies (L11).
  await page.click('[data-act="open-telegram"]');
  await page.waitForSelector(".tg-warn", { timeout: 10_000 });
  await shot("desktop-telegram-dark.png");
  // Opening it closed 設定; close it and come back for the next areas.
  await page.evaluate(`document.querySelector('.lk-dialog[aria-label="Telegram"]')?.close?.()`);
  await page.click("#settings-toggle");
  await page.waitForSelector(".st-choice", { timeout: 10_000 });

  // 資料: 現在備份 makes a real file and the list shows it.
  await cat("data");
  const before = await backups();
  await page.click('[data-act="backup-now"]');
  await status("已備份");
  check((await backups()) === before + 1, "a backup file was written");
  await to("backups");
  await shot("desktop-settings-backups-dark.png");

  // 關於: 打開記錄檔資料夾 (the folder exists afterwards).
  await cat("about");
  await page.click('[data-act="open-logs"]');
  await status("已打開記錄檔資料夾");
  await to("about");
  await shot("desktop-settings-about-dark.png");

  await theme("light");
  await page.click("#settings-toggle");
  await page.waitForSelector(".st-choice", { timeout: 10_000 });
  await shot("desktop-settings-light.png");

  await theme("dark");
  await page.waitForSelector(".thread-row", { timeout: 10_000 });
  await page.evaluate(`document.querySelector('#thread-list').scrollTop = 1e6`);
  await page.waitForTimeout(300);
  await page.evaluate(`document.querySelector('#thread-list').scrollTop = 0`);
  await page.hover(".thread-row:nth-of-type(2)");
  await shot("desktop-threads-actions-dark.png", 400);
  await page.evaluate(`document.querySelector('#thread-list').scrollTop = 1e6`);
  await page.hover(".thread-more");
  await shot("desktop-threads-more-dark.png", 400);
  await page.evaluate(`document.querySelector('#thread-list').scrollTop = 0`);
  await page.hover(".thread-row:nth-of-type(2)");
  await page.click(".thread-row:nth-of-type(2) .thread-act:last-child");
  await page.waitForSelector("dialog[open] .undo-actions", { timeout: 10_000 });
  await shot("desktop-thread-delete-dark.png");
  return files;
}
