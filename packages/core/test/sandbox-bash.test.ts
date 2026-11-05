import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfineSpec, configDenyWrite, dataDenyRead, realOrResolved } from "@alca/os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "../src/agents/harness-run/verify.ts";
import { runCommand } from "../src/harness/coding/bash.ts";

/**
 * Next-round §5.11: the bash entry inside a real bubblewrap. Runs on Linux
 * when `bwrap` can start (CI installs it); skipped otherwise, with the
 * reason in the test name. macOS Seatbelt is a device test (DEVICE-TEST.md).
 */

let bwrap = false;
let why = "";
try {
  execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/true"], {
    stdio: "ignore",
  });
  bwrap = process.platform === "linux";
  if (!bwrap) why = "（不是 Linux）";
} catch {
  why = "（這台機器沒有可用的 bubblewrap）";
}

let root = "";
let data = "";
let work = "";
let tmp = "";
let outside = "";
let server: Server | undefined;
let port = 0;

const spec = (o: Partial<ConfineSpec> = {}): ConfineSpec => ({
  kind: "bwrap",
  workDir: work,
  tmpDir: tmp,
  extraWritable: [],
  denyRead: dataDenyRead(data, [work, tmp]),
  denyWriteInside: configDenyWrite(work),
  network: "open",
  ...o,
});

beforeAll(async () => {
  root = realOrResolved(mkdtempSync(join(tmpdir(), "alca-sbx-")));
  data = join(root, "data");
  work = join(data, "bots", "b1", "work");
  tmp = join(data, "tmp", "b1");
  outside = join(root, "outside");
  for (const d of [work, tmp, outside, join(data, "bots", "b2", "work"), join(work, ".git", "hooks")])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(data, "secrets.json"), '{"token":"s3cret"}');
  writeFileSync(join(data, "bots", "b2", "work", "theirs.txt"), "b2");
  writeFileSync(join(work, ".git", "config"), "[core]\n");
  server = createServer((s) => s.end("pong\n"));
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const run = (command: string, confine: ConfineSpec | null = spec()) =>
  runCommand({ command, cwd: work, timeoutMs: 20_000, ...(confine ? { confine } : {}) });

it.runIf(process.env.ALCA_REQUIRE_BWRAP === "1")("CI has a working bubblewrap (ALCA_REQUIRE_BWRAP)", () => {
  expect(bwrap, why).toBe(true);
});

describe.skipIf(!bwrap)(`bash inside bubblewrap${why}`, () => {
  it("writes inside the work folder, not outside", async () => {
    const r = await run(`echo ok > a.txt && cat a.txt; touch "${outside}/x" && echo LEAK`);
    expect(r.output).toContain("ok");
    expect(r.output).not.toContain("LEAK");
    expect(existsSync(join(outside, "x"))).toBe(false);
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("ok\n");
  });

  it("the home folder is not writable", async () => {
    const probe = join(homedir(), `.alca-sbx-${process.pid}`);
    const r = await run(`touch "${probe}" && echo LEAK`);
    expect(r.output).not.toContain("LEAK");
    expect(existsSync(probe)).toBe(false);
  });

  it("Alca's secrets and other bots' folders read as nothing", async () => {
    const r = await run(`cat "${data}/secrets.json"; ls "${data}/bots/b2"; echo done`);
    expect(r.output).not.toContain("s3cret");
    expect(r.output).not.toContain("theirs.txt");
    expect(r.output).toContain("done");
  });

  it(".git/config and .git/hooks inside the work folder are not writable", async () => {
    const r = await run(
      `echo '[core] fsmonitor = /tmp/evil' >> .git/config; echo x > .git/hooks/pre-commit; echo done`,
    );
    expect(r.output).toContain("done");
    expect(readFileSync(join(work, ".git", "config"), "utf8")).toBe("[core]\n");
    expect(existsSync(join(work, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("TMPDIR is the session's own temp folder and it is removed after the session", async () => {
    const r = await run('echo "$TMPDIR"; echo t > "$TMPDIR/f" && echo wrote');
    expect(r.output).toContain(`${tmp}/`);
    expect(r.output).toContain("wrote");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("network open reaches a local server; network none does not", async () => {
    const probe = `exec 3<>/dev/tcp/127.0.0.1/${port} && head -1 <&3 || echo NONET`;
    const open = await runCommand({ command: probe, cwd: work, timeoutMs: 20_000, confine: spec() });
    expect(open.output).toContain("pong");
    const none = await runCommand({
      command: probe,
      cwd: work,
      timeoutMs: 20_000,
      confine: spec({ network: "none" }),
    });
    expect(none.output).toContain("NONET");
  });

  it("the end-of-task checks run through the same entry (confined)", async () => {
    const r = await runCheck(`touch "${outside}/check" && echo LEAK`, work, undefined, 20_000, spec());
    expect(r.output).not.toContain("LEAK");
    expect(existsSync(join(outside, "check"))).toBe(false);
  });

  it("without a spec the command runs exactly as before", async () => {
    const r = await run(`touch "${outside}/free" && echo wrote`, null);
    expect(r.output).toContain("wrote");
    expect(existsSync(join(outside, "free"))).toBe(true);
  });
});
