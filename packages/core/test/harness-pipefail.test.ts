import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck, runChecks } from "../src/agents/harness-run/verify.ts";
import { BashSessions } from "../src/harness/coding/bash.ts";
import { hasPipe, PIPE_NOTE, shellChoice, shellFor } from "../src/harness/coding/shell.ts";

describe("hasPipe", () => {
  it("sees a pipe and ignores ||, quotes and >|", () => {
    expect(hasPipe("false | true")).toBe(true);
    expect(hasPipe("a|b")).toBe(true);
    expect(hasPipe("a || b")).toBe(false);
    expect(hasPipe("echo 'a|b'")).toBe(false);
    expect(hasPipe('echo "a|b"')).toBe(false);
    expect(hasPipe("echo a >| f")).toBe(false);
    expect(hasPipe("echo a\\|b")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("pipefail (research audit A4)", () => {
  let dir: string;
  const saved = shellChoice.bash;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alca-pipe-"));
  });
  afterEach(() => {
    shellChoice.bash = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const hasBash = () => {
    shellChoice.bash = undefined;
    return shellFor("true").pipefail;
  };

  it("uses bash -o pipefail when bash is there", () => {
    shellChoice.bash = "/bin/bash";
    expect(shellFor("x").args).toEqual(["-o", "pipefail", "-c", "x"]);
  });

  it("false | true fails in the bash tool", async () => {
    if (!hasBash()) return;
    const b = new BashSessions();
    const r = await b.exec({ command: "false | true", cwd: dir });
    b.closeAll();
    expect(r.exitCode).not.toBe(0);
    expect(r.text).not.toContain(PIPE_NOTE);
  });

  it("false | true fails the host's check", async () => {
    if (!hasBash()) return;
    const r = await runCheck("false | true", dir);
    expect(r.exitCode).not.toBe(0);
    const all = await runChecks(["true", "false | true"], dir);
    expect(all.ok).toBe(false);
  });

  it("under sh only, a piped command gets the note and a plain one does not", async () => {
    shellChoice.bash = null;
    const b = new BashSessions();
    const piped = await b.exec({ command: "echo hi | cat", cwd: dir });
    const plain = await b.exec({ command: "echo hi", cwd: dir });
    b.closeAll();
    expect(piped.text).toContain(PIPE_NOTE);
    expect(plain.text).not.toContain(PIPE_NOTE);
  });

  it("under sh only, the check still runs and carries the note", async () => {
    shellChoice.bash = null;
    const ok = await runCheck("echo fine | cat", dir);
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain("fine");
    expect(ok.output).toContain(PIPE_NOTE);
  });
});
