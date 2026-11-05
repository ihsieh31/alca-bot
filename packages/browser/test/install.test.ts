import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChromiumInstaller,
  cftExecutable,
  cftPlatform,
  crc32c,
  crc32cBase64,
  DownloadError,
  downloadFile,
  extractZip,
  findChromium,
  type InstallState,
  parseGoogHash,
  pickDownload,
  ZipError,
} from "../src/index.ts";
import { makeZip } from "../testing/zip-writer.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "alca-install-"));

interface Served {
  body: Buffer;
  /** Cut the connection after this many bytes on the first N full-body requests. */
  cutAfter?: number;
  cuts?: number;
  hash?: "good" | "bad" | "none";
  status?: number;
  /** With `status`: answer it this many times, then serve the body (default: always). */
  statusTimes?: number;
}

// Real HTTP servers, files and zips: on a slow or busy machine (the mac test ran the suite in
// parallel) the 5 s default was too tight. The tests themselves wait on events, not on timers.
const SLOW = { timeout: 30_000 };

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(files: Record<string, Served>, index?: (base: string) => unknown) {
  const log: Array<{ path: string; range?: string }> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    log.push({ path, ...(req.headers.range ? { range: String(req.headers.range) } : {}) });
    if (path === "/index.json" && index) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(index(base)));
      return;
    }
    const f = files[path];
    if (!f) {
      res.writeHead(404).end();
      return;
    }
    if (f.status && (f.statusTimes === undefined || f.statusTimes-- > 0)) {
      res.writeHead(f.status).end();
      return;
    }
    const md5 = createHash("md5").update(f.body).digest("base64");
    const crc = crc32cBase64(crc32c(f.body));
    const hashHeader =
      f.hash === "none"
        ? {}
        : {
            "x-goog-hash":
              f.hash === "bad" ? `crc32c=${crc},md5=AAAAAAAAAAAAAAAAAAAAAA==` : `crc32c=${crc},md5=${md5}`,
          };
    const range = /bytes=(\d+)-/.exec(String(req.headers.range ?? ""));
    const start = range ? Number(range[1]) : 0;
    const head = { etag: '"v1"', "accept-ranges": "bytes", ...hashHeader };
    const chunk = f.body.subarray(start);
    if (range)
      res.writeHead(206, {
        ...head,
        "content-length": chunk.length,
        "content-range": `bytes ${start}-${f.body.length - 1}/${f.body.length}`,
      });
    else res.writeHead(200, { ...head, "content-length": chunk.length });
    if (f.cutAfter !== undefined && (f.cuts ?? 0) > 0) {
      f.cuts = (f.cuts ?? 0) - 1;
      res.write(chunk.subarray(0, f.cutAfter), () => setTimeout(() => res.destroy(), 50));
      return;
    }
    res.end(chunk);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return { base, log };
}

describe("checksums", SLOW, () => {
  it("CRC-32C matches the standard check value", () => {
    expect(crc32c(Buffer.from("123456789")).toString(16)).toBe("e3069283");
    // incremental
    expect(crc32c(Buffer.from("6789"), crc32c(Buffer.from("12345")))).toBe(crc32c(Buffer.from("123456789")));
  });
  it("parses x-goog-hash", () => {
    expect(parseGoogHash("crc32c=n03x6A==,md5=Ojk9c3dhfxgoKVVHYwFbHQ==")).toEqual({
      crc32c: "n03x6A==",
      md5: "Ojk9c3dhfxgoKVVHYwFbHQ==",
    });
    expect(parseGoogHash(null)).toEqual({});
  });
});

