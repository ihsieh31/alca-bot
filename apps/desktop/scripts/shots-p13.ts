// P13 screenshots (agent features), against the offline demo:
//   desktop-bot-edit-p13-dark   the bot editor's 進階: 工作資料夾, 指令審查 (on, a picked engine), 提前做 + 安靜時段
//   desktop-undo-strip-dark     the 復原 strip above the composer (the newest turn that changed files)
//   desktop-undo-confirm-dark   the confirm dialog listing the files (one new file, removed on undo)
//   desktop-undo-done-dark      after 復原: the files are back, the strip says so
//   desktop-undo-error-dark     a refused undo (a later conversation changed the same file): the reason
//   desktop-early-dark          例行工作: 提前做 items (安靜時段 / 準備中 / 草稿好了 / 沒有完成)
// The file edits are written into the bot's own folder with their snapshots
// (what the journal keeps before a file tool runs), so the undo is the real
// code path: it restores and removes real files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesktopApp } from "../src/start.ts";
import { seedConnectors } from "./seed-connectors.ts";
import { browserLocale } from "./shots-locale.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number; state?: string }): Promise<unknown>;
  screenshot(opts: { path: string }): Promise<unknown>;
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
type Api = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;

export async function shootP13(o: {
  app: DesktopApp;
  api: Api;
  thread: () => Promise<string>;
  idle: (threadId: string) => Promise<void>;
  browser: Browser;
  outDir: string;
}): Promise<string[]> {
  const { app, api, outDir } = o;
  const files: string[] = [];
  const store = app.core.store;
  const botId = app.core.defaultBotId;
  const page = await o.browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: browserLocale,
  });
  const shot = async (file: string) => {
    await page.mouse.move(4, 890);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, file) });
    files.push(file);
  };
  const fresh = async () => {
    await page.evaluate(`localStorage.setItem('alca.theme','dark')`);
    await page.reload();
    await page.waitForSelector("#team-toggle:not([hidden])", { timeout: 10_000 });
  };

  // ── the bot editor ───────────────────────────────────────────
  const engines = ((await api("GET", "/api/team")) as { engines?: Array<{ id: string }> }).engines ?? [];
  const reviewEngine = engines.find((e) => e.id !== "default")?.id ?? null;
  const patch = await api("PATCH", `/api/bots/${botId}`, {
    shellReview: "on",
    ...(reviewEngine ? { shellReviewEngine: reviewEngine } : {}),
    earlyWork: "on",
    quietHours: "22:00-07:00",
  });
  if (typeof patch.error === "string") throw new Error(`bot settings: ${patch.error}`);
  await page.goto(app.openUrl);
  await fresh();
  await page.click("#team-toggle");
  await page.waitForSelector(`.tm-card[data-bot="${botId}"]`, { timeout: 10_000 });
  await page.evaluate(
    `[...document.querySelector('.tm-card[data-bot="${botId}"]').querySelectorAll('button')].find(b => b.textContent.includes('編輯'))?.click()`,
  );
  await page.waitForSelector(".tm-editor", { timeout: 10_000 });
  await page.evaluate(`(() => {
    document.querySelector('.be-adv').open = true;
    document.activeElement?.blur?.();
    document.getElementById('be-workdir').closest('.be-field, label, div').scrollIntoView({ block: 'start' });
  })()`);
  await shot("desktop-bot-edit-p13-dark.png");

  // ── 復原 ─────────────────────────────────────────────────────
  const root = app.workspace.folder(botId).path;
  mkdirSync(join(root, "notes"), { recursive: true });
  const edit = (threadId: string, turn: string, rel: string, before: string | null, after: string) => {
    const path = join(root, rel);
    store.snapshots.add({
      botId,
      threadId,
      runId: turn,
      turnRunId: turn,
      tool: "file_write",
      path,
      existed: before !== null,
      ...(before !== null ? { content: new TextEncoder().encode(before), size: before.length } : {}),
    });
    writeFileSync(path, after);
  };
  const threadA = await o.thread();
  await api("POST", `/api/threads/${threadA}/messages`, {
    text: "旅行清單加上轉接頭和雨傘，再開一份行前待辦",
  });
  await o.idle(threadA);
  edit(
    threadA,
    "run_shot_a",
    "notes/旅行清單.md",
    "# 旅行清單\n- 護照\n",
    "# 旅行清單\n- 護照\n- 轉接頭\n- 雨傘\n",
  );
  edit(threadA, "run_shot_a", "notes/README.md", "筆記\n", "筆記（已整理）\n");
  edit(threadA, "run_shot_a", "notes/行前待辦.md", null, "# 行前待辦\n- 換日幣\n");
  await fresh();
  await page.waitForSelector(".thread-item", { timeout: 10_000 });
  await page.evaluate(
    `[...document.querySelectorAll('.thread-item')].find(b => b.textContent.includes('旅行清單'))?.click()`,
  );
  await page.waitForSelector(".undo-strip:not([hidden]) .undo-btn", { timeout: 10_000 });
  await shot("desktop-undo-strip-dark.png");
  await page.click(".undo-strip .undo-btn");
  await page.waitForSelector(".undo-dialog[open]", { timeout: 5_000 });
  await shot("desktop-undo-confirm-dark.png");
  await page.click(".undo-dialog .btn-primary");
  await page.waitForSelector(".undo-strip[data-tone='ok']", { timeout: 5_000 });
  await shot("desktop-undo-done-dark.png");
  // The real files are back: the edited ones restored, the new one gone.
  if (
    readFileSync(join(root, "notes/旅行清單.md"), "utf8") !== "# 旅行清單\n- 護照\n" ||
    existsSync(join(root, "notes/行前待辦.md"))
  )
    throw new Error("復原 did not put the files back");

  // A refused undo: a later conversation changed the same file.
  const threadB = await o.thread();
  await api("POST", `/api/threads/${threadB}/messages`, { text: "會議摘要加上這次的決定" });
  await o.idle(threadB);
  edit(threadB, "run_shot_b", "notes/會議摘要.md", "# 摘要\n", "# 摘要\n- 決定：下週上線\n");
  const threadC = await o.thread();
  await api("POST", `/api/threads/${threadC}/messages`, { text: "會議摘要後面補上待辦" });
  await o.idle(threadC);
  edit(
    threadC,
    "run_shot_c",
    "notes/會議摘要.md",
    "# 摘要\n- 決定：下週上線\n",
    "# 摘要\n- 決定：下週上線\n- 待辦：通知客戶\n",
  );
  await fresh();
  await page.waitForSelector(".thread-item", { timeout: 10_000 });
  await page.evaluate(
    `[...document.querySelectorAll('.thread-item')].find(b => b.textContent.includes('這次的決定'))?.click()`,
  );
  await page.waitForSelector(".undo-strip:not([hidden]) .undo-btn", { timeout: 10_000 });
  await page.click(".undo-strip .undo-btn");
  await page.waitForSelector(".undo-dialog[open]", { timeout: 5_000 });
  await page.click(".undo-dialog .btn-primary");
  await page.waitForSelector(".undo-dialog .undo-error:not([hidden])", { timeout: 5_000 });
  await shot("desktop-undo-error-dark.png");
  await page.evaluate(`document.querySelector('.undo-dialog')?.close()`);

  // ── 提前做 in 例行工作 ───────────────────────────────────────
  await seedConnectors({ api, app });
  const drafts = ((await api("GET", "/api/routines")) as { drafts?: Array<{ id: string }> }).drafts ?? [];
  const offer = (title: string, goal: string) =>
    store.early.offer({ botId, threadId: threadA, source: "trigger", refId: `shot-${title}`, title, goal })
      .item;
  const ready = offer("回覆：下週三的報價", "先擬好回覆草稿");
  store.early.started(ready.id, "wrk_shot_ready");
  store.early.finish(ready.id, "ready", { draftIds: drafts.slice(0, 1).map((d) => d.id) });
  const running = offer("整理：客戶寄來的報價單", "讀附件，列出要確認的地方");
  store.early.started(running.id, "wrk_shot_running");
  const failed = offer("準備：下週一的 1:1", "看上次的筆記，列出要談的事");
  store.early.started(failed.id, "wrk_shot_failed");
  store.early.finish(failed.id, "failed", { detail: "日曆讀取失敗，稍後會再試" });
  const later = offer("回覆：晚上寄來的合作邀請", "先擬好回覆草稿");
  const morning = new Date();
  morning.setDate(morning.getDate() + 1);
  morning.setHours(7, 0, 0, 0);
  store.early.defer(later.id, morning, "安靜時段");
  await fresh();
  await page.waitForSelector("#connect-toggle:not([hidden])", { timeout: 10_000 });
  await page.click("#connect-toggle");
  await page.click("#routines-toggle");
  await page.waitForSelector(".rt-early-row", { timeout: 10_000 });
  await page.evaluate(`document.querySelector('.rt-drafts')?.scrollIntoView({ block: 'start' })`);
  await shot("desktop-early-dark.png");
  return files;
}
