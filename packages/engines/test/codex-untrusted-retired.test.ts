import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerEngine,
  checkHarnessFit,
  type EngineEvent,
  type EngineTurnRequest,
  FAKE_CODEX_APP_SERVER_SCRIPT,
  isPolicyRejection,
  UNTRUSTED_RETIRED_NOTE,
} from "../src/index.ts";

// Codex retired approval_policy "untrusted" (openai/codex#39630; docs:
// developers.openai.com/codex/config-reference). Against the fake app-server
// that refuses it like a current CLI: the engine switches to on-request, the
// refused turn ends with a clear error (nothing ran), and Alca's own gate then
// refuses coding below 完全授權.

const engines: CodexAppServerEngine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const req = (text: string, o: Partial<EngineTurnRequest> = {}): EngineTurnRequest => ({
  threadId: "thr_A",
  runId: "run_1",
  sessionKey: "wkr_A",
  system: { stable: "你是 Alca 的工人。", volatile: "" },
  userMessage: text,
  signal: new AbortController().signal,
  ...o,
});

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function make(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "alca-cas-ret-"));
  dirs.push(dir);
  const store = new Map<string, string>();
  const e = new CodexAppServerEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CODEX_APP_SERVER_SCRIPT],
    launch: () => ({
      engineId: "codex",
      cwd: dir,
      stablePrompt: "穩定層",
      env: {},
      approvalMode: "workspace-write",
    }),
    sessions: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    sandbox: "workspace-write",
    home: false,
    baseEnv: env,
    setupTimeoutMs: 5000,
  });
  engines.push(e);
  return e;
}

describe("Codex app-server: the retired `untrusted` policy", () => {
  it("refused → clear error, nothing ran; the engine is on-request and coding is refused below 完全授權", async () => {
    const e = make({ FAKE_CODEX_AS_NO_UNTRUSTED: "1" });
    expect(checkHarnessFit(e, "coding")).toEqual({ ok: true });
    const asked: unknown[] = [];
    const out = await collect(
      e.turn(
        req("WRITE:a.txt=hello", {
          onPermission: async (p) => {
            asked.push(p);
            return { behavior: "allow" };
          },
        }),
      ),
    );
    const err = out.find((x) => x.type === "error");
    expect(err).toMatchObject({ code: "engine.codex_untrusted_retired", retryable: false });
    expect(err && "message" in err ? err.message : "").toContain("untrusted");
    expect(err && "message" in err ? err.message : "").toContain("這件 coding 工作沒有開始");
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "error" });
    expect(out.some((x) => x.type === "tool.call")).toBe(false);
    expect(asked).toEqual([]);
    expect(e.policyRetired).toBe(true);
    // Alca's gate: below 完全授權 coding is refused, with the reason; at 完全授權 it fits with a snapshot.
    const fit = checkHarnessFit(e, "coding");
    expect(fit.ok).toBe(false);
    expect(!fit.ok && fit.reason).toContain(UNTRUSTED_RETIRED_NOTE);
    expect(checkHarnessFit(e, "coding", undefined, { level: "full_access" })).toEqual({
      ok: true,
      snapshotEachTurn: true,
    });
  }, 20_000);

  it("the next turn runs on-request (a new process with the supported policy)", async () => {
    const e = make({ FAKE_CODEX_AS_NO_UNTRUSTED: "1" });
    await collect(e.turn(req("hi")));
    const out = await collect(e.turn(req("hi again")));
    expect(out.some((x) => x.type === "error")).toBe(false);
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
  }, 20_000);

  it("on-request refused too → a clear error naming the policy, not retryable", async () => {
    const e = make({ FAKE_CODEX_AS_NO_UNTRUSTED: "1", FAKE_CODEX_AS_NO_ON_REQUEST: "1" });
    await collect(e.turn(req("one")));
    const out = await collect(e.turn(req("two")));
    expect(out.find((x) => x.type === "error")).toMatchObject({
      code: "engine.codex_policy_rejected",
      retryable: false,
    });
  }, 20_000);

  it("an older CLI that still takes untrusted is unchanged", async () => {
    const e = make({});
    const out = await collect(e.turn(req("hi")));
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
    expect(e.policyRetired).toBe(false);
  }, 20_000);

  it("isPolicyRejection: the CLI's refusal wording, not any error", () => {
    expect(isPolicyRejection(new Error("unknown variant `untrusted`, expected one of `on-request`"))).toBe(
      true,
    );
    expect(isPolicyRejection(new Error("approval policy on-request is not allowed by requirements"))).toBe(
      true,
    );
    expect(isPolicyRejection(new Error("thread not loaded"))).toBe(false);
    // Review #11: "untrusted" alone is not a policy refusal.
    expect(isPolicyRejection(new Error("the project directory /x is untrusted; mark it trusted first"))).toBe(
      false,
    );
    expect(isPolicyRejection(new Error("refusing to run in an untrusted workspace"))).toBe(false);
    expect(isPolicyRejection(new Error('approval_policy = "untrusted" is no longer supported'))).toBe(true);
  });
});

