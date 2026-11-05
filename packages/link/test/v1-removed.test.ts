// pake-v1-remove: a grep guard that PAKE v1 is gone from everything that
// ships (the link library, the computer, the phone page, the hands daemon,
// the settings schema). The frozen v1 implementation lives only under
// packages/link/test/fixtures/v1, where the tests use it to play an old peer
// and show it is refused. Session labels ("alca-link/v1 session…") are not
// v1 PAKE: LINK_VERSION stays 1 and paired devices reconnect with them.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHIPPED = [
  "packages/link/src",
  "packages/config/src",
  "apps/desktop/src",
  "apps/desktop/ui",
  "apps/phone-pwa/app",
  "apps/phone-pwa/scripts",
  "apps/hands/src",
];
const FORBIDDEN: Array<[string, RegExp]> = [
  ["v1 PAKE module import", /from\s+["']\.{1,2}\/(?:[\w./-]*\/)?(?:pake|p256)(?:\.ts|\.js)["']/],
  ["v1 PAKE functions", /\b(?:pakeStart|pakeFinish|pakeConstants|hashToPoint|passwordScalar)\b(?!V2)/],
  ["v1 version constant", /\bPAKE_V1\b/],
  ["v1 escape hatch option", /\ballowPakeV1\b/],
  ["v1 escape hatch setting", /\bpakeV1\b/],
  ["v1 PAKE label", /spake2-p256/],
  ["v1 pairing / enrollment key labels", /alca-link\/v1 (?:pair|enroll)\b/],
  ["v1 opt-in on the device", /\brequirePakeV2\b/],
];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "dist") return [];
    return statSync(p).isDirectory() ? files(p) : /\.(?:ts|js|mjs|html)$/.test(f) ? [p] : [];
  });

export function findV1(roots = SHIPPED): string[] {
  const hits: string[] = [];
  for (const r of roots) {
    const dir = join(ROOT, r);
    if (!existsSync(dir)) continue;
    for (const f of files(dir)) {
      const text = readFileSync(f, "utf8");
      for (const [what, re] of FORBIDDEN) if (re.test(text)) hits.push(`${relative(ROOT, f)}: ${what}`);
    }
  }
  return hits;
}

describe("PAKE v1 is removed from everything that ships", () => {
  it("no shipped source carries v1 PAKE code, its labels, or its setting", () => {
    expect(findV1()).toEqual([]);
  });

  it("the v1 modules exist only as frozen test fixtures", () => {
    expect(existsSync(join(ROOT, "packages/link/src/pake.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "packages/link/src/p256.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "packages/link/test/fixtures/v1/pake.ts"))).toBe(true);
  });

  it("the guard is live: it flags the frozen fixtures it is not allowed to see in src", () => {
    const hits = findV1(["packages/link/test/fixtures/v1"]);
    expect(hits.some((h) => h.includes("v1 PAKE functions"))).toBe(true);
    expect(hits.some((h) => h.includes("v1 PAKE label"))).toBe(true);
    expect(hits.some((h) => h.includes("v1 pairing / enrollment key labels"))).toBe(true);
  });
});
