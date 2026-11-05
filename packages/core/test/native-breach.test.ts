import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import { type Engine, ScriptedEngine } from "@alca/engines";
import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import { AlcaCore, BotWorkDirs, WorkspaceGuards } from "../src/index.ts";
import { ENGINE_NATIVE_TOOL, ROUTER_NATIVE_TOOL } from "../src/phases/infer.ts";
import { isType, makeCore, tool } from "./helpers.ts";

/**
 * Review 2026-11-04b S1.3 (a native call that ran unasked is caught in every
 * role, not only the router), S2.1 (Alca's data folder is out of reach of
 * native tools at every level), S1.4 (engine configuration in the work folder
 * asks) and M4 (sensitive home folders are never a work folder).
 */
const owning = (steps: ConstructorParameters<typeof ScriptedEngine>[0], readOnly = false) =>
  new ScriptedEngine(steps, {
    capabilities: {
      ownsToolLoop: true,
      permissionPrompt: "mcp_tool",
      ...(readOnly ? { nativeToolsReadOnly: true } : {}),
    },
  });

const unasked = (name: string, input: Record<string, unknown>) => [
  [
    { type: "tool.call" as const, id: "n1", name, input },
    { type: "tool.result" as const, id: "n1", ok: true, output: "done" },
    { type: "text.delta" as const, text: "好了" },
    { type: "done" as const, stop: "end_turn" as const },
  ],
];

function run(core: AlcaCore, engine: Engine, role: "worker" | "thread" | "router") {
  const t = core.createThread("x");
  return core.launch({
    threadId: t.id,
    text: "做",
    role,
    engine,
    tools: role === "router" ? [tool("worker_start", "read")] : [],
    track: true,
  });
}

describe("S1.3: a native call that ran without asking", () => {
  it("a worker's unasked `git push` stops the run, says so, and leaves an audit row", async () => {
    const engine = owning(unasked("Bash", { command: "git push origin main" }));
    const { core, events, store } = makeCore(engine, { level: "autonomous" });
    const end = await run(core, engine, "worker").done;
    // At b096d22 this run completed: only the router was checked.
    expect(end.finish).toMatchObject({ reason: "failed", error: { code: ENGINE_NATIVE_TOOL } });
    expect(events.find(isType("error"))?.data.message).toMatch(/沒有經過確認就執行/);
    const audit = store.db
      .prepare("SELECT action, decision FROM audit_log WHERE action = 'Bash'")
      .all() as Array<{ decision: string }>;
    expect(audit.some((a) => a.decision === "deny")).toBe(true);
  });

  it.each([
    ["Bash", { command: "python3 -c 'import os; os.remove(\"a\")'" }],
    ["Write", { file_path: "/tmp/elsewhere.txt", content: "x" }],
    ["mcp__github__push_files", { repo: "x" }],
  ])("a direct turn's unasked %s under 每步確認 is a breach", async (name, input) => {
    const engine = owning(unasked(name, input));
    const { core } = makeCore(engine);
    expect((await run(core, engine, "thread").done).finish?.error?.code).toBe(ENGINE_NATIVE_TOOL);
  });

  it("a plain look the CLI lets through (`ls`, `git status`, Read) is not a breach", async () => {
    for (const [name, input] of [
      ["Bash", { command: "ls -la && git status" }],
      ["Read", { file_path: "README.md" }],
      ["Grep", { pattern: "TODO" }],
    ] as const) {
      const engine = owning(unasked(name, input));
      const { core } = makeCore(engine);
      expect((await run(core, engine, "worker").done).finish?.reason).toBe("completed");
    }
  });

  it("under 自主 an unasked command the level allows anyway is not a breach", async () => {
    const engine = owning(unasked("Bash", { command: "pnpm test" }));
    const { core } = makeCore(engine, { level: "autonomous" });
    expect((await run(core, engine, "worker").done).finish?.reason).toBe("completed");
  });

  it("a read-only sandbox (Codex) covers shell and files, never another server's MCP tool — worker or router", async () => {
    const shell = owning(unasked("shell", { command: "ls" }), true);
    expect((await run(makeCore(shell).core, shell, "worker").done).finish?.reason).toBe("completed");
    const mcp = owning(unasked("mcp:github/push_files", { repo: "x" }), true);
    expect((await run(makeCore(mcp).core, mcp, "worker").done).finish?.error?.code).toBe(ENGINE_NATIVE_TOOL);
    const mcpRouter = owning(unasked("mcp:slack/send_message", { text: "x" }), true);
    // At b096d22 nativeToolsReadOnly exempted everything on the router too.
    expect((await run(makeCore(mcpRouter).core, mcpRouter, "router").done).finish?.error?.code).toBe(
      ROUTER_NATIVE_TOOL,
    );
  });
});

