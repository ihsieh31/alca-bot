// Fails when the version fields disagree (review M7): every workspace
// package.json, the root package.json, the desktop shell's tauri.conf.json,
// Cargo.toml and its Cargo.lock entry carry one version. With a tag given
// (`node scripts/check-versions.ts v0.2.0`, release.yml does this), that
// version must also be the tag's. Source that writes a version literal
// (`version: "0.1.0"`) instead of reading it fails too.
// Usage: node scripts/check-versions.ts [tag]
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface VersionField {
  file: string;
  version: string | undefined;
}

export function versionFields(root = ROOT): VersionField[] {
  const out: VersionField[] = [];
  const pkgs = execFileSync("git", ["ls-files", "package.json", "*/package.json"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && !f.includes("node_modules/"));
  for (const f of pkgs)
    out.push({ file: f, version: JSON.parse(readFileSync(join(root, f), "utf8")).version });
  const tauri = "apps/desktop-shell/src-tauri/tauri.conf.json";
  out.push({ file: tauri, version: JSON.parse(readFileSync(join(root, tauri), "utf8")).version });
  const cargo = "apps/desktop-shell/src-tauri/Cargo.toml";
  out.push({
    file: cargo,
    version: /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, cargo), "utf8"))?.[1],
  });
  const lock = "apps/desktop-shell/src-tauri/Cargo.lock";
  out.push({
    file: lock,
    version: /\[\[package\]\]\nname = "alca-desktop-shell"\nversion = "([^"]+)"/.exec(
      readFileSync(join(root, lock), "utf8"),
    )?.[1],
  });
  return out;
}

/**
 * Source files that write Alca's version as a literal (`version: "0.1.0"` in an
 * ACP clientInfo or an MCP server's info) instead of reading the one version
 * (packages/engines/src/version.ts): these drift when the manifests move on.
 * Tests and fixtures are not scanned.
 */
export function versionLiterals(root = ROOT): string[] {
  const files = execFileSync("git", ["ls-files", "--", "*.ts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /^(packages|apps|services)\/[^/]+\/(src|app|ui)\//.test(f) && !f.includes("/test"));
  const out: string[] = [];
  const re = /\bversion:\s*["'`](\d+\.\d+\.\d+)["'`]/g;
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      out.push(`${f}:${line}: version literal "${m[1]}" (read ALCA_VERSION / package.json instead)`);
    }
  }
  return out;
}

/** The problems, or [] when every field carries one version (and the tag's, when given). */
export function versionProblems(fields: VersionField[], tag?: string): string[] {
  const seen = new Map<string, string[]>();
  for (const f of fields) {
    const v = f.version ?? "(none)";
    seen.set(v, [...(seen.get(v) ?? []), f.file]);
  }
  const problems: string[] = [];
  if (seen.size > 1) for (const [v, files] of seen) problems.push(`${v}: ${files.join(", ")}`);
  const want = tag?.replace(/^v/, "");
  if (want && seen.size === 1 && !seen.has(want))
    problems.push(`tag ${tag} but the version is ${[...seen.keys()][0]}`);
  return problems;
}

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
  const fields = versionFields();
  const problems = versionProblems(fields, process.argv[2]);
  if (problems.length) {
    console.error("Version fields disagree (set them all to one version):");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const literals = versionLiterals();
  if (literals.length) {
    console.error("Source writes a version instead of reading the one version:");
    for (const l of literals) console.error(`  ${l}`);
    process.exit(1);
  }
  console.log(`versions: ${fields[0]?.version} in ${fields.length} files`);
}
