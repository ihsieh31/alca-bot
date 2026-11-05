// P11 screenshots: 模型與供應商. Fake CLIs on PATH (Claude Code installed,
// Codex installed but logged out, Gemini CLI with a key in its env; OpenCode
// missing) and a local mock standing in for OpenRouter's model list, so the
// statuses, the live model list (context + price) and the forms are real
// code paths with no network. Model prices in the mock are illustrative.
//   desktop-providers-dark       the settings sheet: six pinned, 更多供應商 folded, OpenRouter open
//   desktop-model-picker-dark    the bot editor: OpenRouter picked, its searchable model list
//   desktop-custom-provider-dark 新增自訂供應商 (an ACP agent)
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startDesktop } from "../src/start.ts";
import { browserLocale } from "./shots-locale.ts";
import type { Pw } from "./shots-p10.ts";

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  screenshot(opts: { path: string }): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(sel: string): Promise<void>;
  fill(sel: string, v: string): Promise<void>;
  mouse: { move(x: number, y: number): Promise<void> };
}

// A stand-in for OpenRouter's GET /models, with real entries (ids, names, context, $/M tokens) as
// https://openrouter.ai/api/v1/models listed them on 2026-11-04.
const MODELS = [
  ["anthropic/claude-sonnet-5.5", "Anthropic: Claude Sonnet 5.5", 1_000_000, 2, 10],
  ["anthropic/claude-haiku-5.5", "Anthropic: Claude Haiku 5.5", 1_000_000, 0.1, 0.5],
  ["anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", 1_000_000, 4, 20],
  ["deepseek/deepseek-v4.1-flash", "DeepSeek: DeepSeek V4.1 Flash", 1_048_576, 0.045, 0.5],
  ["google/gemini-3.8-flash", "Google: Gemini 3.8 Flash", 1_048_576, 0.825, 4.125],
  ["google/gemini-4-argon", "Google: Gemini 4 Argon", 1_048_576, 2, 10],
  ["mistralai/mistral-large-4-0", "Mistral: Mistral Large 4", 1_048_576, 0.7, 2.1],
  ["openai/gpt-6-luna", "OpenAI: GPT-6 Luna", 1_050_000, 0.1, 0.5],
  ["openai/gpt-6.1-sol", "OpenAI: GPT-6.1 Sol", 1_050_000, 2, 10],
  ["qwen/qwen3.8-flash", "Qwen: Qwen3.8 Flash", 1_000_000, 0.15, 0.47],
  ["x-ai/grok-4.7", "SpaceXAI: Grok 4.7", 500_000, 2, 6],
  ["nvidia/nemotron-3.5-super-vl:free", "NVIDIA: Nemotron 3.5 Super VL (free)", 1_000_000, 0, 0],
] as const;

function fakeBins(): string {
  const dir = mkdtempSync(join(tmpdir(), "alca-p11-bin-"));
  const put = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  put("claude", 'echo "2.0.30 (Claude Code)"');
  put(
    "codex",
    'case "$1" in --version) echo "codex-cli 0.55.0";; login) echo "Not logged in"; exit 1;; esac',
  );
  put("gemini", 'echo "0.12.0"');
  put("qwen", 'echo "0.1.4"');
  return dir;
}

