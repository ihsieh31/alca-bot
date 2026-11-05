import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import {
  AcpEngine,
  ClaudeCodeEngine,
  type Engine,
  type EngineTurnRequest,
  FAKE_ACP_SCRIPT,
  FAKE_CLAUDE_SCRIPT,
  FAKE_CODEX_APP_SERVER_SCRIPT,
  GENERAL_DENIED_ACP_KINDS,
  HARNESS_MATRIX,
  type ScriptContext,
  ScriptedEngine,
} from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { openStore, type WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSystem,
  AlcaCore,
  BotWorkDirs,
  claudeAgentEngines,
  codexAgentEngines,
  DEFAULT_PROFILE,
  EditJournal,
  routerProfile,
  WorkspaceGuards,
  workerProfile,
} from "../src/index.ts";
import { call, lastLine, say, until } from "./agents-helpers.ts";

/**
 * Plan §3.5 (Phase 2 acceptance): the formal path — router → WorkerSupervisor
 * → HarnessRun → a CLI engine — with each external engine's fake CLI (Claude
 * Code, Codex app-server, an ACP agent). Fictional tasks and data only; no
 * real CLI is started.
 *
 * - coding: a native file write puts an approval card up; approved, it is
 *   written and an undo snapshot is left.
 * - general: no native write or shell (removed, refused or read-only).
 * - an engine that cannot do the harness: the dispatch is refused, no worker.
 * - after the CLI's turn, the host's check runs (red and green).
 */

type Family = "claude" | "codex" | "acp";
const FAMILIES: Family[] = ["claude", "codex", "acp"];
const node = (script: string) => [process.execPath, "--disable-warning=ExperimentalWarning", script];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

/** How each family's fake CLI is told to write a file / run a command in a worker's goal. */
const WRITE: Record<Family, (name: string, text: string) => string> = {
  claude: (n, t) => `[write:${n}|${t}]`,
  codex: (n, t) => `WRITE:${n}=${t}`,
  acp: (n, t) => `WRITEFILE:${n}=${t}`,
};
const RUN: Record<Family, (cmd: string) => string> = {
  claude: (c) => `[bash:${c}]`,
  codex: (c) => `RUN:${c}`,
  acp: (c) => `RUNCMD:${c}`,
};

interface Engines {
  coding: Engine;
  general: Engine;
  /** The same family launched so that a native write or command may run unasked. */
  unfit: Engine;
}

