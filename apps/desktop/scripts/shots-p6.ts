// Desktop screenshots of Phase 6 (worker harness UI), against seed-harness.ts:
// the worker panel on a coding worker (harness, phase, doneWhen, the red
// verification round, budget, the 完全授權 log), its git snapshots with the
// confirm step in front of 還原, and the bot editor's 進階 harness settings.
//
//   pnpm screenshots:p6   (needs Playwright and Chromium; see docs/screenshots/README.md)
import { join } from "node:path";
import type { HarnessSeed } from "./seed-harness.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { path: string }): Promise<unknown>;
  click(sel: string): Promise<void>;
  mouse: { move(x: number, y: number): Promise<void> };
}

export async function shootP6(
  page: Page,
  openUrl: string,
  outDir: string,
  seed: HarnessSeed,
): Promise<string[]> {
  const files: string[] = [];
  const shot = async (file: string) => {
    await page.mouse.move(4, 890);
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(outDir, file) });
    files.push(file);
  };
  const clickText = (sel: string, needle: string) =>
    page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.includes(${JSON.stringify(needle)}))?.click()`,
    );
  await page.goto(openUrl);
  await page.evaluate(`localStorage.setItem('alca.theme','dark')`);
  await page.reload();

  // 1. The worker panel on the coding worker.
  await page.waitForSelector(".thread-item", { timeout: 10_000 });
  await clickText(".thread-item", seed.threadTitle);
  await page.waitForSelector("#workers-toggle", { timeout: 10_000 });
  await page.click("#workers-toggle");
  await page.waitForSelector(".wp-item", { timeout: 10_000 });
  await clickText(".wp-item", seed.codingTitle);
  await page.waitForSelector(".wh-check", { timeout: 10_000 });
  await shot("worker-panel-desktop.png");

  // 2. Its snapshots, with the confirm step in front of 還原 (nothing is restored).
  await clickText(".wh-snaps button", "顯示快照");
  await page.waitForSelector(".wh-snap-list li", { timeout: 10_000 });
  await page.evaluate(
    `[...document.querySelectorAll('.wh-snap-list li')][1]?.querySelector('button')?.click()`,
  );
  await page.waitForSelector(".wh-confirm", { timeout: 10_000 });
  await page.evaluate(`document.querySelector('.wh-snaps').scrollIntoView({ block: 'end' })`);
  await shot("snapshots.png");

  // 3. The bot editor with 進階 open on the harness settings (完全授權 on).
  await page.reload();
  await page.waitForSelector("#team-toggle:not([hidden])", { timeout: 10_000 });
  await page.click("#team-toggle");
  await page.waitForSelector(`.tm-card[data-bot="${seed.engineer}"]`, { timeout: 10_000 });
  await page.evaluate(
    `[...document.querySelector('.tm-card[data-bot="${seed.engineer}"]').querySelectorAll('button')].find(b => b.textContent.includes('編輯'))?.click()`,
  );
  await page.waitForSelector(".tm-editor", { timeout: 10_000 });
  await page.evaluate(`document.querySelector('.be-adv').open = true`);
  await page.waitForSelector("#be-harness", { timeout: 10_000 });
  await page.evaluate(`document.querySelector('#be-harness').scrollIntoView({ block: 'start' })`);
  await shot("bot-editor-advanced.png");
  return files;
}
