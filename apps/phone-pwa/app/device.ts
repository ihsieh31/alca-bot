// Real-device behaviour (P8): what a phone browser needs beyond the layout.
//
// - Storage: ask the browser to keep IndexedDB (the phone's identity key and
//   pairing live there) instead of evicting it under storage pressure.
// - Viewport: see viewport.ts (keyboard and rotation).
// - Install: Android Chrome's `beforeinstallprompt` is kept for an install
//   button; iOS has none (Share → 加入主畫面, see push.ts).
import { kv } from "./keystore.ts";

export interface StorageInfo {
  supported: boolean;
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
}

export async function storageInfo(): Promise<StorageInfo> {
  const st = navigator.storage;
  if (!st) return { supported: false, persisted: null, usage: null, quota: null };
  const [persisted, est] = await Promise.all([
    st.persisted ? st.persisted().catch(() => null) : Promise.resolve(null),
    st.estimate ? st.estimate().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return { supported: true, persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
}

/** Ask once per install to keep our storage (granted silently for installed apps on most browsers). */
export async function requestPersist(force = false): Promise<boolean | null> {
  const st = navigator.storage;
  if (!st?.persist) return null;
  if (!force && (await st.persisted?.().catch(() => false))) return true;
  if (!force && (await kv.get<boolean>("persistAsked").catch(() => false))) return st.persisted?.() ?? null;
  const ok = await st.persist().catch(() => false);
  await kv.set("persistAsked", true).catch(() => undefined);
  return ok;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | undefined;
const installListeners = new Set<() => void>();

/** Capture Chrome's install prompt so a button can show it later. */
export function captureInstallPrompt(): void {
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    for (const l of installListeners) l();
  });
  addEventListener("appinstalled", () => {
    deferred = undefined;
    for (const l of installListeners) l();
  });
}

export const canInstall = (): boolean => !!deferred;

export function onInstallChange(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const e = deferred;
  if (!e) return "unavailable";
  deferred = undefined;
  await e.prompt();
  const { outcome } = await e.userChoice;
  for (const l of installListeners) l();
  return outcome;
}

/** The service worker's build version (it answers on a MessageChannel). */
export async function swVersion(timeoutMs = 1500): Promise<string | null> {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), timeoutMs);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(typeof e.data?.version === "string" ? e.data.version : null);
    };
    ctl.postMessage({ type: "alca-version" }, [ch.port2]);
  });
}

/** Short, human browser label ("iOS 18.1 · Safari", "Android 15 · Chrome 141"). */
export function browserLabel(ua = navigator.userAgent): string {
  const ios = /OS (\d+)[_.](\d+)/.exec(ua);
  if (/iPhone|iPad|iPod/.test(ua) && ios)
    return `iOS ${ios[1]}.${ios[2]} · ${/CriOS/.test(ua) ? "Chrome" : "Safari"}`;
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  const chrome = /Chrome\/(\d+)/.exec(ua);
  if (android) return `Android ${android[1]}${chrome ? ` · Chrome ${chrome[1]}` : ""}`;
  if (/Macintosh/.test(ua)) return `macOS${chrome ? ` · Chrome ${chrome[1]}` : " · Safari"}`;
  return chrome ? `Chrome ${chrome[1]}` : ua.slice(0, 40);
}
