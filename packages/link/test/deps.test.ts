// G1 dependency rule: the only runtime crypto dependency is pinned to an
// exact version, its lockfile integrity is the one recorded in
// THIRD_PARTY_NOTICES.md, and nothing else crept into @alca/link.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

const PINS: Record<string, { version: string; integrity: string }> = {
  "@noble/curves": {
    version: "2.3.0",
    integrity:
      "sha512-v7cY+4oWYPQszRj6ZFGzTVL7uP2TaLo1xMhWHzYC5wj0ZhOXQ5x+sBre8rF3hi8cAoi0bh1qXoovoOkdFtvqEg==",
  },
  "@noble/hashes": {
    version: "2.3.0",
    integrity:
      "sha512-oN+QwyX7VSHotibwubG3kpzbwKrfnyR6OOO+3Nk/53ADL7FmgHHz4TgrbaYKvvOw09u6QTx0oiH1cNCIOuN0CQ==",
  },
};

describe("@alca/link runtime dependencies (G1)", () => {
  it("are exactly the pinned noble packages, at exact versions", () => {
    const pkg = JSON.parse(read("packages/link/package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toEqual(
      Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, v.version])),
    );
  });

  it("the lockfile resolves each to that version with the recorded integrity", () => {
    const lock = read("pnpm-lock.yaml");
    for (const [name, p] of Object.entries(PINS)) {
      const block = new RegExp(
        `\\n  '${name}@${p.version}':\\n    resolution: \\{integrity: ([^}]+)\\}`,
      ).exec(lock);
      expect(block?.[1], name).toBe(p.integrity);
      const importer = new RegExp(
        `'${name}':\\n        specifier: ([^\\n]+)\\n        version: ([^\\n]+)`,
      ).exec(lock);
      expect(importer?.slice(1), name).toEqual([p.version, p.version]);
    }
  });

  it("THIRD_PARTY_NOTICES.md lists each with its version, license and integrity", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    for (const [name, p] of Object.entries(PINS)) {
      const row = notices.split("\n").find((l) => l.startsWith(`| \`${name}\``));
      expect(row, name).toBeDefined();
      expect(row).toContain(p.version);
      expect(row).toContain("MIT");
      expect(row).toContain(p.integrity);
    }
  });
});
