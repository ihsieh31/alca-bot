import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpConnection } from "./cdp/connection.ts";
import { PipeTransport } from "./cdp/pipe.ts";

/**
 * Launching our own Chromium. Chrome 136+ refuses remote debugging on its
 * default data directory, and driving a person's everyday Chrome profile would
 * be wrong anyway, so Alca always runs a separate Chromium (Chrome for Testing
 * or a system Chromium) with a profile directory it owns.
 */

export class BrowserNotFoundError extends Error {
  /**
   * `autoOff` says why nothing was downloaded (mac test 2026-11-04b C2): 設定 turned the
   * download off, or this run was started with --no-browser-download.
   */
  constructor(o: { autoOff?: "setting" | "flag" } = {}) {
    super(
      o.autoOff === "setting"
        ? "沒有瀏覽器：自動下載已關閉。到 設定 → 進階 → 瀏覽器 按「下載瀏覽器」，或用 ALCA_CHROMIUM 指定執行檔路徑。"
        : o.autoOff === "flag"
          ? "沒有瀏覽器：這次啟動用了 --no-browser-download，所以沒有自動下載。到 設定 → 進階 → 瀏覽器 按「下載瀏覽器」，或用 ALCA_CHROMIUM 指定執行檔路徑。"
          : "找不到可用的 Chromium。請安裝 Chrome for Testing 或 Chromium，或用 ALCA_CHROMIUM 指定執行檔路徑。",
    );
    this.name = "BrowserNotFoundError";
  }
}

export class UnsafeProfileError extends Error {
  constructor(dir: string) {
    super(`refusing to drive a browser's default profile directory: ${dir}`);
    this.name = "UnsafeProfileError";
  }
}

/** Default data dirs of everyday browsers. Alca never launches on these. */
export function defaultBrowserProfileDirs(home = homedir(), env = process.env): string[] {
  const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    join(home, "Library", "Application Support", "Google", "Chrome"),
    join(home, "Library", "Application Support", "Chromium"),
    join(home, "Library", "Application Support", "Microsoft Edge"),
    join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    join(home, ".config", "google-chrome"),
    join(home, ".config", "chromium"),
    join(home, ".config", "microsoft-edge"),
    join(home, ".config", "BraveSoftware", "Brave-Browser"),
    join(local, "Google", "Chrome", "User Data"),
    join(local, "Chromium", "User Data"),
    join(local, "Microsoft", "Edge", "User Data"),
  ].map((p) => resolve(p));
}

export function assertOwnProfile(userDataDir: string, home = homedir(), env = process.env): void {
  const dir = resolve(userDataDir);
  for (const d of defaultBrowserProfileDirs(home, env)) {
    if (dir === d || dir.startsWith(`${d}/`) || dir.startsWith(`${d}\\`)) throw new UnsafeProfileError(dir);
  }
}

/** Find a Chromium binary: $ALCA_CHROMIUM, then a bundled copy, then common install paths. */
export function findChromium(
  opts: { env?: NodeJS.ProcessEnv; bundledDir?: string; exists?: (p: string) => boolean } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const fromEnv = env.ALCA_CHROMIUM?.trim();
  if (fromEnv) return exists(fromEnv) ? fromEnv : undefined;
  const bundled = opts.bundledDir
    ? [
        join(opts.bundledDir, "chrome-linux64", "chrome"),
        join(opts.bundledDir, "chrome-linux-arm64", "chrome"),
        join(
          opts.bundledDir,
          "chrome-mac-arm64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
        join(
          opts.bundledDir,
          "chrome-mac-x64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
        join(opts.bundledDir, "chrome-win64", "chrome.exe"),
        join(opts.bundledDir, "chrome-win32", "chrome.exe"),
      ]
    : [];
  const system = [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
  ];
  return [...bundled, ...system].find((p) => exists(p));
}

export interface LaunchOptions {
  executablePath: string;
  userDataDir: string;
  headless?: boolean;
  windowSize?: { width: number; height: number };
  /** Extra flags (tests). */
  args?: string[];
  /**
   * How long the first answer may take (default 90 s): a cold first start — a fresh profile on a
   * slow or busy machine, a first launch the OS scans — can take longer than an ordinary call.
   */
  startTimeoutMs?: number;
}

export interface ChromiumProcess {
  cdp: CdpConnection;
  userDataDir: string;
  pid: number | undefined;
  version: string;
  /** Resolves when the process has exited. */
  exited: Promise<void>;
  close(): Promise<void>;
}

export function chromiumArgs(o: LaunchOptions): string[] {
  const size = o.windowSize ?? { width: 1280, height: 800 };
  return [
    "--remote-debugging-pipe",
    `--user-data-dir=${resolve(o.userDataDir)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--window-size=${size.width},${size.height}`,
    // R3: no WebRTC over UDP without a proxy, and Alca sets none: peer-to-peer stays off in this browser.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ...(o.headless ? ["--headless=new", "--hide-scrollbars", "--mute-audio"] : []),
    ...(o.args ?? []),
    "about:blank",
  ];
}

/** Start Chromium with `--remote-debugging-pipe` (no debugging port) and connect. */
export async function launchChromium(o: LaunchOptions): Promise<ChromiumProcess> {
  assertOwnProfile(o.userDataDir);
  mkdirSync(o.userDataDir, { recursive: true });
  const child: ChildProcess = spawn(o.executablePath, chromiumArgs(o), {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < 4000) stderr += d.toString("utf8");
  });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const spawnError = new Promise<never>((_, reject) => child.once("error", reject));
  const transport = new PipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const cdp = new CdpConnection(transport);
  let version: string;
  try {
    const v = await Promise.race([
      cdp.send("Browser.getVersion", {}, undefined, { timeoutMs: o.startTimeoutMs ?? 90_000 }),
      spawnError,
      exited.then(() => {
        throw new Error(`Chromium exited during start: ${stderr.trim().slice(0, 500)}`);
      }),
    ]);
    version = String(v.product ?? "Chromium");
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  }
  return {
    cdp,
    userDataDir: o.userDataDir,
    pid: child.pid,
    version,
    exited,
    close: async () => {
      if (child.exitCode !== null) return;
      await cdp.send("Browser.close").catch(() => undefined);
      const t = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(t);
      cdp.close();
    },
  };
}
