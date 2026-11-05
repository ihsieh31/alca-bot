// Fails when a studied project's name shows up in our tree (CLEANROOM.md rule 2:
// no other project's product names in identifiers, file names, docs or UI).
// Case-insensitive. A compound name (OpenBot, CopilotKit …) counts where an
// identifier word starts, so `openBotForm` and `showOpenBot` are caught but
// `reopenBottom` is not; a short or common word (Hermes, AG-UI, ego) counts only
// as a whole identifier word, so `category`, `Diego` or `hermetic` never match.
// Usage: node scripts/check-names.ts [path ...]   (default: git ls-files)
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Name {
  name: string;
  re: RegExp;
  /** Must also end where an identifier word ends. */
  whole: boolean;
}

export const NAMES: Name[] = [
  { name: "OpenMausBot", re: /open[-_ ]?maus[-_ ]?bot/gi, whole: false },
  { name: "MausBot", re: /maus[-_ ]?bot/gi, whole: false },
  { name: "OpenBot", re: /open[-_ ]?bot/gi, whole: false },
  { name: "CopilotKit", re: /copilot[-_ ]?kit/gi, whole: false },
  { name: "Hermes", re: /hermes/gi, whole: true },
  { name: "AG-UI", re: /ag[-_]?ui/gi, whole: true },
  { name: "Ego", re: /ego/gi, whole: true },
];

const alnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);
const upper = (c: string | undefined) => c !== undefined && /[A-Z]/.test(c);
const lower = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);

/** Where an identifier word starts: no letter before it, or a camelCase hump. */
function startsWord(text: string, at: number): boolean {
  const prev = text[at - 1];
  return !alnum(prev) || (upper(text[at]) && lower(prev));
}

/** Where an identifier word ends: no letter after it, or the next camelCase hump. */
function endsWord(text: string, end: number): boolean {
  const next = text[end];
  return !alnum(next) || (upper(next) && !upper(text[end - 1]));
}

/** Every forbidden name in one text (a file's content or its path), as `name: match`. */
export function findNames(text: string): Array<{ name: string; match: string; index: number }> {
  const out: Array<{ name: string; match: string; index: number }> = [];
  for (const n of NAMES)
    for (const m of text.matchAll(n.re)) {
      const at = m.index ?? 0;
      if (!startsWord(text, at)) continue;
      if (n.whole && !endsWord(text, at + m[0].length)) continue;
      // The longer compound already reported this spot (OpenMausBot also contains MausBot).
      if (out.some((o) => at >= o.index && at < o.index + o.match.length)) continue;
      out.push({ name: n.name, match: m[0], index: at });
    }
  return out;
}

const SKIP = [
  /^scripts\/check-names\.ts$/,
  /(^|\/)test\/forbidden-names\.test\.ts$/,
  /pnpm-lock\.yaml$/,
  /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|pdf|sqlite)$/,
];

export function scanFile(file: string, text: string): string[] {
  const hits = findNames(file).map((h) => `${file}: file name: ${h.name} (${h.match})`);
  text.split("\n").forEach((line, i) => {
    for (const h of findNames(line)) hits.push(`${file}:${i + 1}: ${h.name}: ${h.match}`);
  });
  return hits;
}

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length
    ? args
    : execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const hits: string[] = [];
  for (const f of files) {
    if (SKIP.some((s) => s.test(f))) continue;
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    hits.push(...scanFile(f, text));
  }
  if (hits.length) {
    console.error("Names of studied projects found (CLEANROOM.md rule 2; rename them):");
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log(`names: clean (${files.length} files)`);
}

/** Run as a script (not imported)? Real paths, so a checkout path with spaces still runs. */
function isMain(url: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) main();
