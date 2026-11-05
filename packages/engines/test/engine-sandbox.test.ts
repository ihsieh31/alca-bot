import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfineSpec } from "@alca/os";
import { afterEach, describe, expect, it } from "vitest";
import { ACP_NO_STATE_DIRS, acpConfine } from "../src/acp/engine.ts";
import { claudeSandbox, isolationArgs } from "../src/claude/args.ts";
import { sandboxPolicy } from "../src/codex/app-server/rpc.ts";
import {
  AcpEngine,
  buildClaudeArgs,
  type EngineEvent,
  type EngineLaunchConfig,
  FAKE_ACP_SCRIPT,
  launchConfigHash,
  withTurnCwd,
} from "../src/index.ts";

/**
 * Next round §5.5: the CLI engines run their own commands in the bot's OS
 * sandbox — Claude Code's own sandbox from the one `--settings` block, Codex's
 * writable roots and network, an ACP agent's whole process.
 */

const spec = (o: Partial<ConfineSpec> = {}): ConfineSpec => ({
  kind: "bwrap",
  workDir: "/w/bot",
  tmpDir: "/d/tmp/bot",
  extraWritable: ["/h/.npm"],
  denyRead: ["/d/secrets.json", "/h/.ssh"],
  denyWriteInside: ["/w/bot/.git/config", "/w/bot/.claude"],
  network: "open",
  ...o,
});

const cfg = (o: Partial<EngineLaunchConfig> = {}): EngineLaunchConfig => ({
  engineId: "claude-code",
  cwd: "/w/bot",
  stablePrompt: "",
  env: {},
  approvalMode: "default",
  ...o,
});

const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");

describe("Claude Code: the sandbox block in --settings", () => {
  it("absent without a spec (the launch is exactly as before)", () => {
    expect(settingsOf(isolationArgs("/d"))).not.toHaveProperty("sandbox");
    expect(settingsOf(buildClaudeArgs(cfg(), {}))).toEqual({ disableAllHooks: true });
  });

  it("fails closed, never retries unsandboxed, and still asks Alca for every Bash", () => {
    const s = settingsOf(buildClaudeArgs(cfg({ confine: spec() }), { protectedDataDir: "/d" }));
    expect(s.disableAllHooks).toBe(true);
    expect(s.permissions.deny.length).toBeGreaterThan(0);
    expect(s.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
    });
    expect(s.sandbox.filesystem).toEqual({
      denyRead: ["/d/secrets.json", "/h/.ssh"],
      denyWrite: ["/w/bot/.git/config", "/w/bot/.claude"],
      allowWrite: ["/d/tmp/bot", "/h/.npm"],
    });
    // No allow rule that would also let WebFetch run unasked.
    expect(JSON.stringify(s.permissions)).not.toContain("WebFetch");
  });

  it("network none is an empty strict allowlist; open allows every host", () => {
    expect(claudeSandbox(spec({ network: "none" })).network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
    });
    expect(claudeSandbox(spec()).network).toEqual({ allowedDomains: ["*"] });
  });
});

describe("the launch hash follows the sandbox", () => {
  it("an unsandboxed hash is unchanged; a spec, or a changed spec, restarts the process", () => {
    const plain = launchConfigHash(cfg());
    const boxed = launchConfigHash(cfg({ confine: spec() }));
    expect(boxed).not.toBe(plain);
    expect(launchConfigHash(cfg({ confine: spec({ network: "none" }) }))).not.toBe(boxed);
    expect(launchConfigHash(cfg({ confine: spec({ extraWritable: ["/h/.npm", "/opt/x"] }) }))).not.toBe(
      boxed,
    );
    // Order of the lists does not matter.
    expect(launchConfigHash(cfg({ confine: spec({ denyRead: ["/h/.ssh", "/d/secrets.json"] }) }))).toBe(
      boxed,
    );
  });

  it("withTurnCwd carries the turn's spec into the launch", () => {
    const base = cfg();
    expect(withTurnCwd(base, {})).toBe(base);
    expect(withTurnCwd(base, { confine: spec() }).confine?.workDir).toBe("/w/bot");
    expect(withTurnCwd(base, { cwd: "/w/other", confine: spec() })).toMatchObject({ cwd: "/w/other" });
  });
});

