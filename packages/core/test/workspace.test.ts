import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import {
  type Engine,
  type EngineEvent,
  type EngineTurnRequest,
  ScriptedEngine,
  streamText,
} from "@alca/engines";
import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import {
  AlcaCore,
  BotWorkDirs,
  confine,
  EditJournal,
  editTargets,
  fileTools,
  WorkspaceGuards,
} from "../src/index.ts";
import { isType, waitFor } from "./helpers.ts";

/**
 * A temp folder reached through a symlink, like macOS's /var/folders/… → /private/var/folders/…
 * (mac test 2026-11-04: expectations built from the unresolved path did not match).
 */
const tmp = () => {
  const base = mkdtempSync(join(tmpdir(), "alca-p13-"));
  mkdirSync(join(base, "real"));
  symlinkSync(join(base, "real"), join(base, "link"));
  return join(base, "link");
};

function setup(o: { level?: "autonomous" | "confirm_each_step"; keepTurns?: number } = {}) {
  const root = tmp();
  const data = join(root, "data");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = openStore(":memory:");
  const settings = parseSettings({
    permissions: { level: o.level ?? "autonomous" },
    engineering: { undo: { keepTurns: o.keepTurns ?? 20 } },
  });
  const workDirs = new BotWorkDirs({ dataDir: data, store, home });
  const journal = new EditJournal({ store, policy: () => settings.engineering.undo });
  const guards = new WorkspaceGuards({ store, workDirs, journal });
  return { root, data, home, store, settings, workDirs, journal, guards };
}

function coreWith(s: ReturnType<typeof setup>, engine: Engine) {
  const core = new AlcaCore({
    store: s.store,
    engine,
    settings: () => s.settings,
    tools: fileTools((b) => s.workDirs.resolve(b)),
    guards: s.guards,
  });
  const events: Parameters<Parameters<typeof core.bus.subscribe>[1]>[0][] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  return { core, events };
}

