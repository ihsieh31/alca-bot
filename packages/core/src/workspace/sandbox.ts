import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PermissionLevelT } from "@alca/config";
import {
  type ConfineProbe,
  type ConfineSpec,
  configDenyWrite,
  dataDenyRead,
  defaultWritableCaches,
  homeDenyRead,
  realOrResolved,
  within,
} from "@alca/os";

/**
 * Next-round §5.4: a bot's OS sandbox setting and what it means at a level.
 *
 * - `mode`: `auto` (on at 自主 and 完全授權, the person's decision
 *   2026-11-05), `on` (every level; fails closed when no sandbox is usable),
 *   `off`.
 * - `network`: `open` by default (decided 2026-11-05): network actions are
 *   still classified and carded by the gate; `none` cuts the command off the
 *   network (Linux: no network namespace at all; macOS: IP denied).
 * - `extraWritable`: absolute folders the bot may also write (beside the
 *   built-in package caches).
 *
 * When no sandbox is usable and the mode is `auto`, work runs as before —
 * 完全授權 included — and the panel shows a warning (the person's decision
 * 2026-11-05; the design's "fall back to 自主's cards" was not taken).
 */

export type SandboxMode = "auto" | "on" | "off";
export type SandboxNetwork = "open" | "none";

export interface BotSandbox {
  mode: SandboxMode;
  network: SandboxNetwork;
  extraWritable?: string[];
}

export const DEFAULT_SANDBOX: BotSandbox = Object.freeze({ mode: "auto", network: "open" }) as BotSandbox;
export const MAX_EXTRA_WRITABLE = 8;

/** What the panel and the audit show for a bot's commands. */
export type SandboxState = "seatbelt" | "bwrap" | "off" | "unavailable";

/** What `BashSessions` is given for a call: a spec to run in, nothing, or a refusal. */
export interface ConfinePlan {
  state: SandboxState;
  spec?: ConfineSpec;
  /** Why no sandbox is usable (state `unavailable`). */
  reason?: string;
  /** The bot asked for the sandbox at every level (`mode: on`): without one, shell tools refuse. */
  required?: boolean;
}

const isMode = (v: unknown): v is SandboxMode => v === "auto" || v === "on" || v === "off";

/** Parse a stored / submitted sandbox setting; anything unreadable falls back to the default, never guessed wider. */
export function parseBotSandbox(raw: unknown): BotSandbox {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { ...DEFAULT_SANDBOX };
    }
  }
  if (!v || typeof v !== "object") return { ...DEFAULT_SANDBOX };
  const r = v as Record<string, unknown>;
  const out: BotSandbox = {
    mode: isMode(r.mode) ? r.mode : "auto",
    network: r.network === "none" ? "none" : "open",
  };
  if (Array.isArray(r.extraWritable)) {
    const dirs = r.extraWritable
      .filter(
        (p): p is string => typeof p === "string" && isAbsolute(p) && !p.includes("\0") && p.length <= 1000,
      )
      .slice(0, MAX_EXTRA_WRITABLE);
    if (dirs.length) out.extraWritable = [...new Set(dirs)];
  }
  return out;
}

/** Does the sandbox apply at this level? */
export function sandboxOn(s: BotSandbox, level: PermissionLevelT): boolean {
  return s.mode === "on" || (s.mode === "auto" && (level === "autonomous" || level === "full_access"));
}

const STRICT: Record<SandboxMode, number> = { off: 0, auto: 1, on: 2 };

/**
 * Does `next` loosen `prev`? (a weaker mode, network opened, a new writable
 * folder). Loosening needs the approve key, like turning 完全授權 on;
 * tightening needs nothing.
 */
export function loosens(prev: BotSandbox, next: BotSandbox): string | undefined {
  if (STRICT[next.mode] < STRICT[prev.mode]) return "放寬沙箱模式";
  if (prev.network === "none" && next.network === "open") return "讓沙箱可以連網";
  const had = new Set(prev.extraWritable ?? []);
  const added = (next.extraWritable ?? []).filter((p) => !had.has(p));
  if (added.length) return `新增沙箱可寫的資料夾（${added[0]}）`;
  return undefined;
}