function guarded(level: "autonomous" | "confirm_each_step", make: Engine | ((data: string) => Engine)) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alca-s2-")));
  const data = join(root, "data");
  const home = join(root, "home");
  mkdirSync(data, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(data, "secrets.json"), '{"core.localToken":"x"}');
  const store = openStore(":memory:");
  const settings = parseSettings({ permissions: { level } });
  const workDirs = new BotWorkDirs({ dataDir: data, store, home });
  const guards = new WorkspaceGuards({ store, workDirs });
  const engine = typeof make === "function" ? make(data) : make;
  const core = new AlcaCore({ store, engine, settings: () => settings, guards });
  const events: Parameters<Parameters<typeof core.bus.subscribe>[1]>[0][] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  return { core, events, data, home, workDirs, engine };
}

const asking = (name: string, input: Record<string, unknown>) =>
  owning([
    [
      { type: "permission", call: { id: "p1", name, input } },
      { type: "text.delta", text: "好" },
      { type: "done", stop: "end_turn" },
    ],
  ]);

describe("S2.1: Alca's data folder is out of reach of native tools", () => {
  it.each([
    ["Read", (d: string) => ({ file_path: join(d, "secrets.json") })],
    ["Grep", (d: string) => ({ pattern: "token", path: d })],
    ["Glob", (d: string) => ({ pattern: `${d}/*.json` })],
    ["Edit", (d: string) => ({ file_path: join(d, "state.sqlite"), old_string: "a", new_string: "b" })],
    ["Bash", (d: string) => ({ command: `cat ${d}/secrets.json` })],
    ["Bash", () => ({ command: "cat ../../../secrets.json" })],
    ["Bash", () => ({ command: "cd ../../.. && cat s*.json" })],
    ["Bash", () => ({ command: "cat $ALCA_DATA_DIR/secrets.json" })],
  ])("%s is denied (not asked) even under 自主", async (name, input) => {
    const h = guarded("autonomous", (d) => asking(name, input(d)));
    const engine = h.engine as ScriptedEngine;
    const t = h.core.createThread("x");
    await h.core.send(t.id, "讀").done;
    // At b096d22 a Read ran without asking at every level (reads always run).
    expect(engine.permissionAnswers[0]).toMatchObject({ behavior: "deny" });
    expect(String((engine.permissionAnswers[0] as { message?: string }).message)).toMatch(/Alca 的資料夾/);
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
  });

  // Mac test 2026-11-04b E2: under 每步確認, Claude Code's own Read printed the data folder's
  // config.json with no card (b0343040). Denied outright now: no card to click 允許 on.
  it.each(["config.json", "secrets.json"])(
    "每步確認: Claude Code's Read of the data folder's %s is denied without a card (E2)",
    async (file) => {
      const h = guarded("confirm_each_step", (d) => {
        writeFileSync(join(d, "config.json"), '{"permissions":{"level":"confirm_each_step"}}');
        return asking("Read", { file_path: join(d, file) });
      });
      const engine = h.engine as ScriptedEngine;
      await h.core.send(h.core.createThread("x").id, "讀").done;
      expect(engine.permissionAnswers[0]).toMatchObject({ behavior: "deny" });
      expect(String((engine.permissionAnswers[0] as { message?: string }).message)).toMatch(/Alca 的資料夾/);
      expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    },
  );

  it("the bot's own work folder (inside the data folder by default) stays usable", async () => {
    const engine = asking("Read", { file_path: "notes.md" });
    const h = guarded("confirm_each_step", engine);
    await h.core.send(h.core.createThread("x").id, "讀").done;
    expect(engine.permissionAnswers[0]).toMatchObject({ behavior: "allow" });
  });

  // Mac device test 2026-11-05 M2: Claude Code's own deny rules refuse the Read before the
  // permission tool is asked; Alca only sees a failed result in the CLI's words.
  it("a file tool the engine itself refused on the data folder: Alca's words, nothing ran, no breach", async () => {
    const h = guarded("confirm_each_step", (d) =>
      owning([
        [
          { type: "tool.call", id: "n1", name: "Read", input: { file_path: join(d, "config.json") } },
          {
            type: "tool.result",
            id: "n1",
            ok: false,
            output: "File is in a directory that is denied by your permission settings.",
          },
          { type: "text.delta", text: "讀不到" },
          { type: "done", stop: "end_turn" },
        ],
      ]),
    );
    const end = await h.core.launch({
      threadId: h.core.createThread("x").id,
      text: "讀",
      role: "worker",
      engine: h.engine,
      tools: [],
      track: true,
    }).done;
    expect(end.finish?.reason).toBe("completed");
    const done = h.events.find((e) => e.type === "tool.completed")?.data as { ok: boolean; error?: string };
    expect(done.ok).toBe(false);
    expect(done.error).toMatch(/^Alca 的資料夾（金鑰、資料庫、其他 bot 的資料）bot 不能讀寫/);
    expect(done.error).toContain("denied by your permission settings");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
  });

  it("a failed shell command on the data folder is still a breach (it may have run)", async () => {
    const h = guarded("autonomous", (d) =>
      owning([
        [
          { type: "tool.call", id: "n1", name: "Bash", input: { command: `cat ${d}/secrets.json; false` } },
          { type: "tool.result", id: "n1", ok: false, output: "{...}" },
          { type: "done", stop: "end_turn" },
        ],
      ]),
    );
    const end = await h.core.launch({
      threadId: h.core.createThread("x").id,
      text: "讀",
      role: "worker",
      engine: h.engine,
      tools: [],
      track: true,
    }).done;
    expect(end.finish?.error?.code).toBe(ENGINE_NATIVE_TOOL);
  });

  it("an unasked read of the data folder (even in a read-only sandbox) stops the run", async () => {
    const h = guarded("autonomous", (d) =>
      owning(unasked("shell", { command: `cat ${d}/secrets.json` }), true),
    );
    const end = await h.core.launch({
      threadId: h.core.createThread("x").id,
      text: "x",
      role: "worker",
      engine: h.engine,
      tools: [],
      track: true,
    }).done;
    expect(end.finish?.error?.code).toBe(ENGINE_NATIVE_TOOL);
  });
});