export async function shootP11(o: { pw: Pw; chromium: string; outDir: string }): Promise<string[]> {
  const shots: string[] = [];
  const bin = fakeBins();
  const home = mkdtempSync(join(tmpdir(), "alca-p11-home-"));
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
  // Only our fake CLIs (and node) are found; a fresh HOME has no CLI logins.
  process.env.PATH = [bin, "/usr/bin", "/bin"].join(delimiter);
  process.env.HOME = home;
  process.env.GEMINI_API_KEY = "set-in-the-shell";
  const list = createServer((req, res) => {
    if (req.url?.startsWith("/api/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: MODELS.map(([id, name, ctx, inP, outP]) => ({
            id,
            name,
            context_length: ctx,
            pricing: { prompt: String(inP / 1e6), completion: String(outP / 1e6) },
          })),
        }),
      );
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => list.listen(0, "127.0.0.1", () => r()));
  const listBase = `http://127.0.0.1:${(list.address() as AddressInfo).port}/api/v1`;
  const dataDir = mkdtempSync(join(tmpdir(), "alca-p11-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({}));
  const app = await startDesktop({
    engine: "demo",
    dataDir,
    port: 0,
    browser: "off",
    vaultKeySource: "file",
  });
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then((r) => r.json());
  await call("PUT", "/api/providers/openrouter/key", { key: "sk-or-example-not-a-real-key" });
  await call("PATCH", "/api/providers/openrouter", { baseUrl: listBase, defaultModel: "openai/gpt-6-luna" });
  const browser = await o.pw.chromium.launch({ executablePath: o.chromium });
  try {
    const page = (await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      locale: browserLocale,
    })) as unknown as Page;
    const shot = async (file: string) => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(o.outDir, file) });
      shots.push(file);
    };
    await page.goto(app.openUrl);
    await page.evaluate(`localStorage.setItem('alca.theme','dark')`);
    await page.reload();
    await page.waitForSelector("#providers-toggle:not([hidden])", { timeout: 15_000 });

    // 1. the settings sheet: six pinned with their status and fix, the rest folded
    await page.click("#providers-toggle");
    await page.waitForSelector('.pv-sheet .pv-row[data-id="openrouter"]', { timeout: 10_000 });
    await shot("desktop-providers-dark.png");
    if (process.env.ALCA_SHOTS_REVIEW) {
      await page.click('.pv-sheet .pv-row[data-id="openrouter"]');
      await page.waitForSelector(".pv-detail .pv-model", { timeout: 10_000 });
      await shot("review-provider-open.png");
      await page.click('.pv-sheet .pv-row[data-id="openrouter"]');
    }

    // 3. 新增自訂供應商 (an ACP agent), filled in
    await page.evaluate(`[...document.querySelectorAll('.pv-add button')][0].click()`);
    await page.waitForSelector(".pv-form", { timeout: 5_000 });
    await page.fill('.pv-form input[aria-label="名稱"]', "我的研究代理");
    await page.fill('.pv-form input[aria-label="指令"]', "research-agent --acp --profile work");
    await page.fill('.pv-form input[aria-label="金鑰"]', "example-key");
    await page.fill('.pv-form input[aria-label="金鑰的環境變數"]', "RESEARCH_AGENT_API_KEY");
    await page.fill('.pv-form textarea[aria-label="模型清單"]', "research-large, research-fast");
    await page.evaluate(`document.activeElement?.blur()`);
    await shot("desktop-custom-provider-dark.png");
    await page.evaluate(`document.querySelector('.pv-overlay')?.remove()`);

    // 2. the bot editor: 選供應商 → 選模型
    await page.click("#team-toggle");
    await page.waitForSelector(".tm-card[data-bot]", { timeout: 10_000 });
    await page.evaluate(
      `[...document.querySelector('.tm-card[data-bot]').querySelectorAll('button')].find(b => b.textContent.includes('編輯'))?.click()`,
    );
    await page.waitForSelector(".tm-editor", { timeout: 10_000 });
    await page.evaluate(`document.querySelector('.be-adv').open = true`);
    await page.waitForSelector(".be-pick .pv-chosen", { timeout: 10_000 });
    await page.click(".be-pick .pv-chosen");
    await page.waitForSelector('.be-pick .pv-row[data-id="openrouter"]', { timeout: 10_000 });
    if (process.env.ALCA_SHOTS_REVIEW) await shot("review-editor-choosing.png");
    await page.click('.be-pick .pv-row[data-id="openrouter"]');
    await page.waitForSelector(".be-model .pv-model", { timeout: 10_000 });
    await page.evaluate(`(() => {
      document.querySelector('.be-model .pv-model[data-id="anthropic/claude-sonnet-5.5"]')?.click();
      document.activeElement?.blur();
      const body = document.querySelector('.tm-editor .be-body');
      const pick = document.querySelector('.be-pick');
      if (body && pick) body.scrollTop += pick.getBoundingClientRect().top - body.getBoundingClientRect().top - 44;
    })()`);
    await page.mouse.move(5, 890);
    await shot("desktop-model-picker-dark.png");
  } finally {
    await browser.close();
    await app.close();
    list.close();
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
    if (saved.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.GEMINI_API_KEY;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
  return shots;
}