/** Merge a submitted change onto the stored setting; the stored JSON text (null when it equals the default). */
export function mergeBotSandbox(stored: string | null | undefined, patch: unknown): string | null {
  if (patch === null) return null;
  if (!patch || typeof patch !== "object") throw new Error("沙箱設定要是物件");
  const p = patch as Record<string, unknown>;
  if (p.mode !== undefined && !isMode(p.mode)) throw new Error("沙箱模式要是 auto、on 或 off");
  if (p.network !== undefined && p.network !== "open" && p.network !== "none")
    throw new Error("沙箱網路要是 open 或 none");
  if (p.extraWritable !== undefined) {
    if (!Array.isArray(p.extraWritable)) throw new Error("額外可寫路徑要是清單");
    if (p.extraWritable.length > MAX_EXTRA_WRITABLE)
      throw new Error(`額外可寫路徑最多 ${MAX_EXTRA_WRITABLE} 個`);
    for (const d of p.extraWritable) {
      if (typeof d !== "string" || !isAbsolute(d) || d.includes("\0"))
        throw new Error("額外可寫路徑要是絕對路徑");
      // The whole disk or the whole home folder would undo the sandbox.
      if (resolve(d) === resolve("/") || resolve(d) === resolve(homedir()))
        throw new Error("額外可寫路徑不能是根目錄或整個家目錄");
    }
  }
  const next = parseBotSandbox({ ...parseBotSandbox(stored), ...p });
  const isDefault = next.mode === "auto" && next.network === "open" && !next.extraWritable?.length;
  return isDefault ? null : JSON.stringify(next);
}

/** The words the settings page and the worker panel use for a probe. */
export function describeProbe(p: ConfineProbe | undefined): string {
  if (!p) return "沙箱：尚未偵測";
  const name =
    p.kind === "seatbelt" ? "Seatbelt（sandbox-exec）" : p.kind === "bwrap" ? "bubblewrap" : "沙箱";
  return p.ok
    ? `${name} 可用${p.version ? `（${p.version}）` : ""}`
    : `${name} 不可用：${p.reason ?? "原因不明"}`;
}

export interface SpecInput {
  kind: "seatbelt" | "bwrap";
  dataDir: string;
  botId: string;
  /** The folder the command runs in (the bot's, or a worker's sub-folder of it). */
  workDir: string;
  /** Every other bot's folder (they are denied when outside the data folder too). */
  otherDirs: readonly string[];
  sandbox: BotSandbox;
  corePort?: number | undefined;
  home?: string;
}

const safeSeg = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "bot";

/** The spec for one bot's commands (real paths throughout; the temp base is made 0700). */
export function buildConfineSpec(i: SpecInput): ConfineSpec {
  const work = realOrResolved(i.workDir);
  const tmpBase = join(realOrResolved(i.dataDir), "tmp", safeSeg(i.botId));
  mkdirSync(tmpBase, { recursive: true, mode: 0o700 });
  const tmp = realOrResolved(tmpBase);
  const others = i.otherDirs.map(realOrResolved).filter((d) => !within(d, work) && !within(work, d));
  const homeSecrets = homeDenyRead(i.home).filter((p) => !within(p, work));
  const extra = [
    ...defaultWritableCaches(i.home),
    ...(i.sandbox.extraWritable ?? []).map(realOrResolved),
  ].filter((p) => !within(realOrResolved(i.dataDir), p));
  return {
    kind: i.kind,
    workDir: work,
    tmpDir: tmp,
    extraWritable: [...new Set(extra)],
    denyRead: [...new Set([...dataDenyRead(i.dataDir, [work, tmp]), ...others, ...homeSecrets])],
    denyWriteInside: configDenyWrite(work),
    network: i.sandbox.network,
    ...(i.corePort ? { corePort: i.corePort } : {}),
  };
}

/** What a command runner is given: a spec to run in, or a refusal (§5.7: `mode: on` without a sandbox). */
export interface ConfineBox {
  spec?: ConfineSpec;
  refuse?: string;
}

export const sandboxRequiredReason = (reason: string | undefined) =>
  `這個 bot 要求沙箱，但這台電腦沒有可用的沙箱（${reason ?? "原因不明"}），所以不執行`;

export function confineBox(p: ConfinePlan | undefined): ConfineBox {
  if (!p) return {};
  if (p.state === "unavailable" && p.required) return { refuse: sandboxRequiredReason(p.reason) };
  return p.spec ? { spec: p.spec } : {};
}
