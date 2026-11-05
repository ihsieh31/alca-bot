// Phase E: the release pipeline's promises, read from the workflow files: every action pinned
// by commit SHA, secrets only in the steps that use them and only behind an `if:`, no secret
// means ad-hoc / unsigned (never a failed run), the release stays a draft, and the files the
// updater and install.ps1 need are attached.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../../.github/workflows", import.meta.url));
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const release = read("release.yml");

/** The steps of the file, each as its text (a step starts at a `      - ` line). */
function steps(text: string): string[] {
  return text.split(/\n(?= {6}- )/).slice(1);
}

describe("workflows", () => {
  it("pin every action by a 40-character commit SHA", () => {
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".yml"))) {
      for (const line of read(f).split("\n")) {
        const m = /^\s*(?:- )?uses:\s*(\S+)/.exec(line);
        if (!m) continue;
        expect(m[1], `${f}: ${line.trim()}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("release.yml: no secret at workflow or job level", () => {
    const top = release.split("\njobs:")[0] as string;
    expect(top).not.toContain("secrets.");
    for (const line of release.split("\n"))
      if (/\$\{\{[^}]*secrets\./.test(line))
        expect(line.match(/^ */)?.[0].length ?? 0, line).toBeGreaterThanOrEqual(10);
  });

  it("release.yml: each step that reads a signing secret runs only when it is set", () => {
    const withSecret = steps(release).filter(
      (s) => /\$\{\{[^}]*secrets\./.test(s) && !/\bid: signing\b/.test(s),
    );
    expect(withSecret.length).toBeGreaterThanOrEqual(6);
    for (const s of withSecret) {
      const name = /name: (.+)/.exec(s)?.[1] ?? s.slice(0, 60);
      if (/tauri build/.test(name)) {
        // The build always runs; each secret there is gated by the signing step's true / false.
        for (const line of s.split("\n").filter((l) => /\$\{\{[^}]*secrets\./.test(l)))
          expect(line, name).toMatch(/steps\.signing\.outputs\.(sign|notarize) == 'true' && secrets\./);
        continue;
      }
      if (/release signature/.test(name)) {
        // No key = say so and stop the step successfully.
        expect(s, name).toMatch(/if \[ -z "\$ALCA_RELEASE_SIGNING_KEY" \]; then[\s\S]*?exit 0/);
        continue;
      }
      expect(s, name).toMatch(/\n\s+if: steps\.signing\.outputs\.(sign|notarize|win_sign) == 'true'/);
    }
  });

  it("release.yml: without secrets, ad-hoc on macOS and unsigned on Windows, stated in the notes", () => {
    expect(release).toMatch(/ad-hoc sign the bundled Node \(macOS, without the APPLE_\* secrets\)/);
    expect(release).toContain('signingIdentity: "-"');
    expect(release).toContain("Windows: NOT signed (no WINDOWS_CERTIFICATE secret)");
    expect(release).toContain("macOS: ad-hoc signed, NOT notarized");
    expect(release).toContain("--notes-file");
    expect(release).not.toContain("Unsigned pre-release build");
  });

  it("release.yml: notarizes the .dmg with notarytool, staples and checks; Authenticode must be Valid", () => {
    expect(release).toContain("xcrun notarytool submit");
    expect(release).toContain("xcrun stapler staple");
    expect(release).toContain("spctl --assess");
    expect(release).toContain("Get-AuthenticodeSignature");
    expect(release).toContain("certificateThumbprint");
  });

  it("release.yml: a draft only; SHA256SUMS (+ signature), install.ps1 attached and run on Windows", () => {
    expect(release).toMatch(/gh release create "\$TAG" dist\/\* --draft --prerelease/);
    expect(release).not.toMatch(/gh release (edit|publish)|--draft=false|draft: false/);
    expect(release).toContain("cp scripts/install.ps1 out/install.ps1");
    expect(release).toContain("> SHA256SUMS");
    expect(release).toContain("openssl pkeyutl -sign -rawin");
    expect(release).toContain("openssl pkeyutl -verify -rawin");
    expect(release).toMatch(/install-windows:[\s\S]*runs-on: windows-latest[\s\S]*install\.ps1 --tarball/);
    expect(release).toMatch(/needs: \[core, shell, install-windows\]/);
  });
});
