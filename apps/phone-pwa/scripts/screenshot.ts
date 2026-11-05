// The phone's screenshots for docs/screenshots (phone-*.png), from the 素 Plain
// shot scripts: shots-plain.ts (the app, against the real stack: rendezvous +
// desktop core with the demo engines and a headless Alca Browser, paired over
// Alca Link) and shots-account.ts (the Google first-run screens). Both run into
// a scratch folder; the frames the docs use are copied under their doc names.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright ALCA_CHROMIUM=/usr/bin/chromium \
//   node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/screenshot.ts [outDir]
//
// The desktop's `pnpm screenshots` calls capturePhone() after its own shots.
// For every frame (both orientations, light and dark) run shots-plain.ts itself.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findChromium } from "@alca/browser";

/** The part of Playwright the desktop script hands over (the child scripts load their own). */
export interface Playwright {
  chromium: { launch(opts?: Record<string, unknown>): Promise<unknown> };
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../../..");

/** Doc name ← shot-script frame (portrait unless it says landscape). */
const DOC_NAMES: Record<string, string> = {
  "phone-threads-dark": "plain-chats-portrait-dark",
  "phone-chat-dark": "plain-chat-portrait-dark",
  "phone-chat-light": "plain-chat-portrait-light",
  "phone-chat-empty-dark": "plain-chat-empty-portrait-dark",
  "phone-chat-approval-dark": "plain-approval-pay-portrait-dark",
  "phone-chat-approval-light": "plain-approval-pay-portrait-light",
  "phone-send-approval-dark": "plain-approval-network-portrait-dark",
  "phone-workers-dark": "plain-task-asking-portrait-dark",
  "phone-memory-dark": "plain-memory-portrait-dark",
  "phone-skills-dark": "plain-skills-portrait-dark",
  "phone-team-dark": "plain-team-portrait-dark",
  "phone-connectors-dark": "plain-connect-portrait-dark",
  "phone-devices-dark": "plain-devices-portrait-dark",
  "phone-diag-dark": "plain-diag-portrait-dark",
  "phone-routines-dark": "plain-routines-portrait-dark",
  "phone-browser-dark": "plain-browser-portrait-dark",
  "phone-pairing-dark": "plain-pairing-portrait-dark",
  "phone-paired-dark": "plain-paired-portrait-dark",
  "phone-google-signin-dark": "plain-google-signin-portrait-dark",
  "phone-pick-computer-dark": "plain-pick-computer-portrait-dark",
  "phone-enroll-code-dark": "plain-enroll-code-portrait-dark",
  "phone-enroll-wrong-dark": "plain-enroll-wrong-portrait-dark",
};

function run(script: string, outDir: string, env: Record<string, string>): Promise<void> {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(HERE, script), outDir], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "inherit"],
    });
    p.on("error", fail);
    p.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${script} exited ${code}`))));
  });
}

export async function capturePhone(o: {
  outDir: string;
  /** Unused: the shot scripts load Playwright from PLAYWRIGHT_MODULE themselves. */
  playwright?: Playwright;
  chromium: string;
  /** Kept for the desktop script's subsets; the plain set is small enough to always shoot whole. */
  only?: string;
}): Promise<string[]> {
  const tmp = mkdtempSync(join(tmpdir(), "alca-phone-docs-"));
  const env = { ALCA_CHROMIUM: o.chromium, ALCA_THEMES: "dark,light" };
  try {
    await run("shots-plain.ts", tmp, env);
    await run("shots-account.ts", tmp, { ...env, ALCA_THEMES: "dark" });
    mkdirSync(o.outDir, { recursive: true });
    const out: string[] = [];
    for (const [doc, frame] of Object.entries(DOC_NAMES)) {
      const from = join(tmp, `${frame}.png`);
      if (!existsSync(from)) continue;
      const to = join(o.outDir, `${doc}.png`);
      copyFileSync(from, to);
      out.push(to);
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chromium = process.env.ALCA_CHROMIUM || findChromium();
  if (!chromium) throw new Error("no Chromium found (set ALCA_CHROMIUM)");
  const shots = await capturePhone({ outDir: resolve(process.argv[2] ?? "docs/screenshots"), chromium });
  console.log(shots.join("\n"));
}
