// Write the official service's public endpoints into the gitignored
// `apps/desktop/official-config.json` from build variables (P12):
//
//   ALCA_OFFICIAL_RELAY_URL=https://… ALCA_OFFICIAL_SITE_URL=https://… \
//   ALCA_OFFICIAL_GOOGLE_CLIENT_ID=….apps.googleusercontent.com \
//   node scripts/gen-official-config.ts [out.json]
//
// In CI these are GitHub Actions repository variables (release.yml); the
// source keeps no deployment value (scripts/check-deploy-values.ts). With no
// variable set the file is not written and Alca starts with empty defaults.
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OFFICIAL_CONFIG_PATH, type OfficialConfig, officialFromEnv } from "../apps/desktop/src/official.ts";

export function writeOfficialConfig(
  out = OFFICIAL_CONFIG_PATH,
  env: Record<string, string | undefined> = process.env,
): OfficialConfig | undefined {
  const given = [
    "ALCA_OFFICIAL_RELAY_URL",
    "ALCA_OFFICIAL_SITE_URL",
    "ALCA_OFFICIAL_GOOGLE_CLIENT_ID",
  ].filter((k) => env[k]?.trim());
  const cfg = officialFromEnv(env);
  if (given.length !== Object.keys(cfg).length)
    throw new Error(`official config: a value is malformed (${given.join(", ")})`);
  if (!given.length) return undefined;
  writeFileSync(out, `${JSON.stringify(cfg, null, 2)}\n`);
  return cfg;
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
  const out = process.argv[2] ?? OFFICIAL_CONFIG_PATH;
  const cfg = writeOfficialConfig(out);
  console.log(
    cfg
      ? `official config → ${out} (${Object.keys(cfg).join(", ")})`
      : "official config: no ALCA_OFFICIAL_* set, nothing written",
  );
}