/** The engines a family's bot would get, as the desktop wires them (plan §3.2–§3.4). */
function enginesFor(family: Family, work: string, store: ReturnType<typeof openStore>, log: string): Engines {
  const profiles = {
    routerProfile: routerProfile(DEFAULT_PROFILE),
    workerProfile: workerProfile(DEFAULT_PROFILE),
    workerToolNames: [] as string[],
  };
  if (family === "claude") {
    const e = claudeAgentEngines({
      command: node(FAKE_CLAUDE_SCRIPT),
      cwd: work,
      store,
      ...profiles,
      baseEnv: { FAKE_CLAUDE_LOG: log },
    });
    const sessions = new Map<string, string>();
    // A Claude launch that pre-approves edits (`--permission-mode acceptEdits`) declares so.
    const unfit = new ClaudeCodeEngine({
      command: node(FAKE_CLAUDE_SCRIPT),
      launch: () => ({
        engineId: "claude-code",
        cwd: work,
        stablePrompt: "",
        env: {},
        approvalMode: "default",
        extraArgs: ["--permission-mode", "acceptEdits"],
      }),
      sessions: { get: (k) => sessions.get(k), set: (k, v) => void sessions.set(k, v) },
      harness: { ...HARNESS_MATRIX.claudeCoding, asksBeforeWrite: "some" },
    });
    cleanups.push(() =>
      Promise.all([e.router, e.worker, unfit].map((x) => x.dispose())).then(() => undefined),
    );
    return { coding: e.coding, general: e.general, unfit };
  }
  if (family === "codex") {
    const common = {
      command: node(FAKE_CODEX_APP_SERVER_SCRIPT),
      cwd: work,
      store,
      ...profiles,
      home: join(work, "..", "codex-home"),
      baseEnv: { FAKE_CODEX_AS_LOG: log },
    };
    const e = codexAgentEngines(common);
    // `on-request` would run in-sandbox commands and in-root patches unasked: unfit for coding.
    const unfit = codexAgentEngines({ ...common, codingApprovalPolicy: "on-request" }).coding;
    cleanups.push(() =>
      Promise.all([e.router, e.worker, e.coding, e.general, unfit].map((x) => x.dispose())).then(
        () => undefined,
      ),
    );
    return { coding: e.coding, general: e.general, unfit };
  }
  const acp = (o: Partial<ConstructorParameters<typeof AcpEngine>[0]>, level = "confirm_each_step") => {
    const sessions = new Map<string, string>();
    return new AcpEngine({
      id: "fake-acp",
      command: node(FAKE_ACP_SCRIPT),
      launch: () => ({ engineId: "fake-acp", cwd: work, stablePrompt: "", env: {}, approvalMode: level }),
      sessions: { get: (k) => sessions.get(k), set: (k, v) => void sessions.set(k, v) },
      modes: { confirm_each_step: ["default"], autonomous: ["auto_edit"] },
      baseEnv: { FAKE_ACP_LOG: log },
      ...o,
    });
  };
  // As `createAcpEngine` builds them for each harness (providers/factory.ts).
  const coding = acp({ askingMode: true, harness: HARNESS_MATRIX.acpCoding });
  const general = acp({
    denyKinds: GENERAL_DENIED_ACP_KINDS,
    strictMode: true,
    harness: HARNESS_MATRIX.acpGeneral,
  });
  const unfit = acp({ harness: HARNESS_MATRIX.acpAtLevel }, "autonomous");
  cleanups.push(() => Promise.all([coding, general, unfit].map((x) => x.dispose())).then(() => undefined));
  return { coding, general, unfit };
}

/** The router dispatches the person's last line to `harness`; a report gets a short answer. */
const routerFor =
  (args: Record<string, unknown>) =>
  ({ req, pass }: ScriptContext) => {
    if (req.userMessage.includes("<alca:worker")) return say("收到回報");
    return pass === 0
      ? call("s", "worker_start", { title: "工作", goal: lastLine(req.userMessage), ...args })
      : say("派了");
  };

function rig(
  family: Family,
  o: {
    harness: "coding" | "general";
    level: "autonomous" | "confirm_each_step";
    unfit?: boolean;
    checks?: string[];
    /** Note the host tools offered to the coding engine on each turn. */
    seen?: string[][];
  },
) {
  const root = tmp("alca-he-");
  const work = join(root, "work");
  const data = join(root, "data");
  const home = join(root, "home");
  for (const d of [work, data, home]) mkdirSync(d, { recursive: true });
  const log = join(root, "cli.ndjson");
  const store = openStore(":memory:");
  const settings = parseSettings({
    permissions: { level: o.level },
    engineering: { workers: { watchdogSec: 3600 }, routines: { startDelaySec: 0 } },
  });
  const engines = enginesFor(family, work, store, log);
  const workDirs = new BotWorkDirs({ dataDir: data, store, home, defaultDir: work });
  const journal = new EditJournal({ store, policy: () => settings.engineering.undo });
  const guards = new WorkspaceGuards({ store, workDirs, journal });
  const router = new ScriptedEngine(
    routerFor({ harness: o.harness, ...(o.checks ? { checks: o.checks } : {}) }),
    { id: "router" },
  );
  const core = new AlcaCore({ store, engine: router, settings: () => settings, guards });
  const agents = new AgentSystem({
    core,
    routerEngine: router,
    workerHarnessEngines: {
      coding: o.unfit ? engines.unfit : o.seen ? recordTools(engines.coding, o.seen) : engines.coding,
      general: engines.general,
    },
    settings: () => settings,
    tickMs: 0,
    workDir: (botId) => guards.workDir(botId),
  });
  const events: AlcaEvent[] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  cleanups.push(async () => {
    await agents.close();
    await core.close();
  });
  const send = async (text: string) => {
    const t = core.createThread();
    await core.send(t.id, text).done;
    return t.id;
  };
  const cliLog = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { core, agents, store, events, work, send, cliLog };
}