describe("downloadFile", SLOW, () => {
  it("resumes with Range after a dropped connection and verifies the MD5", async () => {
    const body = Buffer.alloc(300_000, 7);
    body.write("hello", 1000);
    const { base, log } = await serve({ "/f.zip": { body, cutAfter: 100_000, cuts: 1 } });
    const dir = tmp();
    const seen: number[] = [];
    const r = await downloadFile({
      url: `${base}/f.zip`,
      dest: join(dir, "f.zip"),
      backoffMs: 1,
      onProgress: (p) => seen.push(p.received),
    });
    expect(r.verified).toBe("md5");
    expect(readFileSync(join(dir, "f.zip")).equals(body)).toBe(true);
    expect(existsSync(join(dir, "f.zip.part"))).toBe(false);
    expect(log.length).toBe(2);
    expect(log[1]?.range).toMatch(/^bytes=\d+-$/);
    expect(Number(/\d+/.exec(log[1]?.range ?? "")?.[0])).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(body.length);
  });

  it("throws away a file whose hash does not match, and gives up after the retries", async () => {
    const { base, log } = await serve({ "/f.zip": { body: Buffer.from("abc"), hash: "bad" } });
    const dir = tmp();
    await expect(
      downloadFile({ url: `${base}/f.zip`, dest: join(dir, "f.zip"), backoffMs: 1, retries: 1 }),
    ).rejects.toThrow(/MD5/);
    expect(log.length).toBe(2);
    expect(existsSync(join(dir, "f.zip"))).toBe(false);
    expect(existsSync(join(dir, "f.zip.part"))).toBe(false);
  });

  it("falls back to a size check without hashes; 404 is not retried", async () => {
    const { base, log } = await serve({ "/a": { body: Buffer.from("xyz"), hash: "none" } });
    const dir = tmp();
    expect((await downloadFile({ url: `${base}/a`, dest: join(dir, "a"), backoffMs: 1 })).verified).toBe(
      "size",
    );
    await expect(
      downloadFile({ url: `${base}/missing`, dest: join(dir, "b"), backoffMs: 1 }),
    ).rejects.toBeInstanceOf(DownloadError);
    expect(log.filter((l) => l.path === "/missing").length).toBe(1);
  });

  it("retries 503 and resumes a part left by an earlier run", async () => {
    const body = Buffer.alloc(50_000, 3);
    // Two 503s, then the body: counted by the server, not raced against a timer (it was a
    // setTimeout(10) flipping the file while the client backed off 20 ms, which a busy CPU can reorder).
    const files: Record<string, Served> = { "/f": { body, status: 503, statusTimes: 2 } };
    const { base, log } = await serve(files);
    const dir = tmp();
    const dest = join(dir, "f");
    // An earlier run left half the file.
    writeFileSync(`${dest}.part`, body.subarray(0, 20_000));
    writeFileSync(
      `${dest}.part.json`,
      JSON.stringify({ url: `${base}/f`, etag: '"v1"', total: body.length }),
    );
    await downloadFile({ url: `${base}/f`, dest, backoffMs: 1, retries: 4 });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(log.filter((l) => l.path === "/f")).toHaveLength(3);
    expect(log.at(-1)?.range).toBe("bytes=20000-");
  });
});

