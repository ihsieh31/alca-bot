// Phase E updater: which releases exist and which one is newer. One GitHub source for
// `alca update check`, the hourly check and `alca update install`: the REST API without a
// token (a public repository), else the signed-in GitHub CLI (`gh api`, a private one). A draft
// is never offered (it is not published, whatever the token can see); a pre-release only on
// the `prerelease` channel.
import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_REPO = "ihsieh31/alca-bot";

export class UpdateError extends Error {}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: Array<string | number>;
}

/** `v0.2.0`, `0.3.0-rc.1` … (build metadata after `+` is ignored); undefined when it is not one. */
export function parseVersion(v: string): Semver | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/** semver precedence: <0 when a is older than b. Unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? 0 : 1) - (y.pre.length ? 0 : 1);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const bareVersion = (v: string): string => v.trim().replace(/^v/, "");

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  draft: boolean;
  prerelease: boolean;
  htmlUrl: string;
  publishedAt?: string;
  assets: ReleaseAsset[];
}

export type Channel = "stable" | "prerelease";

/** The newest release this channel may offer: never a draft, a pre-release only on `prerelease`. */
export function pickLatest(releases: readonly ReleaseInfo[], channel: Channel): ReleaseInfo | undefined {
  return releases
    .filter((r) => !r.draft && (channel === "prerelease" || !r.prerelease) && parseVersion(r.tag))
    .sort((a, b) => compareVersions(b.tag, a.tag))[0];
}

export type GhRunner = (args: string[]) => { code: number; out: string };

export const realGh: GhRunner = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 32 << 20 });
  return { code: r.status ?? (r.error ? 127 : 1), out: `${r.stdout ?? ""}` };
};

export interface ReleaseSource {
  readonly repo: string;
  list(): Promise<ReleaseInfo[]>;
  /** Download one asset of a release to `dest`; false when the release has no such file. */
  download(release: ReleaseInfo, name: string, dest: string): Promise<boolean>;
}

type ApiRelease = {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  published_at?: string | null;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
};

function fromApi(list: unknown): ReleaseInfo[] {
  if (!Array.isArray(list)) throw new UpdateError("GitHub 回的 release 清單看不懂");
  return (list as ApiRelease[])
    .filter((r) => typeof r.tag_name === "string")
    .map((r) => ({
      tag: r.tag_name as string,
      version: bareVersion(r.tag_name as string),
      draft: !!r.draft,
      prerelease: !!r.prerelease,
      htmlUrl: r.html_url ?? "",
      ...(r.published_at ? { publishedAt: r.published_at } : {}),
      assets: (r.assets ?? [])
        .filter((a) => a.name && a.browser_download_url)
        .map((a) => ({ name: a.name as string, url: a.browser_download_url as string })),
    }));
}

export interface GithubSourceOptions {
  repo?: string;
  userAgent?: string;
  fetch?: typeof globalThis.fetch;
  gh?: GhRunner;
}

/**
 * GitHub Releases. No token is ever sent by Alca itself: anonymous requests for a public
 * repository, the user's own `gh` login for a private one.
 */
export function githubSource(o: GithubSourceOptions = {}): ReleaseSource {
  const repo = o.repo ?? DEFAULT_REPO;
  const http = o.fetch ?? globalThis.fetch;
  const gh = o.gh ?? realGh;
  const headers = { accept: "application/vnd.github+json", "user-agent": o.userAgent ?? "alca-updater" };
  let viaGh = false;
  const ghReady = () => gh(["auth", "status"]).code === 0;
  return {
    repo,
    async list() {
      let status = 0;
      try {
        const res = await http(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
        status = res.status;
        if (res.ok) return fromApi(await res.json());
      } catch {
        status = -1;
      }
      if (!ghReady()) {
        throw new UpdateError(
          status === 404
            ? `看不到 ${repo} 的 release（私人 repo 需要先安裝並登入 GitHub CLI：gh auth login）`
            : `連不到 GitHub（${status === -1 ? "網路錯誤" : `HTTP ${status}`}）`,
        );
      }
      const r = gh(["api", `repos/${repo}/releases?per_page=30`]);
      if (r.code !== 0) throw new UpdateError(`GitHub CLI 也讀不到 ${repo} 的 release`);
      viaGh = true;
      return fromApi(JSON.parse(r.out));
    },
    async download(release, name, dest) {
      const asset = release.assets.find((a) => a.name === name);
      if (!asset) return false;
      if (!viaGh) {
        if (!asset.url.startsWith("https://")) throw new UpdateError(`只接受 https 下載：${asset.url}`);
        try {
          const res = await http(asset.url, {
            headers: { "user-agent": headers["user-agent"] },
            redirect: "follow",
          });
          if (res.ok) {
            writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
            return true;
          }
        } catch {
          // fall through to the GitHub CLI
        }
        if (!ghReady()) throw new UpdateError(`下載失敗：${name}`);
      }
      const dir = `${dest}.gh`;
      const r = gh([
        "release",
        "download",
        release.tag,
        "--repo",
        repo,
        "--pattern",
        name,
        "--dir",
        dir,
        "--clobber",
      ]);
      if (r.code !== 0) throw new UpdateError(`GitHub CLI 下載不到 ${name}`);
      copyFileSync(join(dir, name), dest);
      return true;
    },
  };
}