type Rig = ReturnType<typeof rig>;

/** Alca's own coding tools (plan §4): only an engine whose tool loop is Alca's gets them. */
const CODING_TOOL_NAMES = [
  "read",
  "edit",
  "write",
  "apply_patch",
  "grep",
  "glob",
  "bash",
  "bash_poll",
  "bash_input",
  "bash_kill",
  "todo",
];

/** The same engine, noting the host tool names each turn offers it. */
function recordTools(e: Engine, seen: string[][]): Engine {
  return new Proxy(e, {
    get(target, prop) {
      if (prop === "turn")
        return (req: EngineTurnRequest) => {
          seen.push((req.tools ?? []).map((t) => t.name));
          return target.turn(req);
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const settled = (r: Rig, threadId: string) =>
  until(() => {
    const w = r.store.workers.byThread(threadId)[0];
    return w &&
      w.status !== "running" &&
      w.status !== "queued" &&
      r.store.dispatches.get(w.grants.dispatchId ?? "")?.status === "settled"
      ? w
      : undefined;
  }, 45_000);

const dispatchOf = (r: Rig, w: WorkerRecord) => r.store.dispatches.get(w.grants.dispatchId ?? "");

const approvals = (r: Rig) =>
  r.events.filter(
    (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
  );

describe.each(FAMILIES)("plan §3.5 on the formal path × %s (fake CLI)", (family) => {
  it("coding: a native write puts a card up; approved → written, with an undo snapshot", async () => {
    const r = rig(family, { harness: "coding", level: "confirm_each_step" });
    const threadId = await r.send(`改檔 ${WRITE[family]("note.txt", "hello")}`);
    const card = await until(() => approvals(r)[0], 20_000);
    const w = r.store.workers.byThread(threadId)[0] as WorkerRecord;
    expect(card.data).toMatchObject({ workerId: w.id });
    expect(existsSync(join(r.work, "note.txt"))).toBe(false);
    r.core.answerApproval(card.data.approvalId, "approved");
    await until(() => existsSync(join(r.work, "note.txt")), 20_000);
    expect(readFileSync(join(r.work, "note.txt"), "utf8")).toBe("hello");
    // The snapshot was taken before the write ran: the file did not exist yet.
    const snaps = await until(() => {
      const turns = r.store.snapshots.turns(threadId);
      const s = turns.flatMap((t) => r.store.snapshots.ofTurn(t.turnRunId));
      return s.length ? s : undefined;
    }, 20_000);
    expect(snaps[0]).toMatchObject({ path: join(r.work, "note.txt"), existed: false, workerId: w.id });
    await settled(r, threadId);
  }, 60_000);

  it("coding: a denied write leaves nothing behind", async () => {
    const r = rig(family, { harness: "coding", level: "confirm_each_step" });
    const threadId = await r.send(`改檔 ${WRITE[family]("no.txt", "x")}`);
    const card = await until(() => approvals(r)[0], 20_000);
    r.core.answerApproval(card.data.approvalId, "denied");
    await settled(r, threadId);
    expect(existsSync(join(r.work, "no.txt"))).toBe(false);
    expect(r.store.snapshots.turns(threadId)).toEqual([]);
  }, 60_000);

  it("coding: the CLI keeps its own tools — Alca's coding tools are not offered to it", async () => {
    const seen: string[][] = [];
    const r = rig(family, { harness: "coding", level: "autonomous", seen });
    const threadId = await r.send(`改檔 ${WRITE[family]("own.txt", "mine")}`);
    await settled(r, threadId);
    expect(seen.length).toBeGreaterThan(0);
    const offered = new Set(seen.flat());
    for (const name of CODING_TOOL_NAMES) expect(offered.has(name)).toBe(false);
    expect(readFileSync(join(r.work, "own.txt"), "utf8")).toBe("mine");
  }, 60_000);

  it("general: no native write and no shell — nothing asks, nothing is written", async () => {
    const r = rig(family, { harness: "general", level: "autonomous" });
    for (const goal of [WRITE[family]("g.txt", "x"), RUN[family]("touch g2.txt")]) {
      const threadId = await r.send(`做 ${goal}`);
      const w = await settled(r, threadId);
      expect(w.grants.harness).toBe("general");
      type Acts = { actions: { toolCalls: number; okToolCalls: number } };
      const acts = (dispatchOf(r, w)?.report as Acts | undefined)?.actions ?? {
        toolCalls: -1,
        okToolCalls: -1,
      };
      // Claude: the tool is not there at all; Codex: the read-only sandbox fails it; ACP: refused unasked.
      expect(acts.okToolCalls).toBe(0);
      expect(acts.toolCalls).toBe(family === "claude" ? 0 : 1);
    }
    expect(approvals(r)).toEqual([]);
    expect(existsSync(join(r.work, "g.txt"))).toBe(false);
    expect(existsSync(join(r.work, "g2.txt"))).toBe(false);
    if (family === "claude") {
      // The general launch removed the native shell and writes (read back from init, P15 E).
      const launch = r.cliLog().find((l) => Array.isArray(l.args)) as { args: string[] } | undefined;
      const denied = launch?.args[launch.args.indexOf("--disallowedTools") + 1] ?? "";
      expect(denied).toContain("Bash");
      expect(denied).toContain("Write");
      expect(launch?.args).toContain("--max-turns");
    }
    if (family === "codex") {
      // Read-only sandbox, approvals never.
      const started = r.cliLog().find((l) => l.method === "thread/start") as {
        params?: Record<string, unknown>;
      };
      expect(started?.params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never" });
    }
  }, 90_000);

  it("an engine that cannot do coding: the dispatch is refused and no worker is made", async () => {
    const r = rig(family, { harness: "coding", level: "autonomous", unfit: true });
    const threadId = await r.send(`改檔 ${WRITE[family]("u.txt", "x")}`);
    expect(r.store.workers.byThread(threadId)).toEqual([]);
    const refused = r.events.find(
      (e): e is Extract<AlcaEvent, { type: "tool.completed" }> => e.type === "tool.completed" && !e.data.ok,
    );
    expect(refused?.data.error).toContain("不能做 coding 工作");
    expect(existsSync(join(r.work, "u.txt"))).toBe(false);
    expect(r.cliLog()).toEqual([]); // the CLI was never started
  }, 30_000);

  const CHECK = `node -e "process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)"`;

  it("after the CLI's turn the host's check runs — green: verified", async () => {
    const r = rig(family, { harness: "coding", level: "autonomous", checks: [CHECK] });
    const threadId = await r.send(`修好 ${WRITE[family]("state.txt", "fixed")}`);
    const w = await settled(r, threadId);
    const d = dispatchOf(r, w);
    expect((d?.report as { verified?: boolean } | undefined)?.verified).toBe(true);
    const checks = r.store.dispatches.events(d?.id ?? "").filter((e) => e.kind === "turn.completed");
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(r.work, "state.txt"), "utf8")).toBe("fixed");
  }, 90_000);

  it("after the CLI's turn the host's check runs — red: told to the worker, then unverified", async () => {
    const r = rig(family, { harness: "coding", level: "autonomous", checks: [CHECK] });
    const threadId = await r.send(`修好 ${WRITE[family]("state.txt", "broken")}`);
    const w = await settled(r, threadId);
    const d = dispatchOf(r, w);
    expect(d?.outcome).toBe("unverified");
    const report = d?.report as { verified?: boolean; report: { status: string } } | undefined;
    expect(report?.verified).toBe(false);
    expect(report?.report.status).toBe("unverified");
    // The red check went back to the same CLI session: more than the first turn ran.
    const turns = r.store.dispatches.events(d?.id ?? "").filter((e) => e.kind === "turn.completed");
    expect(turns.length).toBeGreaterThan(1);
  }, 120_000);
});
