import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { supervisorPid, watchParent } from "../src/parent-watch.ts";

const MODULE = fileURLToPath(new URL("../src/parent-watch.ts", import.meta.url));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a core started by the desktop shell exits with it (mac test: orphaned core)", () => {
  it("reads ALCA_SUPERVISOR_PID only for the desktop shell", () => {
    expect(supervisorPid({ ALCA_SUPERVISED: "desktop-shell", ALCA_SUPERVISOR_PID: "4242" })).toBe(4242);
    expect(supervisorPid({ ALCA_SUPERVISED: "systemd", ALCA_SUPERVISOR_PID: "4242" })).toBeUndefined();
    expect(supervisorPid({ ALCA_SUPERVISED: "desktop-shell", ALCA_SUPERVISOR_PID: "1" })).toBeUndefined();
    expect(supervisorPid({ ALCA_SUPERVISED: "desktop-shell" })).toBeUndefined();
  });

  it("calls onGone once when the process is gone or we were reparented", async () => {
    let up = true;
    let ppid = 77;
    let gone = 0;
    watchParent({ pid: 77, intervalMs: 10, alive: () => up, parent: () => ppid, onGone: () => gone++ });
    await new Promise((r) => setTimeout(r, 40));
    expect(gone).toBe(0);
    ppid = 1; // reparented to launchd / init: the shell died
    await new Promise((r) => setTimeout(r, 40));
    expect(gone).toBe(1);
    let gone2 = 0;
    watchParent({ pid: 88, intervalMs: 10, alive: () => up, parent: () => 5, onGone: () => gone2++ });
    up = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(gone2).toBe(1);
  });

  it("a real child exits within seconds after its parent is SIGKILLed", async () => {
    // parent → child; the child watches the parent like the core watches the shell.
    const child = `
      const { watchParent } = await import(${JSON.stringify(MODULE)});
      watchParent({ pid: process.ppid, intervalMs: 100, onGone: () => process.exit(0) });
      setInterval(() => {}, 1000);`;
    const parent = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", ${JSON.stringify(child)}], { stdio: "ignore", detached: true });
      console.log(c.pid);
      setInterval(() => {}, 1000);`;
    const p = spawn(process.execPath, ["-e", parent], { stdio: ["ignore", "pipe", "inherit"] });
    const childPid = await new Promise<number>((resolve) =>
      p.stdout.once("data", (d: Buffer) => resolve(Number(String(d).trim()))),
    );
    expect(alive(childPid)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(childPid)).toBe(true);
    p.kill("SIGKILL");
    const until = Date.now() + 8000;
    while (alive(childPid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    const stillThere = alive(childPid);
    if (stillThere) process.kill(childPid, "SIGKILL");
    expect(stillThere).toBe(false);
  }, 15_000);
});