/** A stand-in for a CLI that edits files itself: asks permission, then writes when allowed. */
function editingCli(edits: (req: EngineTurnRequest) => Array<{ path: string; content: string }>): Engine & {
  cwds: (string | undefined)[];
} {
  const cwds: (string | undefined)[] = [];
  return {
    id: "fake-cli",
    cwds,
    capabilities: {
      ...new ScriptedEngine([]).capabilities,
      ownsToolLoop: true,
      permissionPrompt: "mcp_tool",
    },
    async *turn(req): AsyncIterable<EngineEvent> {
      cwds.push(req.cwd);
      for (const [i, e] of edits(req).entries()) {
        const id = `tu${i}`;
        const input = { file_path: e.path, content: e.content };
        yield { type: "tool.call", id, name: "Write", input };
        const a = await req.onPermission?.({ toolName: "Write", input, toolUseId: id });
        if (a?.behavior === "allow") writeFileSync(e.path, e.content);
        yield { type: "tool.result", id, ok: a?.behavior === "allow", output: a?.behavior ?? "deny" };
      }
      for (const s of streamText("好了")) if (s.type !== "wait" && s.type !== "permission") yield s;
      yield { type: "done", stop: "end_turn" };
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  };
}

describe("P13 per-bot working folder", () => {
  it("defaults to <data>/bots/<id>/work, created 0700, and engines start there", async () => {
    const s = setup();
    const bot = s.store.bots.ensureDefault().id;
    const dir = s.workDirs.resolve(bot);
    expect(dir.endsWith(join("bots", bot, "work"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
    const engine = editingCli(() => []);
    const { core } = coreWith(s, engine);
    const t = core.createThread();
    await core.send(t.id, "hi").done;
    expect(engine.cwds).toEqual([dir]);
  });

  it("checks a person's folder: absolute, no root / home / system / Alca data, symlinks resolved", () => {
    const s = setup();
    const bot = s.store.bots.ensureDefault().id;
    const ok = join(s.home, "proj");
    expect(s.workDirs.check(bot, ok)).toMatchObject({ ok: true });
    expect(s.workDirs.check(bot, "relative/dir")).toMatchObject({ ok: false });
    expect(s.workDirs.check(bot, "/")).toMatchObject({ ok: false });
    expect(s.workDirs.check(bot, s.home)).toMatchObject({ ok: false });
    expect(s.workDirs.check(bot, "/etc/alca")).toMatchObject({ ok: false });
    expect(s.workDirs.check(bot, join(s.data, "vault"))).toMatchObject({ ok: false });
    expect(s.workDirs.check(bot, s.root)).toMatchObject({ ok: false }); // contains the data folder
    expect(s.workDirs.check(bot, join(s.data, "bots", bot, "other"))).toMatchObject({ ok: true });
    expect(s.workDirs.check(bot, join(s.data, "bots", "bot_someoneelse", "work"))).toMatchObject({
      ok: false,
    });
    mkdirSync(s.data, { recursive: true });
    const link = join(s.home, "sneaky");
    symlinkSync(s.data, link);
    expect(s.workDirs.check(bot, join(link, "x"))).toMatchObject({ ok: false });
    // A bad setting is never used: the default folder, and problem() says why.
    s.store.bots.update(bot, { workDir: join(link, "x") });
    expect(s.workDirs.resolve(bot)).toBe(s.workDirs.defaultFor(bot));
    expect(s.workDirs.problem(bot)).toBeTruthy();
    s.store.bots.update(bot, { workDir: ok });
    // The folder as it really is (macOS: /private/var/…, not /var/…).
    expect(s.workDirs.resolve(bot)).toBe(join(realpathSync(s.root), "home", "proj"));
    expect(s.workDirs.problem(bot)).toBeUndefined();
  });

  it("the temp folder is not a system folder, even where it lives under one (macOS /private/var/folders)", () => {
    // mac test 2026-11-04: tmpdir() is /var/folders/… → /private/var/folders/…, and /var and /private
    // are system folders, so a data folder (or a --data-dir /tmp/x) there could not hold a bot's folder.
    const store = openStore(":memory:");
    const temp = mkdtempSync("/var/tmp/alca-p13-sys-");
    try {
      const data = join(temp, "data");
      const workDirs = new BotWorkDirs({ dataDir: data, store, home: join(temp, "home"), tempDir: temp });
      const bot = store.bots.ensureDefault().id;
      expect(workDirs.check(bot, join(data, "bots", bot, "work"))).toMatchObject({ ok: true });
      expect(workDirs.check(bot, join(temp, "elsewhere"))).toMatchObject({ ok: true });
      // The rest of the system folder is still refused.
      expect(workDirs.check(bot, "/var/lib/alca")).toMatchObject({
        ok: false,
        reason: "不能用系統資料夾（/var）",
      });
      const plain = new BotWorkDirs({
        dataDir: data,
        store,
        home: join(temp, "home"),
        tempDir: "/nonexistent-tmp",
      });
      expect(plain.check(bot, join(temp, "elsewhere"))).toMatchObject({ ok: false });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("our file tools never leave the folder (.. and symlinks refused)", () => {
    const s = setup();
    const root = s.workDirs.resolve(s.store.bots.ensureDefault().id);
    expect(confine(root, "a/b.txt")).toBe(join(root, "a", "b.txt"));
    expect(() => confine(root, "../escape.txt")).toThrow();
    expect(() => confine(root, "/etc/passwd")).toThrow();
    symlinkSync(s.home, join(root, "out"));
    expect(() => confine(root, "out/file.txt")).toThrow();
  });
});

describe("P13 undo for files bots edit", () => {
  it("snapshots a CLI's Write before it runs; undo puts the old content back and removes new files", async () => {
    const s = setup();
    const bot = s.store.bots.ensureDefault().id;
    const dir = s.workDirs.resolve(bot);
    writeFileSync(join(dir, "a.txt"), "old");
    const engine = editingCli(() => [
      { path: join(dir, "a.txt"), content: "new" },
      { path: join(dir, "b.txt"), content: "brand new" },
      { path: join(dir, "a.txt"), content: "newer" },
    ]);
    const { core } = coreWith(s, engine);
    const t = core.createThread();
    const { runId, done } = core.send(t.id, "改檔案");
    await done;
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("newer");
    const turns = s.journal.turns(t.id);
    expect(turns).toEqual([expect.objectContaining({ turnRunId: runId, files: 2, undone: false })]);
    const r = s.journal.undo(t.id, runId);
    expect(r).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("old");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(s.journal.undo(t.id, runId)).toMatchObject({ ok: false });
  });

  it("our own file tools: newest turn first, a later edit blocks undoing an older turn", async () => {
    const s = setup();
    const bot = s.store.bots.ensureDefault().id;
    const dir = s.workDirs.resolve(bot);
    let n = 0;
    const engine = new ScriptedEngine(({ pass }) => {
      if (pass > 0) return streamText("寫好了");
      n++;
      return [
        {
          type: "tool.call",
          id: `c${n}`,
          name: "file_write",
          input: { path: "notes/x.md", content: `v${n}` },
        },
        { type: "done", stop: "tool_use" },
      ];
    });
    const { core } = coreWith(s, engine);
    const t = core.createThread();
    const first = core.send(t.id, "一");
    await first.done;
    const second = core.send(t.id, "二");
    await second.done;
    expect(readFileSync(join(dir, "notes/x.md"), "utf8")).toBe("v2");
    expect(s.journal.undo(t.id, first.runId)).toMatchObject({ ok: false, paths: [join(dir, "notes/x.md")] });
    expect(s.journal.undo(t.id, second.runId)).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, "notes/x.md"), "utf8")).toBe("v1");
    expect(s.journal.undo(t.id, first.runId)).toMatchObject({ ok: true });
    expect(existsSync(join(dir, "notes/x.md"))).toBe(false);
  });

  it("editTargets reads Claude Code, ACP and our own tools; relative paths start in the folder", () => {
    expect(editTargets("Edit", { file_path: "/w/a.ts" }, "/w")).toEqual(["/w/a.ts"]);
    expect(editTargets("NotebookEdit", { notebook_path: "n.ipynb" }, "/w")).toEqual(["/w/n.ipynb"]);
    expect(editTargets("Apply patch", { kind: "edit", paths: ["/w/x", "y"] }, "/w")).toEqual([
      "/w/x",
      "/w/y",
    ]);
    expect(editTargets("mv", { kind: "move", source: "/w/a", destination: "/w/b" }, "/w").sort()).toEqual([
      "/w/a",
      "/w/b",
    ]);
    expect(editTargets("file_edit", { path: "z.md" }, "/w")).toEqual(["/w/z.md"]);
    expect(editTargets("Bash", { command: "echo > a" }, "/w")).toEqual([]);
    expect(editTargets("Read", { file_path: "/w/a" }, "/w")).toEqual([]);
  });

  it("retention: a turn beyond keepTurns can no longer be undone", async () => {
    const s = setup({ keepTurns: 1 });
    const engine = new ScriptedEngine(({ pass, turnIndex }) =>
      pass > 0
        ? streamText("好")
        : [
            {
              type: "tool.call",
              id: `c${turnIndex}`,
              name: "file_write",
              input: { path: `f${turnIndex}`, content: "x" },
            },
            { type: "done", stop: "tool_use" },
          ],
    );
    const { core } = coreWith(s, engine);
    const t = core.createThread();
    const a = core.send(t.id, "a");
    await a.done;
    await core.send(t.id, "b").done;
    expect(s.journal.undo(t.id, a.runId)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("保留上限"),
    });
  });

  it("an edit outside the bot's folder asks first, even under 自主", async () => {
    const s = setup();
    const outside = join(s.home, "elsewhere.txt");
    const engine = editingCli(() => [{ path: outside, content: "x" }]);
    const { core, events } = coreWith(s, engine);
    const t = core.createThread();
    const { done } = core.send(t.id, "改外面的檔案");
    const card = await waitFor(events, isType("approval.requested"));
    expect(card.data.summary).toContain("工作資料夾外");
    expect(card.data.summary).toContain(outside);
    core.answerApproval(card.data.approvalId, "denied");
    await done;
    expect(existsSync(outside)).toBe(false);
  });

  it("under 每步確認 the card for an edit outside the folder names it and its path (mac test #6)", async () => {
    // mac test 2026-11-04: the card only said 「Write」 — the folder check ran only for calls the level allowed.
    const s = setup({ level: "confirm_each_step" });
    const outside = join(s.home, "alca-outside-test.txt");
    const engine = editingCli(() => [{ path: outside, content: "x" }]);
    const { core, events } = coreWith(s, engine);
    const t = core.createThread();
    const { done } = core.send(t.id, "改外面的檔案");
    const card = await waitFor(events, isType("approval.requested"));
    expect(card.data.summary).toContain("工作資料夾外");
    expect(card.data.summary).toContain(outside);
    core.answerApproval(card.data.approvalId, "denied");
    await done;
    expect(existsSync(outside)).toBe(false);
    // Inside the folder under 每步確認: a plain card, no outside wording.
    const inside = join(s.workDirs.resolve(s.store.bots.ensureDefault().id), "in.txt");
    const e2 = editingCli(() => [{ path: inside, content: "y" }]);
    const c2 = coreWith(s, e2);
    const t2 = c2.core.createThread();
    const r2 = c2.core.send(t2.id, "改裡面的檔案");
    const card2 = await waitFor(c2.events, isType("approval.requested"));
    expect(card2.data.summary ?? "").not.toContain("工作資料夾外");
    c2.core.answerApproval(card2.data.approvalId, "denied");
    await r2.done;
  });
});