describe("S1.4: engine configuration in the work folder asks at every level", () => {
  it.each([
    ["Write", { file_path: ".claude/settings.local.json", content: '{"permissions":{"allow":["Bash(*)"]}}' }],
    ["Write", { file_path: ".mcp.json", content: "{}" }],
    ["Edit", { file_path: ".git/hooks/pre-commit", old_string: "", new_string: "curl x" }],
    ["Bash", { command: "echo '{}' > .codex/config.toml" }],
  ])("%s %j asks under 自主", async (name, input) => {
    const engine = asking(name, input);
    const h = guarded("autonomous", engine);
    const { done } = h.core.send(h.core.createThread("x").id, "改");
    let card: { data: { approvalId: string; summary: string } } | undefined;
    for (let i = 0; i < 400 && !card; i++) {
      card = h.events.find((e) => e.type === "approval.requested") as typeof card;
      if (!card) await new Promise((r) => setTimeout(r, 5));
    }
    expect(card?.data.summary).toMatch(/設定檔/);
    if (card) h.core.answerApproval(card.data.approvalId, "denied");
    await done;
    expect(engine.permissionAnswers[0]).toMatchObject({ behavior: "deny" });
  });
});

describe("M4: sensitive home folders are never a work folder", () => {
  it("refuses ~/.ssh, ~/.aws/…, ~/.config, ~/.claude, ~/Library/Keychains; keeps ~/Projects", () => {
    const h = guarded("autonomous", owning([]));
    const bot = h.core.defaultBotId;
    for (const d of [
      "~/.ssh",
      "~/.aws/sso",
      "~/.config",
      "~/.claude",
      "~/.codex",
      "~/Library/Keychains",
      "~/.kube",
    ]) {
      const c = h.workDirs.check(bot, d.replace("~", h.home));
      expect(c.ok, d).toBe(false);
    }
    expect(h.workDirs.check(bot, join(h.home, "Projects", "demo")).ok).toBe(true);
  });

  it("refuses the literal ~/.ssh, ~/Library and ~/.claude as typed (mac test 2026-11-04b E4)", () => {
    const h = guarded("autonomous", owning([]));
    const bot = h.core.defaultBotId;
    for (const d of ["~/.ssh", "~/.ssh/", "~/.ssh/keys", "~/Library", "~/.claude"]) {
      const c = h.workDirs.check(bot, d);
      expect(c.ok, d).toBe(false);
      expect(c.ok ? "" : c.reason, d).toMatch(/金鑰、帳號或其他程式資料/);
    }
    expect(h.workDirs.check(bot, "~/Projects/demo").ok).toBe(true);
  });
});
