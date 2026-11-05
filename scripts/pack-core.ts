// Pack the core (desktop core + CLI, hands, rendezvous, packages) and the built
// phone PWA into a self-contained tree that runs with a plain `node` ≥ 22.18:
// no pnpm, no network, no dev dependencies.
//
//   node --disable-warning=ExperimentalWarning scripts/pack-core.ts --dir <out-dir>
//   node --disable-warning=ExperimentalWarning scripts/pack-core.ts --tar <out.tar.gz>
//
// What goes in: the files git tracks (minus the Tauri shell, CI and docs
// screenshots), `apps/phone-pwa/dist`, and a node_modules made by hand:
// a relative symlink per `workspace:*` dependency (as pnpm lays them out) and
// each external runtime dependency (regular and installed optional ones, such
// as werift for WebRTC) with all of its own dependencies, taken from this
// checkout's installed tree (scripts/pack-deps.ts: hoisted, nested only on a
// version clash).
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DepPacker } from "./pack-deps.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Phase E: the packed tree's symlinks (path and relative target, `/`-separated), see packCore. */
export const LINKS_FILE = "ALCA_LINKS.json";
const LEAVE_OUT = [/^apps\/desktop-shell\//, /^\.github\//, /^docs\/screenshots\//, /^\.gitignore$/];

type Pkg = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
const readPkg = (p: string): Pkg => JSON.parse(readFileSync(p, "utf8")) as Pkg;

/** Workspace package directories (relative), from pnpm-workspace.yaml's `dir/*` globs. */
function workspaceDirs(root: string): string[] {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s*-\s*"?([\w.-]+)\/\*"?\s*$/gm)].map((m) => m[1] as string);
  const tracked = trackedFiles(root);
  return tracked
    .filter((f) => /^[^/]+\/[^/]+\/package\.json$/.test(f) && globs.includes(f.split("/")[0] as string))
    .map((f) => dirname(f))
    .filter((d) => !LEAVE_OUT.some((re) => re.test(`${d}/`)));
}

function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0")
    .filter(Boolean);
}

export interface PackResult {
  dir: string;
  version: string;
  /** External dependencies the workspace packages declare. */
  external: string[];
  /** Every packed external package, transitive ones included, as name@version. */
  packages: string[];
}

export async function packCore(
  outDir: string,
  root = ROOT,
  env: Record<string, string | undefined> = process.env,
): Promise<PackResult> {
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const f of trackedFiles(root)) {
    if (LEAVE_OUT.some((re) => re.test(f)) || !existsSync(join(root, f))) continue;
    mkdirSync(dirname(join(out, f)), { recursive: true });
    cpSync(join(root, f), join(out, f));
  }

  const dirs = workspaceDirs(root);
  const byName = new Map<string, string>();
  for (const d of dirs) {
    const name = readPkg(join(root, d, "package.json")).name;
    if (name) byName.set(name, d);
  }

  const external = new Set<string>();
  const deps = new DepPacker(out);
  // Phase E: every symlink, for the Windows installers (tar.exe cannot make one without
  // Developer Mode; scripts/install.ps1 and `alca update` skip them and lay junctions instead).
  const links: Array<{ path: string; target: string }> = [];
  const link = (from: string, to: string) => {
    mkdirSync(dirname(from), { recursive: true });
    const target = relative(dirname(from), to);
    symlinkSync(target, from, "dir");
    links.push({ path: relative(out, from).split(sep).join("/"), target: target.split(sep).join("/") });
  };
  for (const d of dirs) {
    const pkg = readPkg(join(root, d, "package.json"));
    const wanted: Array<[string, string, boolean]> = [
      ...Object.entries(pkg.dependencies ?? {}).map(([n, v]): [string, string, boolean] => [n, v, false]),
      ...Object.entries(pkg.optionalDependencies ?? {}).map(([n, v]): [string, string, boolean] => [
        n,
        v,
        true,
      ]),
    ];
    for (const [dep, spec, optional] of wanted) {
      const linkPath = join(out, d, "node_modules", dep);
      if (spec.startsWith("workspace:")) {
        const target = byName.get(dep);
        if (!target) throw new Error(`${d}: ${dep} is not a workspace package`);
        link(linkPath, join(out, target));
        continue;
      }
      // Resolved from the package that declares it, as Node would, with everything it needs.
      const placed = deps.place(dep, join(root, d), join(out, d), optional);
      if (!placed) continue; // an optional dependency that is not installed here
      external.add(dep);
      if (placed === linkPath) continue; // nested right there (another version holds the hoisted slot)
      link(linkPath, placed);
    }
  }

  // P12: the official service's public endpoints from the build variables (ALCA_OFFICIAL_*), so an
  // installed Alca needs no settings; else a generated file in this checkout; else none (empty defaults).
  const official = join(out, "apps/desktop/official-config.json");
  const { writeOfficialConfig } = await import("./gen-official-config.ts");
  if (!writeOfficialConfig(official, env) && existsSync(join(root, "apps/desktop/official-config.json")))
    cpSync(join(root, "apps/desktop/official-config.json"), official);

  // Phase E: the release signing public key (repository variable ALCA_RELEASE_PUBLIC_KEY); a core
  // that carries one installs only updates whose SHA256SUMS it verifies (update-verify.ts).
  const { writeReleaseKeys } = await import("../apps/desktop/src/update-verify.ts");
  writeReleaseKeys(out, env);

  // The phone PWA, built (the relay serves it with --pwa apps/phone-pwa/dist).
  const { buildPwa } = await import("../apps/phone-pwa/scripts/build.ts");
  buildPwa(join(out, "apps/phone-pwa/dist"), env);

  writeFileSync(join(out, LINKS_FILE), `${JSON.stringify({ links }, null, 1)}\n`);

  const version = (process.env.ALCA_VERSION ?? gitDescribe(root)).replace(/^v/, "");
  writeFileSync(
    join(out, "ALCA_VERSION"),
    `${JSON.stringify({ version, node: ">=22.18", built: new Date().toISOString() })}\n`,
  );
  return { dir: out, version, external: [...external].sort(), packages: deps.list() };
}

function gitDescribe(root: string): string {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], { cwd: root, encoding: "utf8" })
      .trim()
      .replace(/^v/, "");
  } catch {
    return "0.0.0-dev";
  }
}

/**
 * Run as a script (not imported)? Compares real paths, so a checkout whose path
 * has spaces (`import.meta.url` encodes them as %20) or symlinks still runs.
 */
function isMain(url: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { dir: { type: "string" }, tar: { type: "string" } } });
  if (!values.dir && !values.tar) {
    console.error("usage: pack-core.ts --dir <out-dir> | --tar <out.tar.gz>");
    process.exit(2);
  }
  const staging = values.dir ?? join(mkdtempSync(join(tmpdir(), "alca-pack-")), "alca");
  const r = await packCore(staging);
  if (values.tar) {
    const tar = resolve(values.tar);
    mkdirSync(dirname(tar), { recursive: true });
    // One top-level folder, `alca/`, so the archive never spills into the current directory.
    execFileSync("tar", ["-czf", tar, "-C", dirname(r.dir), relative(dirname(r.dir), r.dir)]);
    console.log(`packed ${r.version} → ${tar} (external: ${r.external.join(", ") || "none"})`);
    if (!values.dir) rmSync(dirname(staging), { recursive: true, force: true });
  } else {
    console.log(`packed ${r.version} → ${r.dir} (external: ${r.external.join(", ") || "none"})`);
  }
}
