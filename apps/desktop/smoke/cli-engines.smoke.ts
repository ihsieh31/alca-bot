import { ClaudeCodeEngine, CodexEngine, type EngineLaunchConfig } from "@alca/engines";
import { afterAll, describe, expect, it } from "vitest";
import { env, firstError, oneTurn, tempDir } from "./helpers.ts";

const CLAUDE = env("ALCA_SMOKE_CLAUDE");
const CODEX = env("ALCA_SMOKE_CODEX");
const cmd = (v: string | undefined, dflt: string) => (v && v !== "1" ? v.split(/\s+/) : [dflt]);

function sessions() {
  const m = new Map<string, string>();
  return { map: m, mem: { get: (k: string) => m.get(k), set: (k: string, s: string) => void m.set(k, s) } };
}

describe.skipIf(!CLAUDE)("smoke × Claude Code CLI (your own login)", () => {
  const tmp = tempDir("alca-smoke-claude-");
  const s = sessions();
  const cfg: EngineLaunchConfig = {
    engineId: "claude-code",
    cwd: tmp.dir,
    stablePrompt: "You are a terse test assistant.",
    env: {},
    approvalMode: "default",
    ...(env("ALCA_SMOKE_CLAUDE_MODEL") ? { model: env("ALCA_SMOKE_CLAUDE_MODEL") as string } : {}),
  };
  const engine = new ClaudeCodeEngine({ command: cmd(CLAUDE, "claude"), launch: () => cfg, sessions: s.mem });
  afterAll(async () => {
    await engine.dispose();
    tmp.done();
  });

  it("streams a reply, records a session, and resumes after a restart", async () => {
    const a = await oneTurn(engine, "Reply with exactly the word: pong", { key: "cc" });
    expect(firstError(a.events)).toBeUndefined();
    expect(a.text.toLowerCase()).toContain("pong");
    expect(s.map.get("cc")).toBeTruthy();
    await engine.release("cc");
    const b = await oneTurn(engine, "What single word did you just reply with? Answer with that word only.", {
      key: "cc",
    });
    expect(b.text.toLowerCase()).toContain("pong");
  }, 240_000);
});

describe.skipIf(!CODEX)("smoke × Codex CLI (your own login)", () => {
  const tmp = tempDir("alca-smoke-codex-");
  const s = sessions();
  const cfg: EngineLaunchConfig = {
    engineId: "codex",
    cwd: tmp.dir,
    stablePrompt: "You are a terse test assistant.",
    env: {},
    approvalMode: "read-only",
    ...(env("ALCA_SMOKE_CODEX_MODEL") ? { model: env("ALCA_SMOKE_CODEX_MODEL") as string } : {}),
  };
  const engine = new CodexEngine({ command: cmd(CODEX, "codex"), launch: () => cfg, sessions: s.mem });
  afterAll(async () => {
    await engine.dispose();
    tmp.done();
  });

  it("answers through `codex exec --json`, records the session and resumes it", async () => {
    const a = await oneTurn(engine, "Reply with exactly the word: pong", { key: "cx" });
    expect(firstError(a.events)).toBeUndefined();
    expect(a.text.toLowerCase()).toContain("pong");
    expect(s.map.get("cx")).toBeTruthy();
    expect(a.events.some((e) => e.type === "usage")).toBe(true);
    const b = await oneTurn(engine, "What single word did you just reply with? Answer with that word only.", {
      key: "cx",
    });
    expect(b.text.toLowerCase()).toContain("pong");
  }, 240_000);
});