describe("extractZip", SLOW, () => {
  it("keeps modes and symlinks, checks CRCs, refuses escapes", async () => {
    const dir = tmp();
    const zip = join(dir, "a.zip");
    writeFileSync(
      zip,
      makeZip([
        { name: "top/" },
        { name: "top/bin/run", data: "#!/bin/sh\necho hi\n", mode: 0o100755 },
        { name: "top/data.txt", data: "x".repeat(10_000) },
        { name: "top/raw.bin", data: Buffer.from([1, 2, 3]), store: true },
        { name: "top/link", data: "bin/run", mode: 0o120777 },
      ]),
    );
    const out = join(dir, "out");
    const ticks: number[] = [];
    expect((await extractZip(zip, out, { onEntry: (n) => ticks.push(n) })).entries).toBe(5);
    expect(readFileSync(join(out, "top/data.txt"), "utf8")).toBe("x".repeat(10_000));
    expect(statSync(join(out, "top/bin/run")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(out, "top/link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(out, "top/link"))).toBe("bin/run");
    expect(ticks).toEqual([1, 2, 3, 4, 5]);

    writeFileSync(zip, makeZip([{ name: "../evil", data: "x" }]));
    await expect(extractZip(zip, join(dir, "o2"))).rejects.toBeInstanceOf(ZipError);
    writeFileSync(zip, makeZip([{ name: "a/l", data: "../../../etc/passwd", mode: 0o120777 }]));
    await expect(extractZip(zip, join(dir, "o3"))).rejects.toThrow(/連結/);
    writeFileSync(zip, makeZip([{ name: "a/b", data: "hello", badCrc: true }]));
    await expect(extractZip(zip, join(dir, "o4"))).rejects.toThrow(/CRC/);
    writeFileSync(zip, Buffer.from("not a zip"));
    await expect(extractZip(zip, join(dir, "o5"))).rejects.toBeInstanceOf(ZipError);
  });
});

describe("extractZip: a macOS app bundle (mac test 2026-11-04b C1)", SLOW, () => {
  it("writes _CodeSignature, framework symlinks and Contents/ entries — nothing is skipped", async () => {
    const dir = tmp();
    const zip = join(dir, "app.zip");
    const app = "chrome-mac-arm64/Google Chrome for Testing.app/Contents";
    const fw = `${app}/Frameworks/Google Chrome for Testing Framework.framework`;
    const names = [
      `${app}/Info.plist`,
      `${app}/MacOS/Google Chrome for Testing`,
      `${app}/_CodeSignature/CodeResources`,
      `${fw}/Versions/157.0.8103.38/_CodeSignature/CodeResources`,
      `${fw}/Versions/157.0.8103.38/Resources/Info.plist`,
      "__MACOSX/._Info.plist",
    ];
    writeFileSync(
      zip,
      makeZip([
        ...names.map((name) => ({ name, data: `<${name}>`, mode: 0o100644 })),
        { name: `${fw}/Versions/Current`, data: "157.0.8103.38", mode: 0o120777 },
        { name: `${fw}/Resources`, data: "Versions/Current/Resources", mode: 0o120777 },
      ]),
    );
    const out = join(dir, "out");
    expect((await extractZip(zip, out)).entries).toBe(names.length + 2);
    for (const n of names) expect(readFileSync(join(out, n), "utf8"), n).toBe(`<${n}>`);
    expect(readlinkSync(join(out, `${fw}/Versions/Current`))).toBe("157.0.8103.38");
    expect(readFileSync(join(out, `${fw}/Resources/Info.plist`), "utf8")).toContain("Resources/Info.plist");
  });
});

describe("Chrome for Testing install", SLOW, () => {
  it("maps OS/arch to platforms", () => {
    expect(cftPlatform("darwin", "arm64")).toBe("mac-arm64");
    expect(cftPlatform("darwin", "x64")).toBe("mac-x64");
    expect(cftPlatform("linux", "x64")).toBe("linux64");
    expect(cftPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(cftPlatform("win32", "x64")).toBe("win64");
    expect(cftPlatform("win32", "ia32")).toBe("win32");
    expect(cftPlatform("freebsd", "x64")).toBeUndefined();
  });

  it("validates the index", () => {
    const idx = (url: string) => ({
      channels: { Stable: { version: "150.0.1.2", downloads: { chrome: [{ platform: "linux64", url }] } } },
    });
    expect(pickDownload(idx("https://storage.example.com/c.zip"), "linux64").version).toBe("150.0.1.2");
    expect(() => pickDownload(idx("http://evil.example.com/c.zip"), "linux64")).toThrow(/https/);
    expect(() => pickDownload(idx("https://x/c.zip"), "mac-arm64")).toThrow(/mac-arm64/);
    expect(() => pickDownload({ channels: {} }, "linux64")).toThrow(/版本/);
  });

  it("downloads, unpacks and records the browser; findChromium then finds it", async () => {
    const zipBody = makeZip([
      { name: "chrome-linux64/" },
      { name: "chrome-linux64/chrome", data: "#!/bin/sh\n", mode: 0o100755 },
      { name: "chrome-linux64/resources.pak", data: "r".repeat(5000) },
    ]);
    const { base } = await serve(
      { "/150/linux64/chrome-linux64.zip": { body: zipBody, cutAfter: 200, cuts: 1 } },
      (b) => ({
        channels: {
          Stable: {
            version: "150.0.1.2",
            downloads: { chrome: [{ platform: "linux64", url: `${b}/150/linux64/chrome-linux64.zip` }] },
          },
        },
      }),
    );
    const dir = join(tmp(), "bin");
    const states: InstallState[] = [];
    const inst = new ChromiumInstaller({
      dir,
      indexUrl: `${base}/index.json`,
      platform: "linux",
      arch: "x64",
      backoffMs: 1,
    });
    inst.subscribe((s) => states.push(s));
    const [a, b] = await Promise.all([inst.ensure(), inst.ensure()]);
    expect(a).toBe(cftExecutable(dir, "linux64"));
    expect(b).toBe(a);
    expect(statSync(a).mode & 0o111).not.toBe(0);
    const phases = [...new Set(states.map((s) => s.phase))];
    expect(phases).toEqual(["checking", "downloading", "verifying", "extracting", "ready"]);
    expect(states.find((s) => s.phase === "downloading" && s.total)?.total).toBe(zipBody.length);
    expect(inst.installed()?.version).toBe("150.0.1.2");
    expect(existsSync(join(dir, ".download", "chrome-linux64-150.0.1.2.zip"))).toBe(false);
    expect(findChromium({ env: {}, bundledDir: dir, exists: (p) => p === a })).toBe(a);
    // A second installer over the same dir sees it as ready without a download.
    expect(new ChromiumInstaller({ dir, platform: "linux", arch: "x64" }).state().phase).toBe("ready");
  });

  it("reports a failure (no build for this machine; bad archive) and can try again", async () => {
    const inst = new ChromiumInstaller({ dir: tmp(), platform: "freebsd", arch: "x64" });
    await expect(inst.ensure()).rejects.toThrow(/ALCA_CHROMIUM/);
    expect(inst.state().phase).toBe("failed");

    const { base } = await serve({ "/c.zip": { body: Buffer.from("garbage") } }, (b) => ({
      channels: {
        Stable: {
          version: "150.0.0.1",
          downloads: { chrome: [{ platform: "mac-arm64", url: `${b}/c.zip` }] },
        },
      },
    }));
    const dir = tmp();
    const mac = new ChromiumInstaller({
      dir,
      indexUrl: `${base}/index.json`,
      platform: "darwin",
      arch: "arm64",
      backoffMs: 1,
    });
    await expect(mac.ensure()).rejects.toBeInstanceOf(ZipError);
    expect(mac.state()).toMatchObject({ phase: "failed", platform: "mac-arm64" });
    expect(existsSync(join(dir, ".download", "chrome-mac-arm64-150.0.0.1.zip"))).toBe(false);
  });
});
