// Build the phone PWA into static files (no bundler): strip TypeScript types
// with Node's built-in stripper, rewrite `.ts` imports to `.js`, copy the
// Link browser modules, the shared string table (R9), the shared tokens, styles, manifest and icons, and
// write a service worker that precaches exactly these files.
//
// G1: Link's PAKE uses @noble/curves (and its one dependency @noble/hashes).
// They are plain ESM, so the files reachable from what Link imports are copied
// as they are into vendor/noble/<pkg>/ (with each package's LICENSE), and
// their bare specifiers are rewritten to relative paths. The exact versions
// come from pnpm-lock.yaml; nothing is fetched at build time.
//
//   node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/build.ts [outDir]
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { I18N_DIR, TOKENS_CSS_PATH } from "@alca/design";
import { en } from "../../../packages/design/src/i18n/en.ts";
import { zhHantTW } from "../../../packages/design/src/i18n/zh-Hant-TW.ts";
import { withConnectCsp } from "./csp.ts";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const LINK = fileURLToPath(new URL("../../../packages/link/src/", import.meta.url));
const LINK_PKG = fileURLToPath(new URL("../../../packages/link/", import.meta.url));
/** Vendored packages (bare specifier prefix → directory name under vendor/noble/). */
const VENDOR = ["@noble/curves", "@noble/hashes"] as const;
/** A top-level `import … from "x"`, `import "x"` or `export … from "x"`; group 1 = the specifier. */
const STATEMENT = /^(?:(?:import|export)\b[^;'"`]*?\bfrom\s*|import\s*)["']([^"']+)["']/gm;
const BARE = /(from\s+|import\s*\(\s*|import\s+)(["'])(@noble\/(?:curves|hashes))\/([^"']+)\2/g;

/** Where Node would find `name` from `from`: its own node_modules, then each ancestor's. */
function findPackage(from: string, name: string): string {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    try {
      return realpathSync(candidate);
    } catch {
      const up = dirname(dir);
      if (up === dir) throw new Error(`${name} is not installed (pnpm install)`);
      dir = up;
    }
  }
}

/**
 * Copy the noble files reachable from `entries` (bare specifiers such as
 * `@noble/curves/nist.js`) into `<out>/vendor/noble/`, rewriting the bare
 * imports between the two packages to relative paths. Returns the files written.
 */
export function vendorNoble(out: string, entries: Iterable<string>): string[] {
  const roots = new Map<string, string>();
  roots.set("@noble/curves", findPackage(LINK_PKG, "@noble/curves"));
  roots.set("@noble/hashes", findPackage(roots.get("@noble/curves") as string, "@noble/hashes"));
  const destOf = (pkg: string, sub: string) => join(out, "vendor", "noble", pkg.slice("@noble/".length), sub);
  const written: string[] = [];
  const seen = new Set<string>();
  const visit = (pkg: string, sub: string) => {
    const key = `${pkg}/${sub}`;
    if (seen.has(key)) return;
    seen.add(key);
    const src = join(roots.get(pkg) as string, sub);
    const raw = readFileSync(src, "utf8").replace(/^\/\/# sourceMappingURL=.*$/m, "");
    if (/\bimport\s*\(/.test(raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")))
      throw new Error(`${key}: dynamic import`);
    // Only top-level import / export statements (doc-comment examples start with " * ").
    const code = raw.replace(STATEMENT, (stmt: string, spec: string) => {
      const bare = /^(@noble\/(?:curves|hashes))\/(.+)$/.exec(spec);
      if (bare) {
        visit(bare[1] as string, bare[2] as string);
        let rel = relative(dirname(destOf(pkg, sub)), destOf(bare[1] as string, bare[2] as string))
          .split("\\")
          .join("/");
        if (!rel.startsWith(".")) rel = `./${rel}`;
        return stmt.replace(spec, rel);
      }
      if (!spec.startsWith(".")) throw new Error(`${key}: imports ${spec}`);
      visit(pkg, join(dirname(sub), spec).split("\\").join("/"));
      return stmt;
    });
    mkdirSync(dirname(destOf(pkg, sub)), { recursive: true });
    writeFileSync(destOf(pkg, sub), code);
    written.push(destOf(pkg, sub));
  };
  for (const e of entries) {
    const pkg = VENDOR.find((v) => e.startsWith(`${v}/`));
    if (!pkg) throw new Error(`not a vendored package: ${e}`);
    visit(pkg, e.slice(pkg.length + 1));
  }
  for (const pkg of VENDOR) {
    copyFileSync(join(roots.get(pkg) as string, "LICENSE"), destOf(pkg, "LICENSE"));
    written.push(destOf(pkg, "LICENSE"));
  }
  return written;
}

/**
 * `config.json` from the build environment (Vercel project env vars):
 * ALCA_RELAY_URL (https:// or wss://) and ALCA_GOOGLE_CLIENT_ID (the Web
 * client). Neither is secret. Empty = the page's own origin / codes only.
 */
export function siteConfigFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  // P12: the official build variables fill in when the site's own are not set.
  const relay = (env.ALCA_RELAY_URL || env.ALCA_OFFICIAL_RELAY_URL)?.trim();
  const gid = (env.ALCA_GOOGLE_CLIENT_ID || env.ALCA_OFFICIAL_GOOGLE_CLIENT_ID)?.trim();
  if (relay && !/^(https|wss):\/\//.test(relay) && !/^(http|ws):\/\/(127\.0\.0\.1|localhost)/.test(relay))
    throw new Error("ALCA_RELAY_URL must be https:// or wss://");
  if (gid && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(gid))
    throw new Error("ALCA_GOOGLE_CLIENT_ID should look like <number>-<id>.apps.googleusercontent.com");
  return { ...(relay ? { relayUrl: relay } : {}), ...(gid ? { googleClientId: gid } : {}) };
}

/** R9: the words sw.ts names with tx("…"), in both languages (it cannot import the table). */
export function swWords(source: string): Record<string, Record<string, string>> {
  const keys = [...source.matchAll(/\btx\("([\w.-]+)"\)/g)].map((m) => m[1] as string);
  const pick = (table: Readonly<Record<string, string>>) =>
    Object.fromEntries(keys.map((k) => [k, table[k] ?? k] as const));
  return { "zh-Hant-TW": pick(zhHantTW), en: pick(en) };
}

export function buildPwa(
  outDir = join(HERE, "dist"),
  env: Record<string, string | undefined> = process.env,
): string {
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const nobleEntries = new Set<string>();

  // `text` (the string table): its values are words like `from "{name}"`, so only its
  // statements are checked, not every `from "` in the file.
  const js = (src: string, dest: string, linkPrefix: string, vendorPrefix = "../vendor/", text = false) => {
    const code = stripTypeScriptTypes(readFileSync(src, "utf8"), { mode: "strip" })
      .replace(/(from\s+|import\s*\(\s*)"@alca\/link\/browser"/g, `$1"${linkPrefix}browser.js"`)
      .replace(/(from\s+|import\s*\(\s*)"(\.{1,2}\/[^"]+)\.ts"/g, '$1"$2.js"')
      .replace(BARE, (_m, lead: string, q: string, pkg: string, sub: string) => {
        nobleEntries.add(`${pkg}/${sub}`);
        return `${lead}${q}${vendorPrefix}noble/${pkg.slice("@noble/".length)}/${sub}${q}`;
      });
    const checked = text ? [...code.matchAll(STATEMENT)].map((m) => m[0]).join("\n") : code;
    if (/from\s+"(node:|@alca\/)/.test(checked) || /(?:from\s+|import\s+)"(?![./])/.test(checked))
      throw new Error(`${src}: imports something a browser cannot load`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, code);
  };

  // App modules.
  for (const f of readdirSync(join(HERE, "app")))
    if (f.endsWith(".ts") && f !== "sw.ts")
      js(join(HERE, "app", f), join(out, "app", f.replace(/\.ts$/, ".js")), "../link/");

  // R9.3: the shared string table (@alca/design/src/i18n), imported by the app as ./i18n/….
  const i18n = (dir: string) => {
    for (const f of readdirSync(join(I18N_DIR, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${f.name}` : f.name;
      if (f.isDirectory()) i18n(rel);
      else if (f.name.endsWith(".ts"))
        js(
          join(I18N_DIR, rel),
          join(out, "app", "i18n", rel.replace(/\.ts$/, ".js")),
          "../link/",
          undefined,
          true,
        );
    }
  };
  i18n("");

  // Link's browser-safe modules: everything reachable from browser.ts.
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(join(LINK, file), "utf8");
    for (const m of src.matchAll(/from\s+"\.\/([^"]+\.ts)"/g)) walk(m[1] as string);
  };
  walk("browser.ts");
  for (const f of seen) js(join(LINK, f), join(out, "link", f.replace(/\.ts$/, ".js")), "./");
  // G1: the audited curve library Link's PAKE imports (see the header).
  vendorNoble(out, nobleEntries);

  // Static files.
  const copy = (from: string, to: string) => {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  };
  // Review L5: connect-src narrowed to the configured relay (scripts/csp.ts).
  writeFileSync(join(out, "index.html"), withConnectCsp(readFileSync(join(HERE, "index.html"), "utf8"), env));
  copy(join(HERE, "manifest.webmanifest"), join(out, "manifest.webmanifest"));
  // Site configuration (P10): the relay and the Google Web client ID, from the build environment.
  writeFileSync(join(out, "config.json"), `${JSON.stringify(siteConfigFromEnv(env))}\n`);
  copy(TOKENS_CSS_PATH, join(out, "tokens.css"));
  for (const f of readdirSync(join(HERE, "styles"))) copy(join(HERE, "styles", f), join(out, "styles", f));
  for (const f of readdirSync(join(HERE, "icons"))) copy(join(HERE, "icons", f), join(out, "icons", f));

  // Service worker: precache list + a version derived from the content.
  const files: string[] = [];
  const list = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) list(p);
      else files.push(relative(out, p));
    }
  };
  list(out);
  files.sort();
  const hash = createHash("sha256");
  for (const f of files) hash.update(f).update(readFileSync(join(out, f)));
  const version = hash.digest("hex").slice(0, 12);
  const assets = ["./", ...files.map((f) => `./${f}`)];
  const swSource = readFileSync(join(HERE, "app", "sw.ts"), "utf8");
  const sw = stripTypeScriptTypes(swSource, { mode: "strip" })
    .replace('JSON.parse("__WORDS__")', JSON.stringify(swWords(swSource)))
    .replace('"__VERSION__"', JSON.stringify(version))
    .replace('JSON.parse("__ASSETS__")', JSON.stringify(assets));
  writeFileSync(join(out, "sw.js"), sw);
  return out;
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
  const out = buildPwa(process.argv[2]);
  console.log(`phone PWA built → ${out}`);
}
