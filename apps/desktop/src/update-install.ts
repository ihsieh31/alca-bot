// Phase E updater: put a checked core tarball in place of <prefix>/app, and take it back.
//
//   stage    unpack into <prefix>/app.next (Windows: symlinks as junctions, ALCA_LINKS.json),
//            check its ALCA_VERSION is the version asked for, run its cli.ts once
//   apply    stop the background service → back up state.sqlite (Phase B's backupNow, the same
//            five as the migration and manual backups) → app → app.prev, app.next → app →
//            start the service → wait for /api/health; no answer = roll back by itself
//   rollback stop → if the new version moved the schema on, restore the pre-update backup (the
//            current file is moved aside, never deleted) → app → app.failed-<time>,
//            app.prev → app → start
//
// Only an install made by scripts/install.sh / install.ps1 is replaced here; the copy inside
// the desktop App and a git checkout are told where to get the new version instead.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "@alca/os";
import { backupNow, currentVersion, MIGRATIONS, openDatabase, restoreBackup } from "@alca/store";
import { bareVersion, compareVersions, UpdateError } from "./update-release.ts";

export type InstallKind = "installed" | "bundled" | "checkout" | "unknown";

export interface Layout {
  kind: InstallKind;
  /** The running core's tree (…/app, …/bundled/<ver>, the checkout). */
  appRoot: string;
  /** <prefix> for an installed core: app, app.prev, app.next, bin live here. */
  prefix?: string;
  version: string;
}

export const defaultAppRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function treeVersion(root: string): string | undefined {
  try {
    return bareVersion(
      (JSON.parse(readFileSync(join(root, "ALCA_VERSION"), "utf8")) as { version: string }).version,
    );
  } catch {
    try {
      return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version;
    } catch {
      return undefined;
    }
  }
}

export function detectLayout(appRoot = defaultAppRoot()): Layout {
  const version = treeVersion(appRoot) ?? "0.0.0";
  if (existsSync(join(appRoot, ".git"))) return { kind: "checkout", appRoot, version };
  if (basename(dirname(appRoot)) === "bundled") return { kind: "bundled", appRoot, version };
  const prefix = dirname(appRoot);
  if (
    basename(appRoot) === "app" &&
    (existsSync(join(prefix, "bin", "alca")) || existsSync(join(prefix, "bin", "alca.cmd")))
  )
    return { kind: "installed", appRoot, prefix, version };
  return { kind: "unknown", appRoot, version };
}

/** What `alca update install` says instead of installing, for a core it does not own. */
export function notOwnedText(kind: InstallKind, releaseUrl?: string): string {
  if (kind === "bundled")
    return `這個核心是桌面 App 內建的：請下載新版 App${releaseUrl ? `（${releaseUrl}）` : ""}，App 會帶新的核心`;
  if (kind === "checkout") return "這是原始碼資料夾：用 git pull 與 pnpm install 更新";
  return "找不到 install.sh／install.ps1 的安裝（<prefix>/app 旁邊要有 bin/alca）；請用安裝腳本重新安裝";
}

// --- Links (Windows) ----------------------------------------------------------------------

interface Link {
  path: string;
  target: string;
}

/** ALCA_LINKS.json, or (an older tarball) the workspace links derived from package.json files. */
export function linksOf(root: string): Link[] {
  const f = join(root, "ALCA_LINKS.json");
  if (existsSync(f)) return (JSON.parse(readFileSync(f, "utf8")) as { links: Link[] }).links;
  const byName = new Map<string, string>();
  const pkgs: Array<[string, { dependencies?: Record<string, string> }]> = [];
  for (const top of ["apps", "packages", "services"]) {
    const d = join(root, top);
    if (!existsSync(d)) continue;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const pj = join(d, e.name, "package.json");
      if (!e.isDirectory() || !existsSync(pj)) continue;
      const j = JSON.parse(readFileSync(pj, "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
      };
      if (j.name) byName.set(j.name, `${top}/${e.name}`);
      pkgs.push([`${top}/${e.name}`, j]);
    }
  }
  const out: Link[] = [];
  for (const [rel, j] of pkgs)
    for (const [dep, spec] of Object.entries(j.dependencies ?? {})) {
      const to = byName.get(dep);
      if (!spec.startsWith("workspace:") || !to) continue;
      const path = `${rel}/node_modules/${dep}`;
      const depth = path.split("/").length - 1;
      out.push({ path, target: `${"../".repeat(depth)}${to}` });
    }
  return out;
}

