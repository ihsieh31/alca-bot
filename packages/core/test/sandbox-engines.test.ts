import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfineSpec } from "@alca/os";
import { afterEach, describe, expect, it } from "vitest";
import { BotWorkDirs, WorkspaceGuards } from "../src/index.ts";
import { SANDBOX_REQUIRED } from "../src/phases/infer.ts";
import { type Harness, makeAgents, say } from "./agents-helpers.ts";

/**
 * Next round §5.5 on the core side: an engine that runs its own tools (a
 * CLI) gets the bot's sandbox spec with the turn (`EngineTurnRequest.confine`);
 * `mode: on` without a usable sandbox fails the turn before the engine is
 * called; `auto` without one runs as before (the person's decision).
 */

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(probe: { kind: "bwrap" | "none"; ok: boolean; reason?: string }, sandbox?: object) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alca-sbx-eng-")));
  dirs.push(root);
  const data = join(root, "data");
  const work = join(root, "work");
  for (const d of [data, work]) mkdirSync(d, { recursive: true });
  const seen: Array<ConfineSpec | undefined> = [];
  const x = makeAgents({
    router: ({ req }) => {
      seen.push(req.confine);
      return say("好");
    },
    worker: () => say("ok"),
    routerCapabilities: { capabilities: { ownsToolLoop: true } },
    level: "autonomous",
  });
  const bot = x.store.bots.default();
  if (!bot) throw new Error("no default bot");
  if (sandbox) x.store.bots.update(bot.id, { sandbox: JSON.stringify(sandbox) });
  x.core.useGuards(
    new WorkspaceGuards({
      store: x.store,
      workDirs: new BotWorkDirs({ dataDir: data, store: x.store, defaultDir: work }),
      confiner: () => probe,
    }),
  );
  h = x;
  return { x, seen, work, data };
}

describe("CLI engines get the sandbox with the turn (next round §5.5)", () => {
  it("at 自主 with a usable sandbox the engine is given the bot's spec", async () => {
    const { x, seen, work, data } = setup({ kind: "bwrap", ok: true });
    const t = x.core.createThread();
    await x.core.send(t.id, "嗨").done;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.kind).toBe("bwrap");
    expect(seen[0]?.workDir).toBe(work);
    expect(seen[0]?.denyRead.some((p) => p.startsWith(data))).toBe(true);
    expect(seen[0]?.network).toBe("open");
  });

  it("sandbox off: no spec, the launch is as before", async () => {
    const { x, seen } = setup({ kind: "bwrap", ok: true }, { mode: "off", network: "open" });
    const t = x.core.createThread();
    await x.core.send(t.id, "嗨").done;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === undefined)).toBe(true);
  });

  it("auto without a usable sandbox runs as before (no spec, no refusal)", async () => {
    const { x, seen } = setup({ kind: "none", ok: false, reason: "沒有 bwrap" });
    const t = x.core.createThread();
    const r = x.core.send(t.id, "嗨");
    await r.done;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeUndefined();
    expect(x.store.runs.get(r.runId)?.finishReason).toBe("completed");
  });

  it("mode on without a usable sandbox fails the turn; the engine is never called", async () => {
    const { x, seen } = setup(
      { kind: "none", ok: false, reason: "沒有 bwrap" },
      { mode: "on", network: "open" },
    );
    const t = x.core.createThread();
    const r = x.core.send(t.id, "嗨");
    await r.done;
    expect(seen).toEqual([]);
    expect(x.store.runs.get(r.runId)?.finishReason).toBe("failed");
    const err = x.events.find((e) => e.type === "error" && e.data.code === SANDBOX_REQUIRED);
    expect(JSON.stringify(err?.data)).toContain("要求沙箱");
  });
});
