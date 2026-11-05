import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScriptContext, ScriptStep } from "@alca/engines";
import type { ConfineProbe } from "@alca/os";
import type { AlcaEvent } from "@alca/protocol";
import type { WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { BotWorkDirs, UNSANDBOXED_REASON, WorkspaceGuards } from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";

/**
 * Next-round §5 on the formal path (router → WorkerSupervisor → HarnessRun →
 * gate → coding bash → BashSessions), scripted API engine, made-up data:
 * - at 完全授權 with a working bubblewrap, a command that writes outside the
 *   work folder or reads Alca's secrets through a script the string guards
 *   cannot see is stopped by the OS layer;
 * - `unsandboxed: true` puts up a card even at 完全授權;
 * - `mode: on` without a usable sandbox: the shell refuses, nothing runs;
 * - `auto` without a usable sandbox (the person's decision): it runs as
 *   before, one audit row says so, and the worker panel says `unavailable`.
 */

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let bwrap = false;
try {
  execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/true"], {
    stdio: "ignore",
  });
  bwrap = process.platform === "linux";
} catch {
  bwrap = false;
}

function layout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alca-sbx-formal-")));
  dirs.push(root);
  const data = join(root, "data");
  const work = join(root, "work");
  const outside = join(root, "outside");
  for (const d of [data, work, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(data, "secrets.json"), '{"token":"s3cret-made-up"}');
  // Scripts whose targets no string check can see (the OS layer is what holds).
  writeFileSync(join(work, "write-out.sh"), `touch "${outside}/x"\necho wrote-out\n`);
  writeFileSync(join(work, "read-secret.sh"), `cat "${data}/secrets.json"\necho read-done\n`);
  return { root, data, work, outside };
}

const routerFor = ({ req, pass }: ScriptContext): ScriptStep[] => {
  if (req.userMessage.includes("<alca:worker")) return say("收到回報");
  return pass === 0
    ? call("s", "worker_start", {
        title: "跑腳本",
        goal: lastLine(req.userMessage),
        harness: "coding",
        checks: ["true"],
      })
    : say("派了");
};

type Completed = Extract<AlcaEvent, { type: "tool.completed" }>;
function workerEvents(x: Harness): AlcaEvent[] {
  const out: AlcaEvent[] = [];
  const bus = x.core.bus;
  const publishTo = bus.publishTo.bind(bus);
  bus.publishTo = (key, e) => {
    if (key.startsWith("worker:")) out.push(e);
    publishTo(key, e);
  };
  return out;
}
const outputs = (events: AlcaEvent[]) =>
  events
    .filter((e): e is Completed => e.type === "tool.completed")
    .map((e) =>
      typeof e.data.result === "string" ? e.data.result : JSON.stringify(e.data.result ?? e.data.error ?? ""),
    );

function harness(
  l: ReturnType<typeof layout>,
  worker: (c: ScriptContext) => ScriptStep[],
  o: { probe: ConfineProbe | undefined; sandbox?: Record<string, unknown> },
): Harness {
  const x = makeAgents({ router: routerFor, worker, level: "autonomous", system: { workDir: () => l.work } });
  const store = x.store;
  const bot = store.bots.default();
  if (!bot) throw new Error("no default bot");
  store.bots.update(bot.id, {
    approvalLevel: "full_access",
    ...(o.sandbox ? { sandbox: JSON.stringify(o.sandbox) } : {}),
  });
  x.core.useGuards(
    new WorkspaceGuards({
      store,
      workDirs: new BotWorkDirs({ dataDir: l.data, store, defaultDir: l.work }),
      confiner: () => o.probe,
    }),
  );
  return x;
}

const settled = (x: Harness, threadId: string) =>
  until(() => {
    const w = x.store.workers.byThread(threadId)[0];
    return w && w.status !== "running" && w.status !== "queued" ? w : undefined;
  }, 25_000);

describe.skipIf(!bwrap)("sandbox on the formal path (bubblewrap)", () => {
  it("at 完全授權 a hidden write outside and a hidden secret read are stopped; unsandboxed still asks", async () => {
    const l = layout();
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) return call("b1", "bash", { command: "sh write-out.sh" });
      if (pass === 1) return call("b2", "bash", { command: "sh read-secret.sh" });
      if (pass === 2) return call("b3", "bash", { command: "sh write-out.sh", unsandboxed: true });
      if (pass === 3) return call("rep", "report_result", { status: "partial", summary: "沙箱擋下了寫入" });
      return say("完成");
    };
    h = harness(l, worker, { probe: { kind: "bwrap", ok: true } });
    const events = workerEvents(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "跑兩個腳本").done;
    const card = await until(() => h?.store.human.pendingApprovals()[0], 20_000);
    expect(card.summary).toContain("沙箱外");
    h.core.answerApproval(card.id, "denied");
    const w = (await settled(h, t.id)) as WorkerRecord;
    const out = outputs(events).join("\n");
    expect(existsSync(join(l.outside, "x"))).toBe(false);
    expect(out).not.toContain("s3cret-made-up");
    expect(out).toContain("read-done");
    expect(h.agents.workers.state(w).harness?.sandbox).toBe("bwrap");
  }, 40_000);
});

describe("sandbox required or missing (no bubblewrap needed)", () => {
  it("mode on without a usable sandbox: the shell refuses and nothing runs", async () => {
    const l = layout();
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) return call("b1", "bash", { command: "sh write-out.sh" });
      if (pass === 1) return call("rep", "report_result", { status: "failed", summary: "沙箱不可用" });
      return say("完成");
    };
    h = harness(l, worker, {
      probe: { kind: "bwrap", ok: false, reason: "沒有安裝 bubblewrap（bwrap）" },
      sandbox: { mode: "on", network: "open" },
    });
    const events = workerEvents(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "跑腳本").done;
    const w = (await settled(h, t.id)) as WorkerRecord;
    expect(existsSync(join(l.outside, "x"))).toBe(false);
    expect(outputs(events).join("\n")).toContain("這個 bot 要求沙箱");
    expect(h.agents.workers.state(w).harness?.sandbox).toBe("unavailable");
  }, 40_000);

  it("auto without a usable sandbox at 完全授權: runs as before, one audit row, the panel says unavailable", async () => {
    const l = layout();
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) return call("b1", "bash", { command: "sh write-out.sh" });
      if (pass === 1) return call("b2", "bash", { command: "sh write-out.sh" });
      if (pass === 2) return call("rep", "report_result", { status: "done", summary: "寫好了" });
      return say("完成");
    };
    h = harness(l, worker, { probe: { kind: "bwrap", ok: false, reason: "沒有安裝 bubblewrap（bwrap）" } });
    const t = h.core.createThread();
    await h.core.send(t.id, "跑腳本").done;
    const w = (await settled(h, t.id)) as WorkerRecord;
    expect(existsSync(join(l.outside, "x"))).toBe(true);
    expect(h.store.human.pendingApprovals()).toHaveLength(0);
    const rows = h.store.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'sandbox.unavailable'")
      .all();
    expect(rows).toHaveLength(1);
    expect(h.agents.workers.state(w).harness?.sandbox).toBe("unavailable");
  }, 40_000);

  it("the unsandboxed reason is the guards' (the card wording)", () => {
    expect(UNSANDBOXED_REASON).toContain("沙箱外");
  });
});
