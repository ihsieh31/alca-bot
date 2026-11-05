import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BashSessions, CodingTools, groupMembers, type HostTool, runCommand } from "../src/index.ts";

/**
 * Plan §2.5 / §4: no process a bash session started outlives it. A command
 * that leaves children in the background (one of them with its output sent
 * away, so it no longer holds the session's pipe) is ended with its whole
 * process group: when the shell exits, on `closeAll` and on worker release.
 * A group left behind keeps a CI job open after its last step.
 */

const root = mkdtempSync(join(tmpdir(), "alca-coding-groups-"));
const opened: BashSessions[] = [];
const tools: CodingTools[] = [];
afterEach(() => {
  for (const b of opened.splice(0)) b.closeAll();
  for (const t of tools.splice(0)) t.closeAll();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sessions = () => {
  const b = new BashSessions();
  opened.push(b);
  return b;
};

/** Background children (one detached from the pipe), then print the shell's process group. */
const LEAVES_CHILDREN =
  "sleep 30 & (sleep 30 > /dev/null 2>&1 &); echo pgid=$(ps -o pgid= -p $$ | tr -d ' ')";

const pgidOf = (text: string): number => {
  const m = /pgid=(\d+)/.exec(text);
  if (!m) throw new Error(`no pgid in: ${text}`);
  return Number(m[1]);
};

const emptied = async (pgid: number, ms = 6000): Promise<number[]> => {
  const start = Date.now();
  let left = groupMembers(pgid);
  while (left.length && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    left = groupMembers(pgid);
  }
  return left;
};

describe.skipIf(process.platform === "win32")("bash sessions leave no process group behind", () => {
  it("a background session's group is empty after closeAll", async () => {
    const b = sessions();
    const r = await b.exec({
      command: `${LEAVES_CHILDREN}; wait`,
      cwd: root,
      background: true,
      yieldMs: 500,
    });
    expect(r.running).toBe(true);
    const pgid = pgidOf(r.text);
    expect(groupMembers(pgid).length).toBeGreaterThan(0);
    b.closeAll();
    expect(await emptied(pgid)).toEqual([]);
    expect(b.running()).toBe(0);
  });

  it("a foreground command that leaves children returns, and its group ends with it", async () => {
    const b = sessions();
    const r = await b.exec({ command: LEAVES_CHILDREN, cwd: root, timeoutMs: 20_000 });
    expect(r).toMatchObject({ status: "exited", exitCode: 0 });
    expect(r.durationMs).toBeLessThan(10_000);
    expect(await emptied(pgidOf(r.text))).toEqual([]);
  });

  it("closeAll still ends a group whose shell has already exited", async () => {
    const b = sessions();
    const r = await b.exec({ command: `${LEAVES_CHILDREN}; exit 0`, cwd: root, background: true });
    const pgid = pgidOf(
      `${r.text}${(await b.poll({ sessionId: r.sessionId ?? 0, yieldMs: 1000 }).catch(() => ({ text: "" }))).text}`,
    );
    b.closeAll();
    expect(await emptied(pgid)).toEqual([]);
  });

  it("runCommand (the host's checks) leaves nothing in its group", async () => {
    const r = await runCommand({ command: LEAVES_CHILDREN, cwd: root, timeoutMs: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(await emptied(pgidOf(r.output))).toEqual([]);
  });

  it("worker release ends the worker's background sessions and their groups", async () => {
    const t = new CodingTools({ dirFor: () => root });
    tools.push(t);
    const bash = t.tools().find((x) => x.spec.name === "bash") as HostTool;
    const ctx = {
      actionClass: "write" as const,
      threadId: "thr_1",
      runId: "run_1",
      botId: "bot_1",
      workerId: "wkr_g",
    };
    const out = String(
      await bash.run(
        { command: `${LEAVES_CHILDREN}; wait`, background: true, yieldMs: 500 },
        new AbortController().signal,
        ctx,
      ),
    );
    const pgid = pgidOf(out);
    expect(t.running("wkr_g")).toBe(1);
    t.release("wkr_g");
    expect(t.running("wkr_g")).toBe(0);
    expect(await emptied(pgid)).toEqual([]);
  });
});
