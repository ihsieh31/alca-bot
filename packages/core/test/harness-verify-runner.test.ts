import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/agents/harness-run/verify.ts";

/**
 * Phase 1b's behaviour baseline, kept as is in Phase 3: checks now run in a
 * bash session (plan §2.5), and the runner keeps its promises — a stop or the
 * timeout ends the whole tree, grandchildren included, and the result says
 * which.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A check that starts a grandchild (writing its pid) and then waits forever. */
function hangingTree(): { dir: string; command: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "alca-verify-"));
  dirs.push(dir);
  const pidFile = join(dir, "grandchild.pid");
  writeFileSync(
    join(dir, "parent.js"),
    [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
      'console.log("started");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  return { dir, command: "node parent.js", pidFile };
}

/** Alive and not a zombie (a killed orphan may wait for a reaper that never comes in a container). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
};

const waitFor = async (fn: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(process.platform === "win32")("check runner (bash session, own process group)", () => {
  it("a stop kills the check and its grandchild; the result is stopped, not red", async () => {
    const t = hangingTree();
    const c = new AbortController();
    const running = runCheck(t.command, t.dir, c.signal);
    await waitFor(() => existsSync(t.pidFile) && readFileSync(t.pidFile, "utf8").length > 0);
    const pid = Number(readFileSync(t.pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    c.abort();
    const r = await running;
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBeUndefined();
    await waitFor(() => !alive(pid));
  }, 20_000);

  it("the timeout kills the whole tree and says so", async () => {
    const t = hangingTree();
    const running = runCheck(t.command, t.dir, undefined, 1500);
    await waitFor(() => existsSync(t.pidFile) && readFileSync(t.pidFile, "utf8").length > 0);
    const pid = Number(readFileSync(t.pidFile, "utf8"));
    const r = await running;
    expect(r).toMatchObject({ exitCode: null, timedOut: true });
    expect(r.output).toContain("started");
    await waitFor(() => !alive(pid));
  }, 20_000);
});
