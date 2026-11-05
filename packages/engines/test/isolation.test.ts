import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  ClaudeCodeEngine,
  CodexEngine,
  type EngineEvent,
  type EngineLaunchConfig,
  engineEnv,
  FAKE_CLAUDE_SCRIPT,
  FAKE_CODEX_SCRIPT,
  type PermissionRequest,
  prepareCodexHome,
} from "../src/index.ts";

/**
 * Review 2026-11-04b S1 (the engines' own configuration must not decide for
 * Alca) and M6 (engine children do not inherit the core's environment).
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

type Launch = { args: string[]; allowRules: string[]; userMcp: string[]; env: string[] };

function claude(o: { home: string; cwd: string; env?: NodeJS.ProcessEnv }) {
  const log = join(o.cwd, "..", `${Date.now()}-launch.ndjson`);
  const cfg: EngineLaunchConfig = {
    engineId: "claude-code",
    cwd: o.cwd,
    stablePrompt: "",
    env: {},
    approvalMode: "default",
  };
  const saved = { ...process.env };
  // What the core's own environment may hold (a self-hosted relay's secret, the person's cloud keys).
  Object.assign(process.env, {
    HOME: o.home,
    ALCA_RELAY_SECRET: "relay-secret",
    AWS_SECRET_ACCESS_KEY: "aws",
  });
  cleanups.push(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const engine = new ClaudeCodeEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    launch: () => cfg,
    sessions: { get: () => undefined, set: () => undefined },
    baseEnv: { FAKE_CLAUDE_LOG: log, ...o.env },
    interruptGraceMs: 1000,
  });
  cleanups.push(() => engine.dispose());
  const launches = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Launch);
  return { engine, launches };
}

async function run(engine: ClaudeCodeEngine, text: string, asked: PermissionRequest[]) {
  const events: EngineEvent[] = [];
  for await (const e of engine.turn({
    threadId: "t",
    runId: "r",
    system: { stable: "", volatile: "" },
    userMessage: text,
    signal: new AbortController().signal,
    onPermission: async (p) => {
      asked.push(p);
      return { behavior: "deny", message: "no" };
    },
  }))
    events.push(e);
  return events;
}

/** The person's own Claude Code setup: allow-everything rules, a hook, their own MCP servers. */
function personalSetup(home: string, cwd: string) {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(git push:*)"] },
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "touch /tmp/pwned" }] }] },
    }),
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }),
  );
  // What a prompt-injected model writes into its own work folder under 自主.
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
  );
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "fs-mcp" } } }));
}