describe("Codex app-server: the policy probe before any turn (item 5)", () => {
  it("a CLI that retired `untrusted` is found before the first turn; the coding fit already says why", async () => {
    const e = make({ FAKE_CODEX_AS_NO_UNTRUSTED: "1" });
    expect(checkHarnessFit(e, "coding")).toEqual({ ok: true });
    const probe = e.probePolicy();
    expect(e.probePolicy()).toBe(probe); // one probe per engine
    expect(await probe).toBe("retired");
    expect(e.policyRetired).toBe(true);
    expect(e.hasProcess("wkr_A")).toBe(false); // nothing kept running
    const fit = checkHarnessFit(e, "coding");
    expect(!fit.ok && fit.reason).toContain(UNTRUSTED_RETIRED_NOTE);
    // The first real turn goes straight to on-request: no refused turn at all.
    const out = await collect(e.turn(req("hi")));
    expect(out.some((x) => x.type === "error")).toBe(false);
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
    expect(await e.probePolicy()).toBe("retired");
  }, 20_000);

  it("review #12: the probe does not kill a process whose first turn is still setting up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-cas-ret-"));
    dirs.push(dir);
    const log = join(dir, "log.jsonl");
    const e = make({
      FAKE_CODEX_AS_NO_UNTRUSTED: "1",
      FAKE_CODEX_AS_SETUP_DELAY_MS: "1500",
      FAKE_CODEX_AS_LOG: log,
    });
    const turn = collect(e.turn(req("hi")));
    // Wait until the turn's thread/start is on the wire (its process is up, its sink not yet set).
    for (let i = 0; i < 200; i++) {
      const seen = (() => {
        try {
          return readFileSync(log, "utf8").includes('"thread/start"');
        } catch {
          return false;
        }
      })();
      if (seen) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(e.hasProcess("wkr_A")).toBe(true);
    expect(await e.probePolicy()).toBe("retired");
    expect(e.hasProcess("wkr_A")).toBe(true); // not killed mid-setup
    const out = await turn;
    const err = out.find((x) => x.type === "error");
    // The turn ends on the CLI's own refusal of the policy it sent (nothing ran), not as a crash.
    expect(err).toMatchObject({ code: "engine.codex_untrusted_retired" });
    // And the next turn runs on-request.
    const next = await collect(e.turn(req("again")));
    expect(next.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
  }, 30_000);

  it("a CLI that still takes `untrusted` is left as it is", async () => {
    const e = make({});
    expect(await e.probePolicy()).toBe("ok");
    expect(e.policyRetired).toBe(false);
    expect(checkHarnessFit(e, "coding")).toEqual({ ok: true });
  }, 20_000);

  it("no app-server: says nothing about the policy and changes nothing", async () => {
    const e = new CodexAppServerEngine({
      command: ["/nonexistent/codex"],
      launch: () => ({
        engineId: "codex",
        cwd: tmpdir(),
        stablePrompt: "",
        env: {},
        approvalMode: "workspace-write",
      }),
      sessions: { get: () => undefined, set: () => {} },
      sandbox: "workspace-write",
      home: false,
      setupTimeoutMs: 2000,
    });
    engines.push(e);
    expect(await e.probePolicy()).toBe("unavailable");
    expect(e.available).toBeUndefined();
    expect(e.policyRetired).toBe(false);
  }, 20_000);

  it("an engine that never sends `untrusted` (read-only, or on-request) is not probed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-cas-ret-"));
    dirs.push(dir);
    const ro = new CodexAppServerEngine({
      command: ["/nonexistent/codex"],
      launch: () => ({ engineId: "codex", cwd: dir, stablePrompt: "", env: {}, approvalMode: "read-only" }),
      sessions: { get: () => undefined, set: () => {} },
      sandbox: "read-only",
      home: false,
    });
    engines.push(ro);
    expect(await ro.probePolicy()).toBe("skipped");
    expect(ro.launches.size).toBe(0);
  });
});
