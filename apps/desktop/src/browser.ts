import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  BrowserHost,
  BrowserNotFoundError,
  type ChannelEvent,
  ChromiumInstaller,
  ControlError,
  findChromium,
  launchChromium,
  NavigationError,
  type NetworkConfirm,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  SpaceNotFoundError,
  type UserInput,
} from "@alca/browser";
import type { AgentSystem, AlcaCore } from "@alca/core";
import { type BrowserEvent, newId, type SpaceFrameT } from "@alca/protocol";
import type { Store } from "@alca/store";
import {
  type CookieImportSource,
  cookieImportRoute,
  cookieImportSupported,
  defaultCookieSource,
} from "./browser-cookies.ts";
import { HttpError, json, readJson } from "./http.ts";
import { sseOut } from "./sse-out.ts";

/**
 * Desktop wiring for Alca Browser: one host per app, launched lazily on the
 * first Space. Profiles live under `<data-dir>/browser/` and never in the
 * person's everyday browser profile.
 */

export type BrowserMode = "window" | "headless" | "off";

export interface BrowserSetup {
  host: BrowserHost;
  dir: string;
  /** First-run Chrome for Testing download into `<dir>/bin` (P13). */
  installer: ChromiumInstaller;
  /** Is there a browser to launch right now (found on the machine, or downloaded)? */
  available(): boolean;
  /** May the host download Chromium by itself when none is found? (read each time: 設定 can change it) */
  autoInstall(): boolean;
  /** Set once the core exists: how a paused sensitive request asks a person (network-layer gate). */
  setNetworkConfirm(fn: NetworkConfirm): void;
  /** R3: where a stopped WebSocket tab or a refused WebRTC connection is reported (card + audit). */
  setChannelNotify(fn: (e: ChannelEvent) => void): void;
  /** Opt-in Chrome cookie import (macOS): Keychain, home dir and platform. */
  cookies: CookieImportSource;
}

export function createBrowser(o: {
  dataDir: string;
  store: Store;
  mode: BrowserMode;
  executablePath?: string;
  /** Download Chrome for Testing on first run when no Chromium is found (the app sets it; tests do not). */
  autoInstall?: boolean | (() => boolean);
  /** Why autoInstall is off right now, for the error a task sees (C2); unset: no reason given. */
  autoOffReason?: () => "setting" | "flag" | undefined;
  /** Tests: a prepared installer. */
  installer?: ChromiumInstaller;
  /** Tests: a fake Keychain / Chrome home for the cookie import. */
  cookies?: CookieImportSource;
}): BrowserSetup | undefined {
  if (o.mode === "off") return undefined;
  const dir = join(o.dataDir, "browser");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const binDir = join(dir, "bin");
  const installer = o.installer ?? new ChromiumInstaller({ dir: binDir });
  const auto = o.autoInstall;
  const autoInstall = typeof auto === "function" ? auto : () => !!auto;
  const found = () => o.executablePath ?? findChromium({ bundledDir: binDir });
  const bin = async () => {
    const b = found();
    if (b) return b;
    if (autoInstall()) return await installer.ensure();
    const why = o.autoOffReason?.();
    throw new BrowserNotFoundError(why ? { autoOff: why } : {});
  };
  const headless = o.mode === "headless";
  // No window survives a restart: close any Space records left open.
  o.store.bots.closeAllSpaces();
  let confirm: NetworkConfirm | undefined;
  let notify: ((e: ChannelEvent) => void) | undefined;
  const host = new BrowserHost({
    launchShared: async () =>
      launchChromium({ executablePath: await bin(), userDataDir: join(dir, "profile"), headless }),
    launchIsolated: async (id) =>
      launchChromium({ executablePath: await bin(), userDataDir: join(dir, "spaces", id), headless }),
    records: o.store.bots,
    // Until the core is up nothing can ask a person, so a sensitive request is blocked.
    confirmNetwork: (req, signal) => (confirm ? confirm(req, signal) : Promise.resolve(false)),
    notifyChannel: (e) => notify?.(e),
  });
  installer.subscribe((st) => {
    const { executable: _path, ...data } = st;
    host.emit("browser.install", data);
  });
  // First run: start fetching right away so the browser is ready by the first task.
  if (autoInstall() && !found()) void installer.ensure().catch(() => undefined);
  return {
    host,
    dir,
    installer,
    autoInstall,
    available: () => !!found(),
    cookies: o.cookies ?? defaultCookieSource(),
    setNetworkConfirm: (fn) => {
      confirm = fn;
    },
    setChannelNotify: (fn) => {
      notify = fn;
    },
  };
}

