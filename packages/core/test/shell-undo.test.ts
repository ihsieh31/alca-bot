// Undo for files a shell command changes (mac test 2026-11-04 §7b: haiku
// edited note.txt with `printf 'changed' > note.txt` in Bash and 復原 never
// appeared). The work folder is read before a cleared shell call and compared
// after it reports back.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import { type Engine, type EngineEvent, ScriptedEngine } from "@alca/engines";
import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import {
  AlcaCore,
  BotWorkDirs,
  changesSince,
  EditJournal,
  preImage,
  type ShellSnapshotLimits,
  WorkspaceGuards,
} from "../src/index.ts";

function setup(o: { level?: "autonomous" | "confirm_each_step"; limits?: ShellSnapshotLimits } = {}) {
  const root = mkdtempSync(join(tmpdir(), "alca-shell-undo-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = openStore(":memory:");
  const settings = parseSettings({ permissions: { level: o.level ?? "autonomous" } });
  const workDirs = new BotWorkDirs({ dataDir: join(root, "data"), store, home });
  const journal = new EditJournal({ store, policy: () => settings.engineering.undo });
  const guards = new WorkspaceGuards({
    store,
    workDirs,
    journal,
    ...(o.limits ? { shellSnapshot: o.limits } : {}),
  });
  const bot = store.bots.ensureDefault().id;
  const dir = workDirs.resolve(bot);
  return { store, settings, journal, guards, dir };
}

/** A stand-in for a CLI whose Bash changes files: asks permission, then runs `effect` when allowed. */
function shellCli(command: string, effect: () => void): Engine {
  return {
    id: "fake-cli",
    capabilities: {
      ...new ScriptedEngine([]).capabilities,
      ownsToolLoop: true,
      permissionPrompt: "mcp_tool",
    },
    async *turn(req): AsyncIterable<EngineEvent> {
      const input = { command };
      yield { type: "tool.call", id: "b1", name: "Bash", input };
      const a = await req.onPermission?.({ toolName: "Bash", input, toolUseId: "b1" });
      if (a?.behavior === "allow") effect();
      yield { type: "tool.result", id: "b1", ok: a?.behavior === "allow", output: "" };
      yield { type: "done", stop: "end_turn" };
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  };
}

function coreWith(s: ReturnType<typeof setup>, engine: Engine) {
  return new AlcaCore({ store: s.store, engine, settings: () => s.settings, tools: [], guards: s.guards });
}

describe("P13 undo × shell commands", () => {
  it("a Bash edit, a new file and a deletion in the work folder are journaled and undone", async () => {
    const s = setup();
    writeFileSync(join(s.dir, "note.txt"), "original");
    writeFileSync(join(s.dir, "old.txt"), "keep me");
    mkdirSync(join(s.dir, "node_modules"));
    writeFileSync(join(s.dir, "node_modules", "dep.js"), "dep");
    const core = coreWith(
      s,
      shellCli("printf 'changed' > note.txt && touch new.txt && rm old.txt", () => {
        writeFileSync(join(s.dir, "note.txt"), "changed");
        writeFileSync(join(s.dir, "new.txt"), "");
        rmSync(join(s.dir, "old.txt"));
        writeFileSync(join(s.dir, "node_modules", "dep.js"), "dep2"); // not read, not kept
      }),
    );
    // `rm` is a delete: it asks even under 自主; the person allows it.
    core.bus.subscribe("*", (e) => {
      if (e.type === "approval.requested")
        queueMicrotask(() => core.answerApproval(e.data.approvalId, "approved"));
    });
    const t = core.createThread();
    await core.send(t.id, "改").done;
    const [turn] = s.journal.turns(t.id);
    expect(turn).toBeDefined();
    const files = s.journal.files(turn!.turnRunId);
    expect(files.map((f) => [f.path.slice(s.dir.length + 1), f.existed]).sort()).toEqual([
      ["new.txt", false],
      ["note.txt", true],
      ["old.txt", true],
    ]);
    expect(files.every((f) => f.tool === "Bash")).toBe(true);
    expect(s.journal.undo(t.id, turn!.turnRunId)).toMatchObject({ ok: true });
    expect(readFileSync(join(s.dir, "note.txt"), "utf8")).toBe("original");
    expect(readFileSync(join(s.dir, "old.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(s.dir, "new.txt"))).toBe(false);
    await core.close();
  });

  it("a refused command keeps nothing; a command that changed nothing keeps nothing", async () => {
    const s = setup({ level: "confirm_each_step" });
    writeFileSync(join(s.dir, "a.txt"), "a");
    const core = coreWith(
      s,
      shellCli("ls", () => undefined),
    );
    const t = core.createThread();
    const run = core.send(t.id, "看");
    await new Promise((r) => setTimeout(r, 50));
    const pending = s.store.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").all() as Array<{
      id: string;
    }>;
    for (const p of pending) core.answerApproval(p.id, "denied");
    await run.done;
    expect(s.journal.turns(t.id)).toEqual([]);
    await core.close();
  });

  it("a folder over the limits: what was read is still compared, and the turn says the rest is not kept", async () => {
    const s = setup({ limits: { maxFiles: 2, maxBytes: 1_000_000, maxFileBytes: 4 } });
    writeFileSync(join(s.dir, "a.txt"), "1");
    writeFileSync(join(s.dir, "b.txt"), "too big");
    writeFileSync(join(s.dir, "c.txt"), "unread");
    const core = coreWith(
      s,
      shellCli("sed -i s/1/2/ a.txt b.txt", () => {
        writeFileSync(join(s.dir, "a.txt"), "2");
        writeFileSync(join(s.dir, "b.txt"), "changed too");
      }),
    );
    const t = core.createThread();
    await core.send(t.id, "改").done;
    const [turn] = s.journal.turns(t.id);
    const files = s.journal.files(turn!.turnRunId);
    const by = Object.fromEntries(files.map((f) => [f.path.slice(s.dir.length + 1) || ".", f]));
    expect(by["a.txt"]?.skipped ?? null).toBeNull();
    expect(by["b.txt"]?.skipped).toContain("檔案太大");
    expect(by["."]?.skipped).toContain("工作資料夾太大");
    expect(s.journal.undo(t.id, turn!.turnRunId)).toMatchObject({ ok: true });
    expect(readFileSync(join(s.dir, "a.txt"), "utf8")).toBe("1");
    await core.close();
  });

  it("preImage / changesSince: touch is not a change, symlinks and .git are not followed", () => {
    const s = setup();
    writeFileSync(join(s.dir, "x"), "same");
    mkdirSync(join(s.dir, ".git"));
    writeFileSync(join(s.dir, ".git", "HEAD"), "ref");
    const pre = preImage(s.dir);
    expect([...pre.files.keys()].map((p) => p.slice(s.dir.length + 1))).toEqual(["x"]);
    writeFileSync(join(s.dir, "x"), "same"); // rewritten, same bytes
    writeFileSync(join(s.dir, ".git", "HEAD"), "other");
    expect(changesSince(pre)).toEqual([]);
  });
});
