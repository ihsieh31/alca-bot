// Mac test 2026-11-04b A9: under 自主, `printf 'hello\n' > /Users/me/x.txt` wrote outside the
// work folder without a card (file_write asked; the shell did not), and Alca's file tools took
// `~/x` as `<work>/~/x`.
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import { ScriptedEngine } from "@alca/engines";
import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import { AlcaCore, BotWorkDirs, WorkspaceGuards } from "../src/index.ts";
import { editTargets } from "../src/workspace/journal.ts";
import { shellWriteTargets } from "../src/workspace/shell-targets.ts";
import { confine } from "../src/workspace/workdir.ts";

const W = "/w/proj";
const H = "/home/me";
const paths = (c: string) => shellWriteTargets(c, W, H).map((t) => (t.unknown ? `?${t.path}` : t.path));

describe("shellWriteTargets", () => {
  it.each([
    ["printf 'hello\\n' > /Users/me/out.txt", ["/Users/me/out.txt"]],
    ["echo a>>~/x 2>/dev/null", ["/home/me/x"]],
    ["ls &>/tmp/l 2>&1", ["/tmp/l"]],
    ['cat a | tee -a "/tmp/my f" b', ["/tmp/my f", "/w/proj/b"]],
    ["cp -r src /opt/x && mv a.txt ~/b", ["/opt/x", "/home/me/b"]],
    ["cp -t /opt/d a b", ["/opt/d"]],
    ["cd .. && touch q", ["/w/q"]],
    ['echo $(cat x) > "$HOME/z"', ["/home/me/z"]],
    ["install -m 644 a /usr/local/bin/a", ["/usr/local/bin/a"]],
    ["curl -o /tmp/f https://example.com && wget -O ~/g https://example.com", ["/tmp/f", "/home/me/g"]],
    ["dd if=a of=/tmp/b", ["/tmp/b"]],
    ["echo hi >| /tmp/a", ["/tmp/a"]],
    ["sudo tee /etc/hosts", ["/etc/hosts"]],
    ["env FOO=1 touch ~/.zshrc", ["/home/me/.zshrc"]],
    ["sed -i 's/a/b/' ~/.bashrc", ["/home/me/.bashrc"]],
    ['echo x > "$OUT"', ["?$OUT"]],
    ["cd $X && echo x > f", ["?f"]],
    ["echo x > out/a.txt && mkdir -p build", ["/w/proj/out/a.txt", "/w/proj/build"]],
    ["ls -la ~/x && cat /etc/hosts && git status", []],
  ])("%s", (command, expected) => {
    expect(paths(command)).toEqual(expected);
  });
});

function guarded(level: "autonomous" | "confirm_each_step", name: string, input: Record<string, unknown>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alca-a9-")));
  const data = join(root, "data");
  const home = join(root, "home");
  const work = join(root, "work");
  for (const d of [data, home, work]) mkdirSync(d, { recursive: true });
  const store = openStore(":memory:");
  const settings = parseSettings({ permissions: { level } });
  const workDirs = new BotWorkDirs({ dataDir: data, store, home });
  const guards = new WorkspaceGuards({ store, workDirs });
  const engine = new ScriptedEngine(
    [
      [
        { type: "permission", call: { id: "p1", name, input } },
        { type: "done", stop: "end_turn" },
      ],
    ],
    { capabilities: { ownsToolLoop: true, permissionPrompt: "mcp_tool" } },
  );
  const core = new AlcaCore({ store, engine, settings: () => settings, guards });
  store.bots.update(core.defaultBotId, { workDir: work });
  const events: Parameters<Parameters<typeof core.bus.subscribe>[1]>[0][] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  return { core, events, engine, root, work, home };
}

async function cardOf(h: ReturnType<typeof guarded>) {
  const { done } = h.core.send(h.core.createThread("x").id, "做");
  let card: { data: { approvalId: string; summary: string } } | undefined;
  for (let i = 0; i < 400 && !card; i++) {
    card = h.events.find((e) => e.type === "approval.requested") as typeof card;
    if (!card) await new Promise((r) => setTimeout(r, 5));
  }
  if (card) h.core.answerApproval(card.data.approvalId, "denied");
  await done;
  return card;
}

describe("A9: a shell command that writes outside the work folder asks, even under 自主", () => {
  it("`printf … > /outside` under 自主 puts up a card that says 工作資料夾外", async () => {
    const outside = join(tmpdir(), "alca-a9-outside.txt");
    const h = guarded("autonomous", "Bash", { command: `printf 'hello\\n' > ${outside}` });
    const card = await cardOf(h);
    // At b034304 this ran without a card (the shell floor thinks printf is harmless).
    expect(card?.data.summary).toMatch(/工作資料夾外/);
    expect(card?.data.summary).toContain(outside);
    expect(h.engine.permissionAnswers[0]).toMatchObject({ behavior: "deny" });
  });

  it("the same inside the work folder runs without a card under 自主", async () => {
    const h = guarded("autonomous", "Bash", { command: "printf 'hello\\n' > note.txt" });
    expect(await cardOf(h)).toBeUndefined();
    expect(h.engine.permissionAnswers[0]).toMatchObject({ behavior: "allow" });
  });

  it("under 每步確認 a Bash card names the outside path it reads", async () => {
    const h = guarded("confirm_each_step", "Bash", { command: "ls -la ~/alca-outside.txt" });
    const card = await cardOf(h);
    expect(card?.data.summary).toMatch(/工作資料夾外的路徑（~\/alca-outside\.txt）/);
  });

  it("file_write ~/x is judged as the home folder (a card, then refused), never <work>/~/x", async () => {
    const h = guarded("autonomous", "file_write", { path: "~/alca-outside.txt", content: "x" });
    expect(editTargets("file_write", { path: "~/a.txt" }, h.work)[0]).not.toContain(join(h.work, "~"));
    const card = await cardOf(h);
    expect(card?.data.summary).toMatch(/工作資料夾外/);
    expect(existsSync(join(h.work, "~"))).toBe(false);
    expect(() => confine(h.work, "~/alca-outside.txt", h.home)).toThrow(
      new RegExp(`工作資料夾外面：~/alca-outside\\.txt（就是 ${h.home}/alca-outside\\.txt）`),
    );
    expect(confine(h.work, "notes/a.txt", h.home)).toBe(join(h.work, "notes", "a.txt"));
  });
});
