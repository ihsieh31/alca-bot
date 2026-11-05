// Phase E updater: the release list (drafts never, pre-releases by channel, a private repo
// through gh) and the two verification layers (release signature when the core carries a key,
// else checksum only — and nothing without a checksum).
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  githubSource,
  pickLatest,
  type ReleaseInfo,
  UpdateError,
} from "../src/update-release.ts";
import {
  checkAsset,
  loadReleaseKeys,
  parsePublicKey,
  parseSums,
  RELEASE_KEYS_FILE,
  releaseKeysFromEnv,
  verifySums,
  writeReleaseKeys,
} from "../src/update-verify.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alca-upd-v-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rel = (tag: string, o: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
  tag,
  version: tag.replace(/^v/, ""),
  draft: false,
  prerelease: false,
  htmlUrl: `https://example.invalid/${tag}`,
  assets: [],
  ...o,
});

describe("versions and the release list", () => {
  it("orders by semver, pre-releases before their release", () => {
    expect(compareVersions("v0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("0.3.0-rc.1", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("0.3.0-rc.2", "0.3.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("0.3.0-alpha", "0.3.0-rc.1")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("never offers a draft; a pre-release only on the prerelease channel", () => {
    const list = [
      rel("v0.2.0"),
      rel("v0.4.0", { draft: true }),
      rel("v0.3.0-rc.1", { prerelease: true }),
      rel("nightly"),
    ];
    expect(pickLatest(list, "stable")?.tag).toBe("v0.2.0");
    expect(pickLatest(list, "prerelease")?.tag).toBe("v0.3.0-rc.1");
    expect(pickLatest([rel("v0.2.0", { draft: true, prerelease: true })], "prerelease")).toBeUndefined();
  });

  it("reads the API anonymously; a private repo (404) goes through the signed-in GitHub CLI", async () => {
    const api = [{ tag_name: "v0.3.0", draft: false, prerelease: false, html_url: "u", assets: [] }];
    const calls: string[][] = [];
    const src = githubSource({
      repo: "o/r",
      fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
      gh: (args) => {
        calls.push(args);
        return args[0] === "auth" ? { code: 0, out: "" } : { code: 0, out: JSON.stringify(api) };
      },
    });
    expect((await src.list()).map((r) => r.tag)).toEqual(["v0.3.0"]);
    expect(calls[1]).toEqual(["api", "repos/o/r/releases?per_page=30"]);
    const pub = githubSource({
      repo: "o/r",
      fetch: (async () => new Response(JSON.stringify(api))) as typeof fetch,
      gh: () => {
        throw new Error("gh must not run for a public repository");
      },
    });
    expect((await pub.list())[0]?.tag).toBe("v0.3.0");
  });

  it("a private repo without gh: says to sign in to the GitHub CLI", async () => {
    const src = githubSource({
      repo: "o/r",
      fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
      gh: () => ({ code: 1, out: "" }),
    });
    await expect(src.list()).rejects.toThrow(/gh auth login/);
  });
});

describe("verification", () => {
  const pair = () => generateKeyPairSync("ed25519");
  const spki = (k: ReturnType<typeof pair>["publicKey"]) =>
    k.export({ format: "der", type: "spki" }).toString("base64");
  function release(content = "core bytes") {
    const file = join(dir, "alca-core-0.3.0.tar.gz");
    writeFileSync(file, content);
    const sha = createHash("sha256").update(content).digest("hex");
    const sums = Buffer.from(`${sha}  alca-core-0.3.0.tar.gz\n${"1".repeat(64)}  install.sh\n`);
    return { file, sha, sums };
  }

  it("parses sha256sum output", () => {
    const m = parseSums(`${"A".repeat(64)}  a.tar.gz\n${"b".repeat(64)} *b.exe\nnoise\n`);
    expect(m.get("a.tar.gz")).toBe("a".repeat(64));
    expect(m.get("b.exe")).toBe("b".repeat(64));
  });

  it("a core with a key: needs SHA256SUMS + a valid signature, then the file's line", () => {
    const k = pair();
    const r = release();
    const sig = Buffer.from(sign(null, r.sums, k.privateKey).toString("base64"));
    const keys = [parsePublicKey(spki(k.publicKey))];
    const base = { file: r.file, name: "alca-core-0.3.0.tar.gz", keys };
    expect(checkAsset({ ...base, sums: r.sums, sig }).mode).toBe("signed");
    expect(() => checkAsset({ ...base, sums: r.sums })).toThrow(/沒有發布簽章/);
    expect(() => checkAsset({ ...base, sidecar: `${r.sha}  x` })).toThrow(/沒有發布簽章/);
    const other = pair();
    const bad = Buffer.from(sign(null, r.sums, other.privateKey).toString("base64"));
    expect(() => checkAsset({ ...base, sums: r.sums, sig: bad })).toThrow(/簽章不符/);
    const tampered = Buffer.from(r.sums.toString().replace(r.sha, "f".repeat(64)));
    expect(() => checkAsset({ ...base, sums: tampered, sig })).toThrow(/簽章不符/);
    writeFileSync(r.file, "other bytes");
    expect(() => checkAsset({ ...base, sums: r.sums, sig })).toThrow(/檢查碼不符/);
  });

  it("a core without a key: checksum only (SHA256SUMS or the .sha256), never nothing", () => {
    const r = release();
    const base = { file: r.file, name: "alca-core-0.3.0.tar.gz", keys: [] };
    expect(checkAsset({ ...base, sums: r.sums }).mode).toBe("checksum");
    expect(checkAsset({ ...base, sidecar: `${r.sha}  alca-core-0.3.0.tar.gz\n` }).mode).toBe("checksum");
    expect(() => checkAsset(base)).toThrow(/找不到/);
    expect(() => checkAsset({ ...base, sidecar: `${"0".repeat(64)}  x` })).toThrow(/檢查碼不符/);
  });

  it("verifies what release.yml's openssl step signs (pkeyutl -rawin, base64)", () => {
    const ok = spawnSync("openssl", ["version"]).status === 0;
    if (!ok) return;
    const key = join(dir, "k.pem");
    expect(spawnSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", key]).status).toBe(0);
    const pub = spawnSync("openssl", ["pkey", "-in", key, "-pubout"], { encoding: "utf8" }).stdout;
    const sums = join(dir, "SHA256SUMS");
    writeFileSync(sums, `${"2".repeat(64)}  a\n`);
    const raw = spawnSync("openssl", ["pkeyutl", "-sign", "-rawin", "-inkey", key, "-in", sums]);
    expect(raw.status).toBe(0);
    const keys = releaseKeysFromEnv(pub).map(parsePublicKey);
    expect(verifySums(readFileSync(sums), Buffer.from(raw.stdout.toString("base64")), keys)).toBe(true);
    expect(verifySums(readFileSync(sums), raw.stdout, keys)).toBe(true);
    expect(verifySums(Buffer.from("x"), raw.stdout, keys)).toBe(false);
  });

  it("the packed key file: written from ALCA_RELEASE_PUBLIC_KEY; a broken one stops updates", () => {
    const k = pair();
    expect(writeReleaseKeys(dir, {})).toEqual([]);
    expect(loadReleaseKeys(dir)).toEqual([]);
    mkdirSync(join(dir, "apps/desktop"), { recursive: true });
    expect(writeReleaseKeys(dir, { ALCA_RELEASE_PUBLIC_KEY: spki(k.publicKey) })).toHaveLength(1);
    expect(loadReleaseKeys(dir)).toHaveLength(1);
    writeFileSync(join(dir, RELEASE_KEYS_FILE), "{");
    expect(() => loadReleaseKeys(dir)).toThrow(UpdateError);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() =>
      releaseKeysFromEnv(rsa.publicKey.export({ format: "pem", type: "spki" }).toString()),
    ).toThrow(/Ed25519/);
  });
});
