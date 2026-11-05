import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DownloadError, downloadFile } from "./download.ts";
import { extractZip } from "./unzip.ts";

/**
 * First-run Chromium: when no Chrome for Testing / Chromium is on the machine,
 * fetch Chrome for Testing for this OS and CPU from Google's public JSON
 * endpoint, download it (resumable, retried, checked against the server's
 * MD5/CRC32C), unpack it under the Alca data dir and remember the version.
 * Nothing is installed system-wide and nothing outside `dir` is touched.
 */

/** Google's public Chrome for Testing index (versions + per-platform download URLs). */
export const CFT_INDEX_URL =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

export type CftPlatform = "linux64" | "linux-arm64" | "mac-arm64" | "mac-x64" | "win32" | "win64";

/** This machine's Chrome for Testing platform, or undefined when there is no build for it. */
export function cftPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): CftPlatform | undefined {
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : undefined;
  if (platform === "linux") return arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : undefined;
  if (platform === "win32")
    return arch === "x64" || arch === "arm64" ? "win64" : arch === "ia32" ? "win32" : undefined;
  return undefined;
}

/** Path of the browser binary inside an unpacked archive. */
export function cftExecutable(binDir: string, p: CftPlatform): string {
  const top = join(binDir, `chrome-${p}`);
  if (p === "mac-arm64" || p === "mac-x64")
    return join(top, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  if (p === "win32" || p === "win64") return join(top, "chrome.exe");
  return join(top, "chrome");
}

export interface CftDownload {
  version: string;
  platform: CftPlatform;
  url: string;
}

/** Pick this platform's chrome zip from the index JSON (validated, https only unless loopback). */
export function pickDownload(index: unknown, p: CftPlatform, channel = "Stable"): CftDownload {
  const ch = (index as { channels?: Record<string, unknown> })?.channels?.[channel] as
    | { version?: unknown; downloads?: { chrome?: unknown } }
    | undefined;
  const version = typeof ch?.version === "string" ? ch.version : "";
  if (!/^\d+(\.\d+){1,3}$/.test(version))
    throw new InstallError("Chrome for Testing 清單格式不對（沒有版本）");
  const list = Array.isArray(ch?.downloads?.chrome) ? (ch.downloads.chrome as unknown[]) : [];
  const hit = list.find((d) => (d as { platform?: unknown })?.platform === p) as
    | { url?: unknown }
    | undefined;
  const url = typeof hit?.url === "string" ? hit.url : "";
  if (!url) throw new InstallError(`Chrome for Testing 沒有 ${p} 的版本`);
  checkUrl(url);
  return { version, platform: p, url };
}

function checkUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InstallError(`下載網址不正確：${url}`);
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
    throw new InstallError(`只接受 https 下載網址：${url}`);
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

export type InstallPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "extracting"
  | "ready"
  | "failed";

export interface InstallState {
  phase: InstallPhase;
  version?: string;
  platform?: string;
  /** Bytes so far / total (downloading). */
  received?: number;
  total?: number;
  /** Entries unpacked / total (extracting). */
  entries?: number;
  entriesTotal?: number;
  executable?: string;
  error?: string;
}

export interface InstalledChromium {
  version: string;
  platform: CftPlatform;
  executable: string;
  installedAt: string;
}

export interface InstallerOptions {
  /** Where browsers go (`<data-dir>/browser/bin`); `findChromium({ bundledDir })` looks here. */
  dir: string;
  fetch?: typeof fetch;
  indexUrl?: string;
  channel?: string;
  platform?: string;
  arch?: string;
  retries?: number;
  backoffMs?: number;
  now?: () => Date;
}

/** Downloads and keeps one Chrome for Testing under `dir`. One install at a time. */
export class ChromiumInstaller {
  private readonly o: InstallerOptions;
  private current: InstallState = { phase: "idle" };
  private running: Promise<string> | undefined;
  private readonly listeners = new Set<(s: InstallState) => void>();

  constructor(o: InstallerOptions) {
    this.o = o;
    const have = this.installed();
    if (have)
      this.current = {
        phase: "ready",
        version: have.version,
        platform: have.platform,
        executable: have.executable,
      };
  }

  state(): InstallState {
    return { ...this.current };
  }

  subscribe(fn: (s: InstallState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: InstallState): void {
    this.current = s;
    for (const l of [...this.listeners]) {
      try {
        l({ ...s });
      } catch {
        // a surface bug must not break the install
      }
    }
  }

  private get manifest(): string {
    return join(this.o.dir, "installed.json");
  }

  /** The browser this installer put down earlier, if it is still there. */
  installed(): InstalledChromium | undefined {
    try {
      const m = JSON.parse(readFileSync(this.manifest, "utf8")) as InstalledChromium;
      return typeof m.executable === "string" && existsSync(m.executable) ? m : undefined;
    } catch {
      return undefined;
    }
  }

  /** The installed executable, downloading it first if needed. Concurrent callers share one run. */
  ensure(signal?: AbortSignal): Promise<string> {
    const have = this.installed();
    if (have) return Promise.resolve(have.executable);
    this.running ??= this.install(signal).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async install(signal?: AbortSignal): Promise<string> {
    const p = cftPlatform(this.o.platform, this.o.arch);
    try {
      if (!p)
        throw new InstallError(
          `Chrome for Testing 沒有這台電腦（${this.o.platform ?? process.platform}/${this.o.arch ?? process.arch}）的版本；請安裝 Chromium，或用 ALCA_CHROMIUM 指定執行檔。`,
        );
      this.set({ phase: "checking", platform: p });
      const index = await this.fetchIndex(signal);
      const d = pickDownload(index, p, this.o.channel);
      mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      const dl = join(this.o.dir, ".download");
      mkdirSync(dl, { recursive: true });
      const zip = join(dl, `chrome-${p}-${d.version}.zip`);
      const base = { version: d.version, platform: p };
      this.set({ phase: "downloading", ...base, received: 0 });
      await downloadFile({
        url: d.url,
        dest: zip,
        ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
        ...(signal ? { signal } : {}),
        retries: this.o.retries ?? 3,
        ...(this.o.backoffMs !== undefined ? { backoffMs: this.o.backoffMs } : {}),
        onProgress: (pr) =>
          this.set({
            phase: "downloading",
            ...base,
            received: pr.received,
            ...(pr.total !== undefined ? { total: pr.total } : {}),
          }),
      });
      this.set({ phase: "verifying", ...base });
      const staging = join(this.o.dir, `.staging-${d.version}`);
      rmSync(staging, { recursive: true, force: true });
      try {
        await extractZip(zip, staging, {
          ...(signal ? { signal } : {}),
          onEntry: (n, total) => {
            if (n === 1 || n === total || n % 200 === 0)
              this.set({ phase: "extracting", ...base, entries: n, entriesTotal: total });
          },
        });
      } catch (err) {
        // A bad archive is not worth resuming: drop it so the next try downloads afresh.
        rmSync(zip, { force: true });
        throw err;
      }
      const exeInStaging = cftExecutable(staging, p);
      if (!existsSync(exeInStaging)) throw new InstallError("下載的壓縮檔裡沒有瀏覽器執行檔");
      if (!p.startsWith("win")) chmodSync(exeInStaging, 0o755);
      const finalTop = join(this.o.dir, `chrome-${p}`);
      const old = `${finalTop}.old`;
      rmSync(old, { recursive: true, force: true });
      if (existsSync(finalTop)) renameSync(finalTop, old);
      renameSync(join(staging, `chrome-${p}`), finalTop);
      rmSync(old, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
      rmSync(zip, { force: true });
      const executable = cftExecutable(this.o.dir, p);
      const rec: InstalledChromium = {
        ...base,
        executable,
        installedAt: (this.o.now?.() ?? new Date()).toISOString(),
      };
      writeFileSync(this.manifest, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
      this.set({ phase: "ready", ...base, executable });
      return executable;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      this.set({ phase: "failed", ...(p ? { platform: p } : {}), error: msg.slice(0, 500) });
      throw err;
    }
  }

  private async fetchIndex(signal?: AbortSignal): Promise<unknown> {
    const url = this.o.indexUrl ?? CFT_INDEX_URL;
    checkUrl(url);
    const doFetch = this.o.fetch ?? fetch;
    const tries = (this.o.retries ?? 3) + 1;
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, (this.o.backoffMs ?? 1000) * 2 ** (i - 1)));
      try {
        const res = await doFetch(url, { ...(signal ? { signal } : {}) });
        if (!res.ok)
          throw new DownloadError(`讀取 Chrome for Testing 清單失敗：HTTP ${res.status}`, {
            status: res.status,
            retryable: res.status >= 500 || res.status === 429,
          });
        return await res.json();
      } catch (err) {
        last = err;
        if (signal?.aborted) throw err;
        if (err instanceof DownloadError && !err.retryable) throw err;
      }
    }
    throw last instanceof Error ? last : new InstallError(String(last));
  }
}