/** Junctions hold absolute paths: lay (again) every link of the tree at `root`. */
export function layJunctions(root: string, links = linksOf(root)): void {
  for (const l of links) {
    const from = join(root, l.path);
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(from);
    } catch {
      st = undefined;
    }
    if (st && !st.isSymbolicLink()) continue; // a real folder (an older tarball's unpack made one)
    if (st) {
      try {
        unlinkSync(from);
      } catch {
        rmdirSync(from); // a directory junction on Windows
      }
    }
    mkdirSync(dirname(from), { recursive: true });
    symlinkSync(resolve(dirname(from), l.target), from, "junction");
  }
}

// --- Stage ----------------------------------------------------------------------------------

export interface StageOptions {
  prefix: string;
  tarball: string;
  /** The version the release says it is; the tarball's ALCA_VERSION must match. */
  expectVersion?: string;
  node?: string;
  platform?: NodeJS.Platform;
  tar?: string;
}

export function stage(o: StageOptions): { dir: string; version: string } {
  const platform = o.platform ?? process.platform;
  const tar =
    o.tar ??
    (platform === "win32" && process.env.SystemRoot
      ? join(process.env.SystemRoot, "System32", "tar.exe")
      : "tar");
  const work = join(o.prefix, `.update-${process.pid}`);
  const next = join(o.prefix, "app.next");
  rmSync(work, { recursive: true, force: true });
  rmSync(next, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const run = (args: string[]) => spawnSync(tar, args, { encoding: "utf8" });
    if (platform === "win32") {
      // tar.exe cannot make the symlinks without Developer Mode: leave them out, lay junctions.
      const m = run(["-xzf", o.tarball, "-C", work, "alca/ALCA_LINKS.json"]);
      const listed = m.status === 0 && existsSync(join(work, "alca/ALCA_LINKS.json"));
      if (listed) {
        const ex = join(work, "exclude.txt");
        const links = (
          JSON.parse(readFileSync(join(work, "alca/ALCA_LINKS.json"), "utf8")) as { links: Link[] }
        ).links;
        writeFileSync(ex, `${links.map((l) => `alca/${l.path}`).join("\n")}\n`);
        if (run(["-xzf", o.tarball, "-C", work, "-X", ex]).status !== 0) throw new UpdateError("解壓縮失敗");
      } else run(["-xzf", o.tarball, "-C", work]); // an older tarball: the trial run decides
    } else if (run(["-xzf", o.tarball, "-C", work]).status !== 0) throw new UpdateError("解壓縮失敗");
    const tree = join(work, "alca");
    if (!existsSync(join(tree, "apps/desktop/src/cli.ts")))
      throw new UpdateError("壓縮檔內容不對（找不到 apps/desktop/src/cli.ts）");
    const version = treeVersion(tree);
    if (!version) throw new UpdateError("壓縮檔裡沒有 ALCA_VERSION");
    if (o.expectVersion && bareVersion(o.expectVersion) !== version)
      throw new UpdateError(`壓縮檔是 ${version}，不是要裝的 ${bareVersion(o.expectVersion)}；已停止`);
    renameSync(tree, next);
    if (platform === "win32") layJunctions(next);
    const trial = spawnSync(
      o.node ?? process.execPath,
      ["--disable-warning=ExperimentalWarning", join(next, "apps/desktop/src/cli.ts")],
      {
        encoding: "utf8",
      },
    );
    if (trial.status !== 0) throw new UpdateError("新版核心在這台電腦上跑不起來；沒有更動目前的安裝");
    return { dir: next, version };
  } catch (e) {
    rmSync(next, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- State (<data>/update.json) ------------------------------------------------------------

export interface UpdateState {
  lastCheck?: {
    at: string;
    current: string;
    latest?: { tag: string; version: string; url: string; publishedAt?: string };
    newer: boolean;
    error?: string;
  };
  installed?: { from: string; to: string; at: string; backup?: string; schema?: number; verified: string };
  rolledBack?: { from: string; to: string; at: string; restored?: string; auto: boolean };
}

export const statePath = (dataDir: string): string => join(dataDir, "update.json");

export function readState(dataDir: string): UpdateState {
  try {
    return JSON.parse(readFileSync(statePath(dataDir), "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

export function writeState(dataDir: string, s: UpdateState): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(statePath(dataDir), `${JSON.stringify(s, null, 2)}\n`);
}

// --- Apply and roll back ---------------------------------------------------------------------

/** The background service, as `alca service install` set it up (tests pass a fake). */
export interface ServiceControl {
  installed(): boolean;
  stop(): void;
  start(): void;
}

export interface ApplyOptions {
  layout: Layout;
  dataDir: string;
  staged: { dir: string; version: string };
  service: ServiceControl;
  /** Resolves true once the restarted core answers /api/health. */
  healthy: () => Promise<boolean>;
  /** Whether a core answers right now (one started by hand blocks the update). */
  running: () => Promise<boolean>;
  restart?: boolean;
  allowDowngrade?: boolean;
  verified: string;
  platform?: NodeJS.Platform;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ApplyResult {
  from: string;
  to: string;
  backup?: string;
  started: boolean;
  rolledBack?: RollbackResult;
}

const dbOf = (dataDir: string) => join(dataDir, "state.sqlite");

export async function applyUpdate(o: ApplyOptions): Promise<ApplyResult> {
  const { layout } = o;
  const say = o.log ?? (() => undefined);
  const now = o.now ?? (() => new Date());
  if (layout.kind !== "installed" || !layout.prefix) throw new UpdateError(notOwnedText(layout.kind));
  const prefix = layout.prefix;
  if (!o.allowDowngrade && compareVersions(o.staged.version, layout.version) <= 0)
    throw new UpdateError(
      `${o.staged.version} 沒有比目前的 ${layout.version} 新（要降級請加 --allow-downgrade）`,
    );
  const svc = o.service.installed();
  if (!svc && (await o.running()))
    throw new UpdateError(
      "有一個不是背景服務的 Alca 正在執行（例如終端機裡的 alca start）；請先結束它再更新",
    );
  if (svc) {
    say("停止背景服務…");
    o.service.stop();
  }
  // Phase B's pre-upgrade backup: the core is stopped, the file is consistent.
  let backup: string | undefined;
  let schema: number | undefined;
  const db = dbOf(o.dataDir);
  if (existsSync(db)) {
    const h = openDatabase({ path: db });
    try {
      schema = currentVersion(h);
      backup = backupNow(h, db, now());
    } finally {
      h.close();
    }
    say(`升級前備份：${backup}`);
  }
  const app = join(prefix, "app");
  const prev = join(prefix, "app.prev");
  rmSync(prev, { recursive: true, force: true });
  renameSync(app, prev);
  try {
    renameSync(o.staged.dir, app);
    if ((o.platform ?? process.platform) === "win32") layJunctions(app);
  } catch (e) {
    rmSync(app, { recursive: true, force: true });
    renameSync(prev, app);
    if (svc) o.service.start();
    throw new UpdateError(`放不進 ${app}（${e instanceof Error ? e.message : String(e)}）；已還原`);
  }
  const state = readState(o.dataDir);
  writeState(o.dataDir, {
    ...state,
    installed: {
      from: layout.version,
      to: o.staged.version,
      at: now().toISOString(),
      ...(backup ? { backup } : {}),
      ...(schema !== undefined ? { schema } : {}),
      verified: o.verified,
    },
  });
  say(`已換成 ${o.staged.version}（舊版留在 ${prev}）`);
  if (!svc || o.restart === false)
    return { from: layout.version, to: o.staged.version, ...(backup ? { backup } : {}), started: false };
  say("啟動背景服務…");
  o.service.start();
  if (await o.healthy())
    return { from: layout.version, to: o.staged.version, ...(backup ? { backup } : {}), started: true };
  say("新版沒有在時間內回應，自動回滾…");
  const rolledBack = await rollback({ ...o, auto: true });
  return {
    from: layout.version,
    to: o.staged.version,
    ...(backup ? { backup } : {}),
    started: false,
    rolledBack,
  };
}

export interface RollbackOptions {
  layout: Layout;
  dataDir: string;
  service: ServiceControl;
  healthy: () => Promise<boolean>;
  restart?: boolean;
  auto?: boolean;
  platform?: NodeJS.Platform;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RollbackResult {
  to: string;
  restored?: { backup: string; movedAside?: string };
  started: boolean;
}

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export async function rollback(o: RollbackOptions): Promise<RollbackResult> {
  const say = o.log ?? (() => undefined);
  const now = o.now ?? (() => new Date());
  if (!o.layout.prefix) throw new UpdateError(notOwnedText(o.layout.kind));
  const prefix = o.layout.prefix;
  const app = join(prefix, "app");
  const prev = join(prefix, "app.prev");
  const state = readState(o.dataDir);
  if (!existsSync(prev) || !state.installed)
    throw new UpdateError("沒有可以回滾的上一版（app.prev 不在，或上一次不是 alca update 裝的）");
  const svc = o.service.installed();
  if (svc) o.service.stop();
  // The new version may have migrated the database: the old one cannot open a newer schema.
  let restored: RollbackResult["restored"];
  const db = dbOf(o.dataDir);
  if (existsSync(db) && state.installed.schema !== undefined) {
    const h = openDatabase({ path: db, readOnly: true });
    let v: number;
    try {
      v = currentVersion(h);
    } finally {
      h.close();
    }
    if (v > state.installed.schema) {
      const b = state.installed.backup;
      if (!b || !existsSync(b))
        throw new UpdateError(
          `資料庫已升到第 ${v} 版，但找不到升級前備份，無法回滾；請不要刪除任何檔案，先回報`,
        );
      const r = restoreBackup(db, b, MIGRATIONS, now());
      restored = { backup: b, ...(r.movedAside ? { movedAside: r.movedAside } : {}) };
      say(`資料庫還原到升級前備份（更新後寫入的資料留在 ${r.movedAside ?? "原處"}）`);
    }
  }
  for (const n of readdirSync(prefix))
    if (n.startsWith("app.failed-")) rmSync(join(prefix, n), { recursive: true, force: true });
  const failed = join(prefix, `app.failed-${stamp(now())}`);
  renameSync(app, failed);
  renameSync(prev, app);
  if ((o.platform ?? process.platform) === "win32") layJunctions(app);
  const to = state.installed.from;
  writeState(o.dataDir, {
    ...(state.lastCheck ? { lastCheck: state.lastCheck } : {}),
    rolledBack: {
      from: state.installed.to,
      to,
      at: now().toISOString(),
      ...(restored ? { restored: restored.backup } : {}),
      auto: !!o.auto,
    },
  });
  say(`已回到 ${to}（換下來的版本留在 ${failed}）`);
  let started = false;
  if (svc && o.restart !== false) {
    o.service.start();
    started = await o.healthy();
  }
  return { to, ...(restored ? { restored } : {}), started };
}
