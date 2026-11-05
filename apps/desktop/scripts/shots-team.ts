// Desktop screenshots of the team (P7): the 團隊 view (roster with who is
// doing what, collaboration rules), the bot editor with 進階 open, the
// collaboration trail, and a conversation where teammates speak with bylines
// and a teammate's delete waits for the person (+ the @mention list).
import { join } from "node:path";
import type { TeamSeed } from "./seed-team.ts";

interface Page {
  evaluate(fn: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { path: string }): Promise<unknown>;
  click(sel: string): Promise<void>;
  keyboard: { type(text: string): Promise<void> };
}

export async function shootTeam(page: Page, outDir: string, seed: TeamSeed): Promise<string[]> {
  const files: string[] = [];
  const shot = async (file: string) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(outDir, file) });
    files.push(file);
  };
  const fresh = async () => {
    await page.evaluate(`localStorage.setItem('alca.theme','dark')`);
    await page.reload();
    await page.waitForSelector("#team-toggle:not([hidden])", { timeout: 10_000 });
  };
  const openThread = async (needle: string) => {
    await page.waitForSelector(".thread-item", { timeout: 10_000 });
    await page.evaluate(
      `[...document.querySelectorAll('.thread-item')].find(b => b.textContent.includes(${JSON.stringify(needle)}))?.click()`,
    );
  };

  // 團隊 · 成員
  await fresh();
  await page.click("#team-toggle");
  await page.waitForSelector(".tm-row[data-bot]", { timeout: 10_000 });
  await shot("desktop-team-dark.png");

  // 協作紀錄 with the first request open (its steps and the teammate's conversation).
  await page.evaluate(
    `[...document.querySelectorAll('.lb-tab')].find(b => b.textContent.includes('協作紀錄'))?.click()`,
  );
  await page.waitForSelector(".tm-peer-row", { timeout: 10_000 });
  await page.evaluate(
    `[...document.querySelectorAll('.tm-peer-row')].find(b => b.textContent.includes('研究員') && b.textContent.includes('完成'))?.click()`,
  );
  await page.waitForSelector(".tm-step", { timeout: 10_000 });
  await shot("desktop-team-activity-dark.png");

  // The editor: name, avatar, tone, role; 進階 open.
  await page.evaluate(
    `[...document.querySelectorAll('.lb-tab')].find(b => b.textContent.includes('成員'))?.click()`,
  );
  await page.waitForSelector(`.tm-row[data-bot="${seed.writer}"]`, { timeout: 10_000 });
  await page.evaluate(`document.querySelector('.tm-row[data-bot="${seed.writer}"]')?.click()`);
  await page.waitForSelector(".tm-editor", { timeout: 10_000 });
  await page.evaluate(`document.querySelector('.be-adv').open = true`);
  await shot("desktop-bot-edit-dark.png");
  if (process.env.ALCA_SHOTS_REVIEW) {
    // 封存 asks in the editor's footer (no native dialog); 先不要 puts the footer back.
    await page.evaluate(
      `[...document.querySelectorAll('.be-foot button')].find(b => b.textContent === '封存')?.click()`,
    );
    await page.waitForSelector(".be-foot[data-confirm='true']", { timeout: 5_000 });
    await shot("review-bot-archive-dark.png");
    await page.evaluate(
      `[...document.querySelectorAll('.be-foot button')].find(b => b.textContent === '先不要')?.click()`,
    );
  }

  // A conversation: Alca and teammates with bylines, a peer report row, the @mention list.
  await fresh();
  await openThread("請研究員");
  await page.waitForSelector(".msg-by", { timeout: 10_000 });
  await page.evaluate(`document.querySelector('#timeline').scrollTop = 1e6`);
  await page.click("#composer-input");
  await page.keyboard.type("@");
  await page.waitForSelector(".mention-box:not([hidden])", { timeout: 10_000 });
  await shot("desktop-team-chat-dark.png");

  // A teammate's delete waits for the person, in the person's conversation.
  await fresh();
  await openThread("請行程");
  await page.waitForSelector(".card[data-state='pending']", { timeout: 10_000 });
  await shot("desktop-team-card-dark.png");
  return files;
}