describe("Codex app-server: writable roots and network from the spec", () => {
  it("workspace-write: the work folder only, network as the bot's setting", () => {
    expect(sandboxPolicy("workspace-write", "/cwd")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/cwd"],
      networkAccess: false,
    });
    expect(sandboxPolicy("workspace-write", "/cwd", spec())).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/w/bot"],
      networkAccess: true,
    });
    expect(sandboxPolicy("workspace-write", "/cwd", spec({ network: "none" }))).toMatchObject({
      networkAccess: false,
    });
    expect(sandboxPolicy("read-only", "/cwd", spec())).toEqual({ type: "readOnly" });
  });
});

describe("ACP: the whole agent process in the sandbox", () => {
  it("adds the agent's own state folders as writable; none declared → refused", () => {
    expect(acpConfine(undefined, undefined)).toBeUndefined();
    expect(() => acpConfine(spec(), undefined)).toThrow(ACP_NO_STATE_DIRS);
    expect(() => acpConfine(spec(), [])).toThrow(ACP_NO_STATE_DIRS);
    expect(acpConfine(spec(), ["~/.gemini", "/abs"], "/home/p")?.extraWritable).toEqual([
      "/h/.npm",
      "/home/p/.gemini",
      "/abs",
    ]);
  });

  const engines: AcpEngine[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(engines.splice(0).map((e) => e.dispose()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const turn = async (e: AcpEngine, confine?: ConfineSpec) => {
    const out: EngineEvent[] = [];
    for await (const ev of e.turn({
      threadId: "thr_sbx",
      runId: "run_1",
      system: { stable: "", volatile: "" },
      userMessage: "hi",
      signal: new AbortController().signal,
      ...(confine ? { confine } : {}),
    }))
      out.push(ev);
    return out;
  };

  it("an agent without stateDirs fails the turn when the sandbox is on (never runs unsandboxed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-sbx-"));
    dirs.push(dir);
    const e = new AcpEngine({
      id: "fake-acp",
      command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_ACP_SCRIPT],
      launch: () => cfg({ engineId: "fake-acp", cwd: dir }),
      sessions: { get: () => undefined, set: () => undefined },
      baseEnv: { FAKE_ACP_LOG: join(dir, "log.jsonl") },
    });
    engines.push(e);
    const out = await turn(e, spec({ workDir: dir }));
    expect(out.some((x) => x.type === "error")).toBe(true);
    expect(existsSync(join(dir, "log.jsonl"))).toBe(false);
  });

  let bwrap = false;
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/true"], {
      stdio: "ignore",
    });
    bwrap = process.platform === "linux";
  } catch {
    bwrap = false;
  }
  it.runIf(process.env.ALCA_REQUIRE_BWRAP === "1")("CI has a working bubblewrap for the ACP test", () => {
    expect(bwrap).toBe(true);
  });

  it.skipIf(!bwrap)(
    "inside bubblewrap the agent writes its work and state folders, not elsewhere",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "acp-sbx-"));
      dirs.push(root);
      const work = join(root, "work");
      const state = join(root, "state");
      const outside = join(root, "outside");
      const tmp = join(root, "tmp");
      for (const d of [work, state, outside, tmp]) mkdirSync(d);
      const logFile = join(work, "log.jsonl");
      const e = new AcpEngine({
        id: "fake-acp",
        command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_ACP_SCRIPT],
        launch: () => cfg({ engineId: "fake-acp", cwd: work }),
        sessions: { get: () => undefined, set: () => undefined },
        stateDirs: [state],
        baseEnv: {
          FAKE_ACP_LOG: logFile,
          FAKE_ACP_PROBE_WRITE: [join(work, "a"), join(state, "b"), join(outside, "c")].join(","),
        },
      });
      engines.push(e);
      const out = await turn(
        e,
        spec({
          kind: "bwrap",
          workDir: work,
          tmpDir: tmp,
          extraWritable: [],
          denyRead: [],
          denyWriteInside: [],
        }),
      );
      expect(out.some((x) => x.type === "error")).toBe(false);
      const probes = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { probe?: string; ok?: boolean; sandbox?: string })
        .filter((l) => l.probe);
      expect(probes.map((p) => [p.probe, p.ok])).toEqual([
        [join(work, "a"), true],
        [join(state, "b"), true],
        [join(outside, "c"), false],
      ]);
      expect(probes[0]?.sandbox).toBe("bwrap");
    },
  );
});