function publicInstall(setup: BrowserSetup) {
  const { executable: _path, ...st } = setup.installer.state();
  return { ...st, auto: setup.autoInstall() };
}

/** Control changes during a run show up in that run as `handoff.requested`. */
export function bridgeHandoffs(host: BrowserHost, core: AlcaCore, agents?: AgentSystem): () => void {
  return host.onControlChange((c) => {
    if (!c.space.threadId) return;
    const data = {
      handoffId: newId("handoff"),
      to: c.controller,
      targetId: c.space.spaceId,
      surface: "browser" as const,
      reason: c.reason,
    };
    // A worker's Space hands off inside the worker's run; a thread's Space inside the thread's run.
    if (c.space.workerId && agents) agents.workers.emitToRun(c.space.workerId, "handoff.requested", data);
    else core.emitToActiveRun(c.space.threadId, "handoff.requested", data);
  });
}

export function screenshotSaver(dir: string) {
  return async (spaceId: string, frame: { data: string; mime: string }) => {
    const shots = join(dir, "shots");
    mkdirSync(shots, { recursive: true, mode: 0o700 });
    const file = join(shots, `${spaceId}-${Date.now()}.${frame.mime === "image/png" ? "png" : "jpg"}`);
    writeFileSync(file, Buffer.from(frame.data, "base64"), { mode: 0o600 });
    return file;
  };
}

export function parseInput(b: Record<string, unknown>): UserInput {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
  if (b.type === "click") return { type: "click", x: num(b.x), y: num(b.y) };
  if (b.type === "wheel")
    return { type: "wheel", x: num(b.x), y: num(b.y), dy: Math.max(-4000, Math.min(4000, num(b.dy) || 0)) };
  if (b.type === "text" && typeof b.text === "string") return { type: "text", text: b.text.slice(0, 2000) };
  if (b.type === "key" && typeof b.key === "string") return { type: "key", key: b.key };
  if (b.type === "shortcut" && (SHORTCUT_ACTIONS as readonly unknown[]).includes(b.action))
    return { type: "shortcut", action: b.action as ShortcutAction };
  throw new HttpError(400, "unknown input");
}

const DESKTOP = { kind: "user" as const, id: "desktop" };

