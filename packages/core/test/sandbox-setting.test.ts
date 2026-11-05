import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  BotWorkDirs,
  buildConfineSpec,
  confineBox,
  DEFAULT_SANDBOX,
  loosens,
  mergeBotSandbox,
  parseBotSandbox,
  sandboxOn,
  UNSANDBOXED_REASON,
  WorkspaceGuards,
} from "../src/index.ts";

/** Next-round §5.4: the bot's sandbox setting, its levels, loosening, the spec and the guards' plan. */

const dirs: string[] = [];
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "alca-sbx-set-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the setting", () => {
  it("defaults to auto with the network open; unreadable input never widens", () => {
    expect(parseBotSandbox(null)).toEqual(DEFAULT_SANDBOX);
    expect(parseBotSandbox("{bad")).toEqual({ mode: "auto", network: "open" });
    expect(parseBotSandbox({ mode: "weird", network: "x", extraWritable: ["rel/path", "/abs", 3] })).toEqual({
      mode: "auto",
      network: "open",
      extraWritable: ["/abs"],
    });
  });

  it("auto is on at 自主 and 完全授權 only; on is on at every level; off never", () => {
    const auto = parseBotSandbox(null);
    expect(sandboxOn(auto, "autonomous")).toBe(true);
    expect(sandboxOn(auto, "full_access")).toBe(true);
    expect(sandboxOn(auto, "confirm_each_step")).toBe(false);
    expect(sandboxOn({ mode: "on", network: "open" }, "confirm_each_step")).toBe(true);
    expect(sandboxOn({ mode: "off", network: "open" }, "full_access")).toBe(false);
  });

  it("loosening: a weaker mode, opening the network, a new writable folder; tightening is not", () => {
    const base = { mode: "auto", network: "none" } as const;
    expect(loosens(base, { mode: "off", network: "none" })).toBeDefined();
    expect(loosens({ mode: "on", network: "none" }, base)).toBeDefined();
    expect(loosens(base, { mode: "auto", network: "open" })).toBeDefined();
    expect(loosens(base, { ...base, extraWritable: ["/x"] })).toContain("/x");
    expect(loosens(base, { mode: "on", network: "none" })).toBeUndefined();
    expect(loosens({ mode: "auto", network: "open" }, base)).toBeUndefined();
  });

  it("merge: validates, keeps the stored fields, stores null for the default", () => {
    expect(mergeBotSandbox(null, { mode: "on" })).toBe('{"mode":"on","network":"open"}');
    expect(mergeBotSandbox('{"mode":"on","network":"none"}', { mode: "auto", network: "open" })).toBeNull();
    expect(() => mergeBotSandbox(null, { mode: "maybe" })).toThrow();
    expect(() => mergeBotSandbox(null, { extraWritable: ["relative"] })).toThrow();
    expect(() => mergeBotSandbox(null, { extraWritable: ["/"] })).toThrow();
  });

  it("confineBox refuses only a required sandbox that is unavailable", () => {
    expect(confineBox({ state: "unavailable", required: true, reason: "x" }).refuse).toContain("要求沙箱");
    expect(confineBox({ state: "unavailable", reason: "x" })).toEqual({});
    expect(confineBox({ state: "off" })).toEqual({});
  });
});

describe("the spec", () => {
  it("work and temp folders reachable; data folder, other bots, config inside the folder covered", () => {
    const root = fresh();
    const data = join(root, "data");
    const work = join(data, "bots", "b1", "work");
    const other = join(root, "elsewhere-b2");
    for (const d of [work, other, join(data, "logs")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(data, "secrets.json"), "{}");
    const home = join(root, "home");
    mkdirSync(join(home, ".npm"), { recursive: true });
    const s = buildConfineSpec({
      kind: "bwrap",
      dataDir: data,
      botId: "b1",
      workDir: work,
      otherDirs: [other],
      sandbox: { mode: "auto", network: "open", extraWritable: [join(data, "logs"), "/srv/cache"] },
      home,
    });
    expect(s.workDir).toBe(work);
    expect(s.tmpDir).toBe(join(data, "tmp", "b1"));
    expect(s.denyRead).toEqual(
      expect.arrayContaining([join(data, "secrets.json"), join(data, "logs"), other]),
    );
    expect(s.denyRead).not.toContain(work);
    expect(s.denyRead).toContain(join(home, ".ssh"));
    expect(s.denyWriteInside).toEqual(
      expect.arrayContaining([join(work, ".git", "config"), join(work, ".claude")]),
    );
    // A writable folder inside the data folder is never granted.
    expect(s.extraWritable).toEqual([join(home, ".npm"), "/srv/cache"]);
  });
});

describe("the guards' plan", () => {
  const setup = (probe: ConstructorParameters<typeof WorkspaceGuards>[0]["confiner"]) => {
    const root = fresh();
    const store = openStore(":memory:");
    const workDirs = new BotWorkDirs({ dataDir: join(root, "data"), store, defaultDir: join(root, "w") });
    mkdirSync(join(root, "w"), { recursive: true });
    const guards = new WorkspaceGuards({ store, workDirs, ...(probe ? { confiner: probe } : {}) });
    const bot = store.bots.default();
    if (!bot) throw new Error("no bot");
    return { store, guards, bot };
  };

  it("off below 自主, on with a spec at 自主, the probe's kind", () => {
    const { guards, bot } = setup(() => ({ kind: "bwrap", ok: true }));
    expect(guards.confine(bot.id, "confirm_each_step").state).toBe("off");
    const p = guards.confine(bot.id, "autonomous");
    expect(p.state).toBe("bwrap");
    expect(p.spec?.network).toBe("open");
    expect(guards.confine(bot.id, "full_access", false)).toEqual({ state: "bwrap" });
  });

  it("unavailable: auto runs (not required), on is required; one audit row per bot", () => {
    const { store, guards, bot } = setup(() => ({ kind: "bwrap", ok: false, reason: "沒有 bwrap" }));
    expect(guards.confine(bot.id, "full_access")).toEqual({ state: "unavailable", reason: "沒有 bwrap" });
    store.bots.update(bot.id, { sandbox: '{"mode":"on","network":"open"}' });
    expect(guards.confine(bot.id, "confirm_each_step")).toMatchObject({
      state: "unavailable",
      required: true,
    });
    const rows = store.db.prepare("SELECT detail FROM audit_log WHERE action = 'sandbox.unavailable'").all();
    expect(rows).toHaveLength(1);
  });

  it("unsandboxed asks only when the sandbox is on, at every level", () => {
    const { store, guards, bot } = setup(() => ({ kind: "bwrap", ok: true }));
    const call = (level: "full_access" | "confirm_each_step", args: Record<string, unknown>) =>
      guards.folder({
        botId: bot.id,
        threadId: "t",
        runId: "r",
        tool: "bash",
        args,
        actionClass: "execute",
        level,
        signal: new AbortController().signal,
      });
    expect(call("full_access", { command: "ls", unsandboxed: true })).toBe(UNSANDBOXED_REASON);
    expect(call("full_access", { command: "ls" })).toBeUndefined();
    expect(call("confirm_each_step", { command: "ls", unsandboxed: true })).toBeUndefined();
    store.bots.update(bot.id, { sandbox: '{"mode":"off","network":"open"}' });
    expect(call("full_access", { command: "ls", unsandboxed: true })).toBeUndefined();
  });
});