describe("S1: Claude Code ignores the person's settings, hooks and MCP servers", () => {
  it("launch arguments: no setting sources, strict MCP config, hooks off", () => {
    const args = buildClaudeArgs(
      { engineId: "claude-code", cwd: "/w", stablePrompt: "", env: {}, approvalMode: "default" },
      {},
    );
    const at = args.indexOf("--setting-sources");
    expect(at).toBeGreaterThan(0);
    expect(args[at + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(args[args.indexOf("--settings") + 1] as string)).toEqual({ disableAllHooks: true });
  });

  it("S2.1: the CLI's own Read / Edit of Alca's keys and database are denied by rule", () => {
    const args = buildClaudeArgs(
      { engineId: "claude-code", cwd: "/w", stablePrompt: "", env: {}, approvalMode: "default" },
      { protectedDataDir: "/Users/me/.alca" },
    );
    const s = JSON.parse(args[args.indexOf("--settings") + 1] as string) as {
      permissions: { deny: string[] };
    };
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(//Users/me/.alca/secrets.json)",
        "Edit(//Users/me/.alca/secrets.json)",
        "Read(//Users/me/.alca/state.sqlite*)",
        "Read(//Users/me/.alca/backups/**)",
      ]),
    );
    // never the bots' own folders (a bot's default work folder is <data>/bots/<id>/work)
    expect(s.permissions.deny.some((r) => r.includes("/bots"))).toBe(false);
  });

  it("a pre-allowed `git push` (user settings) and `Bash(*)` (the work folder's .claude/) still ask Alca", async () => {
    const root = tmp("alca-s1-");
    const home = join(root, "home");
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    personalSetup(home, cwd);
    const { engine, launches } = claude({ home, cwd });
    const asked: PermissionRequest[] = [];
    const ev = await run(engine, "[bash:git push origin main]", asked);
    // At b096d22 the fake (like the real CLI) ran this without calling the permission tool.
    expect(asked.map((a) => a.toolName)).toEqual(["Bash"]);
    expect(ev.some((e) => e.type === "tool.result" && e.ok)).toBe(false);
    const l = launches()[0] as Launch;
    expect(l.allowRules).toEqual([]);
    expect(l.userMcp).toEqual([]);
  });

  it("M6: the CLI does not see ALCA_* or unrelated cloud credentials, but keeps PATH / HOME / its own", async () => {
    const root = tmp("alca-m6-");
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const { engine, launches } = claude({ home: root, cwd, env: { ANTHROPIC_MODEL: "x" } });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await run(engine, "你好", []);
    const env = (launches()[0] as Launch).env;
    expect(env).not.toContain("ALCA_RELAY_SECRET");
    expect(env).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(env).toEqual(expect.arrayContaining(["PATH", "HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]));
  });
});

describe("engineEnv", () => {
  it("keeps the basics and the family's own variables; never ALCA_*", () => {
    const env = {
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C",
      ALCA_RELAY_SECRET: "s",
      ALCA_DATA_DIR: "/d",
      OPENAI_API_KEY: "o",
      ANTHROPIC_API_KEY: "a",
      GITHUB_TOKEN: "g",
      AWS_ACCESS_KEY_ID: "k",
      NODE_OPTIONS: "--require /tmp/x.js",
    };
    expect(Object.keys(engineEnv(env, "claude-code")).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "HOME",
      "LC_ALL",
      "PATH",
    ]);
    expect(Object.keys(engineEnv(env, "codex")).sort()).toEqual(["HOME", "LC_ALL", "OPENAI_API_KEY", "PATH"]);
    expect(Object.keys(engineEnv(env, "acp", ["GITHUB_TOKEN"]))).toContain("GITHUB_TOKEN");
    // Bedrock is the person's explicit choice for Claude Code: then (only then) AWS passes.
    expect(engineEnv({ ...env, CLAUDE_CODE_USE_BEDROCK: "1" }, "claude-code").AWS_ACCESS_KEY_ID).toBe("k");
  });
});

describe("S1: Codex runs with Alca's own CODEX_HOME", () => {
  it("the person's MCP servers are not loaded; their login and sessions are linked", async () => {
    const root = tmp("alca-codex-home-");
    const real = join(root, "real");
    mkdirSync(join(real, "sessions"), { recursive: true });
    writeFileSync(join(real, "auth.json"), '{"tokens":{}}');
    writeFileSync(
      join(real, "config.toml"),
      '[mcp_servers.github]\ncommand = "gh-mcp"\n\n[profiles.yolo]\napproval_policy = "never"\n',
    );
    const log = join(root, "codex.ndjson");
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = real;
    process.env.ALCA_RELAY_SECRET = "relay-secret";
    cleanups.push(() => {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      delete process.env.ALCA_RELAY_SECRET;
    });
    const home = join(root, "alca-home");
    const engine = new CodexEngine({
      command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CODEX_SCRIPT],
      launch: () => ({ engineId: "codex", cwd: root, stablePrompt: "", env: {}, approvalMode: "read-only" }),
      sessions: { get: () => undefined, set: () => undefined },
      baseEnv: { FAKE_CODEX_LOG: log },
      home,
    });
    cleanups.push(() => engine.dispose());
    for await (const _ of engine.turn({
      threadId: "t",
      runId: "r",
      system: { stable: "", volatile: "" },
      userMessage: "你好",
      signal: new AbortController().signal,
    }));
    const l = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0] as string) as {
      codexHome: string;
      configMcp: string[];
      env: string[];
    };
    // At b096d22 Codex read the real home: configMcp was ["github"].
    expect(l.codexHome).toBe(home);
    expect(l.configMcp).toEqual([]);
    expect(l.env).not.toContain("ALCA_RELAY_SECRET");
    expect(readlinkSync(join(home, "auth.json"))).toBe(join(real, "auth.json"));
    expect(lstatSync(join(home, "sessions")).isSymbolicLink()).toBe(true);
    expect(lstatSync(home).mode & 0o777).toBe(0o700);
  });

  it("prepareCodexHome rewrites Alca's config.toml every launch (a model cannot plant servers there)", () => {
    const root = tmp("alca-codex-prep-");
    const home = join(root, "h");
    prepareCodexHome(home, join(root, "none"));
    writeFileSync(join(home, "config.toml"), '[mcp_servers.evil]\ncommand = "x"\n');
    prepareCodexHome(home, join(root, "none"));
    expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain("mcp_servers");
  });
});

describe("mac test 2026-11-04b E1: the bridge token is never on a command line", () => {
  it("the CLI's argv names a 0600 file, not the token; the permission tool still reaches the host", async () => {
    const root = tmp("alca-bridge-argv-");
    const home = join(root, "home");
    const cwd = join(root, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const { engine, launches } = claude({ home, cwd });
    const asked: PermissionRequest[] = [];
    await run(engine, "[bash:git push]", asked);
    // The permission tool talked to the bridge (it needs the token to do that).
    expect(asked.map((a) => a.toolName)).toEqual(["Bash"]);
    const token = (engine as unknown as { bridge: { token: string } }).bridge.token;
    expect(token.length).toBeGreaterThan(16);
    const args = launches()[0]!.args;
    // At b034304 --mcp-config carried {"env":{"ALCA_BRIDGE_TOKEN":"<token>"}} (visible in `ps -ef`).
    expect(args.some((a) => a.includes(token))).toBe(false);
    expect(args.join(" ")).not.toContain("ALCA_BRIDGE_TOKEN");
    const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as {
      mcpServers: { alca: { env: Record<string, string> } };
    };
    const file = mcp.mcpServers.alca.env.ALCA_BRIDGE_FILE!;
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(token);
  }, 20_000);
});