/** `/api/browser/*` routes. Returns false when the path is not ours. */
export async function browserRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  setup: BrowserSetup | undefined,
  core: AlcaCore,
): Promise<boolean> {
  const [, area, kind, id, verb] = parts; // ["api","browser","spaces",id,verb]
  if (area !== "browser") return false;
  const method = req.method ?? "GET";
  const done = (status: number, value: unknown): true => {
    json(res, status, value);
    return true;
  };
  if (method === "GET" && kind === "status")
    return done(200, {
      enabled: !!setup,
      bots: core.store.bots.list(),
      ...(setup
        ? {
            chromium: setup.available(),
            install: publicInstall(setup),
            cookieImport: cookieImportSupported(setup.cookies),
          }
        : {}),
    });
  if (!setup) throw new HttpError(503, "瀏覽器未啟用");
  const { host } = setup;
  if (method === "POST" && kind === "install") {
    // A person pressed 「下載瀏覽器」 (or 「重試」): start (or join) the download; progress comes as browser.install events.
    if (!setup.available()) void setup.installer.ensure().catch(() => undefined);
    return done(202, publicInstall(setup));
  }
  if (method === "GET" && kind === "events") {
    browserSse(req, res, host, url.searchParams.get("watch"));
    return true;
  }
  if (await cookieImportRoute(req, res, parts, host, core.store, setup.cookies)) return true;
  if (kind !== "spaces") throw new HttpError(404, "not found");
  try {
    if (!id) {
      if (method === "GET") return done(200, host.list(url.searchParams.get("bot") ?? undefined));
      if (method === "POST") {
        const b = await readJson(req);
        const botId = typeof b.botId === "string" ? b.botId : core.defaultBotId;
        if (!core.store.bots.get(botId)) throw new HttpError(404, "沒有這個 bot");
        const st = await host.open({
          botId,
          title: typeof b.title === "string" ? b.title : "瀏覽器",
          ...(typeof b.threadId === "string" ? { threadId: b.threadId } : {}),
          ...(b.profile === "isolated"
            ? { profile: "isolated" as const, persistent: b.persistent === true }
            : {}),
          ...(typeof b.url === "string" && b.url ? { url: b.url } : {}),
        });
        return done(201, st);
      }
    } else {
      if (method === "GET" && !verb) return done(200, host.state(id));
      if (method === "DELETE" && !verb) {
        await host.close(id);
        return done(200, { closed: true });
      }
      if (method === "POST") {
        const b = await readJson(req, 16 * 1024);
        if (verb === "takeover") return done(200, host.takeOver(id, DESKTOP, "使用者接手"));
        if (verb === "handback") return done(200, host.handBack(id, DESKTOP));
        if (verb === "input") {
          await host.userInput(id, parseInput(b));
          return done(200, { ok: true });
        }
        if (verb === "navigate") {
          if (typeof b.url !== "string") throw new HttpError(400, "url is required");
          await host.userNavigate(id, b.url);
          return done(200, host.state(id));
        }
        if (verb === "tabs") {
          const s = host.get(id);
          if (s.controller !== "user") throw new ControlError("先按「接手」才能切換分頁");
          if (b.action === "switch" && typeof b.tabId === "string") await host.activate(s, b.tabId);
          else if (b.action === "new") await host.newTab(s, typeof b.url === "string" ? b.url : undefined);
          else if (b.action === "close" && typeof b.tabId === "string") await host.closeTab(s, b.tabId);
          else throw new HttpError(400, "unknown tab action");
          return done(200, host.state(id));
        }
      }
    }
  } catch (err) {
    if (err instanceof SpaceNotFoundError) throw new HttpError(404, err.message);
    if (err instanceof ControlError || err instanceof NavigationError) throw new HttpError(409, err.message);
    if (err instanceof BrowserNotFoundError) throw new HttpError(503, err.message);
    throw err;
  }
  throw new HttpError(404, "not found");
}

/** Browser channel over SSE: Space events, plus frames of the watched Space. */
function browserSse(
  req: IncomingMessage,
  res: ServerResponse,
  host: BrowserHost,
  watch: string | null,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  const out = sseOut(res); // bounded per client (PERF-2026-11)
  out.write(": alca browser channel\n\n");
  const write = (e: BrowserEvent) => out.write(`event: browser\ndata: ${JSON.stringify(e)}\n\n`);
  for (const space of host.list())
    out.write(`event: browser\ndata: ${JSON.stringify({ type: "space.snapshot", data: { space } })}\n\n`);
  const off = host.subscribe(write);
  let offFrames: (() => void) | undefined;
  let busy = false;
  if (watch) {
    try {
      offFrames = host.watch(watch, (f: SpaceFrameT) => {
        // Drop frames while the socket is still writing the previous one.
        if (busy) return;
        if (!out.write(`event: frame\ndata: ${JSON.stringify(f)}\n\n`)) return;
        busy = res.writableNeedDrain;
        if (busy) res.once("drain", () => (busy = false));
      });
    } catch {
      // unknown space: events only
    }
  }
  const ping = setInterval(() => out.write(": ping\n\n"), 15_000);
  ping.unref();
  req.on("close", () => {
    clearInterval(ping);
    off();
    offFrames?.();
  });
}
