import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_MATRIX, type ScriptContext, ScriptedEngine, type ScriptStep } from "@alca/engines";
import { FULL_ACCESS_REASON } from "@alca/policy";
import type { WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { SNAPSHOT_REF_PREFIX } from "../src/harness/git-snapshots.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

/**
 * Phase 5 on the formal path (router → WorkerSupervisor → HarnessRun → gate),
 * scripted engines and made-up data only:
 * - at 完全授權 a write runs without a card and the dispatch ledger records
 *   it with 「放行原因：完全授權」; payment and an outward send still put up a
 *   card and do not run when the person says no;
 * - an engine that asks only sometimes takes coding work only at 完全授權,
 *   with a hidden snapshot ref before every turn in a git repository; 11-05:
 *   a folder that is not git (or a snapshot that fails) still runs, and the
 *   ledger says why there is no snapshot (`snapshot.skipped`).
 */
let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (git: boolean) => {
  const d = mkdtempSync(join(tmpdir(), "alca-full-access-"));
  dirs.push(d);
  writeFileSync(join(d, "a.txt"), "original\n");
  if (git) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    };
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      ["commit", "-qm", "first"],
    ])
      execFileSync("git", args, { cwd: d, env, stdio: "ignore" });
  }
  return d;
};

const routerFor =
  (args: Record<string, unknown>) =>
  ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (req.userMessage.includes("<alca:worker")) return say("收到回報");
    return pass === 0
      ? call("s", "worker_start", { title: "工作", goal: lastLine(req.userMessage), ...args })
      : say("派了");
  };

const setFullAccess = (x: Harness) => {
  const bot = x.store.bots.default();
  if (!bot) throw new Error("no default bot");
  x.store.bots.update(bot.id, { approvalLevel: "full_access" });
  return bot.id;
};

const eventsOf = (x: Harness, dispatchId: string) =>
  x.store.db
    .prepare("SELECT kind, detail FROM dispatch_events WHERE dispatch_id = ? ORDER BY seq")
    .all(dispatchId)
    .map((r) => {
      const row = r as { kind: string; detail: string | null };
      return {
        kind: row.kind,
        detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {},
      };
    });

/** 11-05: a host write tool that really changes `a.txt`, and a worker that calls it then reports. */
const editA = (dir: string) =>
  tool("edit_a", "write", () => {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    return "ok";
  });
const editor = ({ pass }: ScriptContext): ScriptStep[] => {
  if (pass === 0) return call("w", "edit_a", {});
  if (pass === 1)
    return call("r", "report_result", { status: "done", summary: "改好了", changes: ["a.txt"] });
  return say("完成");
};

describe("full access on the formal path", () => {
  it("a write runs and is ledgered as full access; payment and send still ask and do not run when denied", async () => {
    const note = tool("write_note", "write");
    const pay = tool("pay_invoice", "payment");
    const mail = tool("send_mail", "send");
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) return call("w", "write_note", { text: "草稿" });
      if (pass === 1) return call("p", "pay_invoice", { amount: 120 });
      if (pass === 2) return call("m", "send_mail", { to: "someone@example.test" });
      if (pass === 3)
        return call("r", "report_result", { status: "partial", summary: "付款與寄信沒有被核准" });
      return say("結束");
    };
    h = makeAgents({ router: routerFor({ harness: "general" }), worker, tools: [note, pay, mail] });
    setFullAccess(h);
    expect(h.store.bots.default()?.approvalLevel).toBe("full_access");
    const t = h.core.createThread();
    await h.core.send(t.id, "整理筆記、付款、寄信").done;

    const payCard = await until(() => h?.store.human.pendingApprovals()[0]);
    expect(payCard.actionClass).toBe("payment");
    h.core.answerApproval(payCard.id, "denied");
    const mailCard = await until(() =>
      h?.store.human.pendingApprovals().find((a) => a.actionClass === "send"),
    );
    h.core.answerApproval(mailCard.id, "denied");
    const w = await until(() => {
      const x = h?.store.workers.byThread(t.id)[0];
      return x && x.status !== "running" && x.status !== "queued" ? x : undefined;
    }, 15_000);

    expect(note.calls).toHaveLength(1);
    expect(pay.calls).toHaveLength(0);
    expect(mail.calls).toHaveLength(0);
    const ledger = eventsOf(h, (w as WorkerRecord).grants.dispatchId as string);
    const auto = ledger.filter((e) => e.kind === "auto_allowed");
    expect(auto).toHaveLength(1);
    expect(auto[0]?.detail).toMatchObject({
      reason: FULL_ACCESS_REASON,
      tool: "write_note",
      actionClass: "write",
    });
    expect(ledger.find((e) => e.kind === "queued")?.detail).toMatchObject({ level: "full_access" });
    // the audit row says why, too
    const audit = h.store.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'write_note' AND decision = 'allow'")
      .all() as Array<{ detail: string }>;
    expect(audit.some((a) => JSON.parse(a.detail).grant === "full_access")).toBe(true);
  }, 30_000);
});

describe("shell tools under other names (security fix 2026-11-05)", () => {
  it("at full access a plain git push through shell / hands_run runs and is ledgered auto_allowed; sendmail still asks", async () => {
    const shell = tool("shell", "execute", () => "pushed");
    const hands = tool("hands_run", "execute", () => "sent");
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) return call("a", "shell", { command: "git push origin main" });
      if (pass === 1) return call("b", "hands_run", { command: "git push" });
      if (pass === 2) return call("c", "hands_run", { command: "sendmail ops@example.test < note.txt" });
      if (pass === 3) return call("r", "report_result", { status: "partial", summary: "寄信沒有被核准" });
      return say("結束");
    };
    // Mac test B2: coding at full access needs a git folder (a snapshot before every turn).
    const dir = tmp(true);
    h = makeAgents({
      router: routerFor({ harness: "coding" }),
      worker,
      tools: [shell, hands],
      system: { workDir: () => dir },
    });
    setFullAccess(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "推送後寄信").done;
    const card = await until(() => h?.store.human.pendingApprovals()[0]);
    expect(card.actionClass).toBe("send");
    h.core.answerApproval(card.id, "denied");
    const w = await until(() => {
      const x = h?.store.workers.byThread(t.id)[0];
      return x && x.status !== "running" && x.status !== "queued" ? x : undefined;
    }, 15_000);
    expect(shell.calls).toHaveLength(1);
    expect(hands.calls.map((c) => c.command)).toEqual(["git push"]);
    const auto = eventsOf(h, (w as WorkerRecord).grants.dispatchId as string).filter(
      (e) => e.kind === "auto_allowed",
    );
    expect(auto.map((e) => [e.detail.tool, e.detail.actionClass, e.detail.reason])).toEqual([
      ["shell", "publish", FULL_ACCESS_REASON],
      ["hands_run", "publish", FULL_ACCESS_REASON],
    ]);
  }, 30_000);
});

describe("coding with an engine that asks only sometimes", () => {
  const onRequest = (script: (c: ScriptContext) => ScriptStep[]) =>
    new ScriptedEngine(script, {
      id: "cx",
      capabilities: { harness: HARNESS_MATRIX.codexAppServerOnRequest },
    });

  it("at full access, in a git repo: dispatched, and a hidden snapshot is kept before every turn", async () => {
    const dir = tmp(true);
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) return call("w", "write", { path: "a.txt", content: "changed\n" });
      if (pass === 1)
        return call("r", "report_result", { status: "done", summary: "改好了", changes: ["a.txt"] });
      return say("完成");
    };
    h = makeAgents({
      router: routerFor({ harness: "coding", checks: ["true"] }),
      worker: () => say("不該用到"),
      system: { workDir: () => dir, workerHarnessEngines: { coding: onRequest(worker) } },
    });
    setFullAccess(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "把 a.txt 改掉").done;
    const w = await until(() => {
      const x = h?.store.workers.byThread(t.id)[0];
      return x && x.status !== "running" && x.status !== "queued" ? x : undefined;
    }, 20_000);
    const dispatchId = (w as WorkerRecord).grants.dispatchId as string;
    const snaps = eventsOf(h, dispatchId).filter((e) => e.kind === "snapshot");
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const ref = `${SNAPSHOT_REF_PREFIX}/${dispatchId}/1`;
    expect(snaps[0]?.detail.ref).toBe(ref);
    // taken before the turn: it holds the file as it was
    expect(execFileSync("git", ["show", `${ref}:a.txt`], { cwd: dir, encoding: "utf8" })).toBe("original\n");
    expect(
      execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: dir, encoding: "utf8" }).trim(),
    ).toBe("main");
    expect(h.store.gitSnapshots.ofDispatch(dispatchId).length).toBe(snaps.length);
  }, 30_000);

  it("at 自主 the same engine is refused for coding (no worker, no snapshot)", async () => {
    const dir = tmp(true);
    h = makeAgents({
      router: routerFor({ harness: "coding" }),
      worker: () => say("不該用到"),
      level: "autonomous",
      system: { workDir: () => dir, workerHarnessEngines: { coding: onRequest(() => say("x")) } },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "改檔").done;
    const done = h.events.find(
      (e) => e.type === "tool.completed" && !e.data.ok && String(e.data.error).includes("coding"),
    );
    expect(done).toBeDefined();
    expect(h.store.workers.byThread(t.id)).toHaveLength(0);
    expect(h.store.gitSnapshots.repos()).toEqual([]);
  });

  it("11-05: at full access outside a git repo it starts, edits the file and records one snapshot.skipped", async () => {
    const dir = tmp(false);
    h = makeAgents({
      router: routerFor({ harness: "coding", checks: ["true"] }),
      worker: () => say("不該用到"),
      tools: [editA(dir)],
      system: { workDir: () => dir, workerHarnessEngines: { coding: onRequest(editor) } },
    });
    setFullAccess(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "把 a.txt 改掉").done;
    const w = (await until(() => {
      const x = h?.store.workers.byThread(t.id)[0];
      return x && x.status !== "running" && x.status !== "queued" ? x : undefined;
    }, 20_000)) as WorkerRecord;
    expect(w.status).not.toBe("failed");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("changed\n");
    const ev = eventsOf(h, w.grants.dispatchId as string);
    expect(ev.filter((e) => e.kind === "snapshot")).toEqual([]);
    expect(ev.filter((e) => e.kind === "snapshot.skipped")).toEqual([
      { kind: "snapshot.skipped", detail: { workerId: w.id, reason: "not_git" } },
    ]);
    expect(h.store.gitSnapshots.repos()).toEqual([]);
  }, 30_000);
});

describe("coding with an engine that always asks (Claude Code, mac test B2)", () => {
  const asksAll = (script: (c: ScriptContext) => ScriptStep[]) =>
    new ScriptedEngine(script, { id: "cc", capabilities: { harness: HARNESS_MATRIX.claudeCoding } });
  const writer = ({ pass }: ScriptContext): ScriptStep[] => {
    if (pass === 0) return call("w", "write", { path: "a.txt", content: "changed\n" });
    if (pass === 1)
      return call("r", "report_result", { status: "done", summary: "改好了", changes: ["a.txt"] });
    return say("完成");
  };
  const finished = (x: Harness, threadId: string) =>
    until(() => {
      const w = x.store.workers.byThread(threadId)[0];
      return w && w.status !== "running" && w.status !== "queued" ? w : undefined;
    }, 20_000);

  it("at full access, in a git repo: a snapshot is kept before the turn, as for any engine", async () => {
    const dir = tmp(true);
    h = makeAgents({
      router: routerFor({ harness: "coding", checks: ["true"] }),
      worker: () => say("不該用到"),
      system: { workDir: () => dir, workerHarnessEngines: { coding: asksAll(writer) } },
    });
    setFullAccess(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "把 a.txt 改掉").done;
    const w = (await finished(h, t.id)) as WorkerRecord;
    const dispatchId = w.grants.dispatchId as string;
    const snaps = eventsOf(h, dispatchId).filter((e) => e.kind === "snapshot");
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const ref = `${SNAPSHOT_REF_PREFIX}/${dispatchId}/1`;
    expect(snaps[0]?.detail.ref).toBe(ref);
    expect(execFileSync("git", ["show", `${ref}:a.txt`], { cwd: dir, encoding: "utf8" })).toBe("original\n");
  }, 30_000);

  it("11-05: at full access outside a git repo: the worker runs and edits; not_git is recorded once", async () => {
    const dir = tmp(false);
    h = makeAgents({
      router: routerFor({ harness: "coding", checks: ["true"] }),
      worker: () => say("不該用到"),
      tools: [editA(dir)],
      system: { workDir: () => dir, workerHarnessEngines: { coding: asksAll(editor) } },
    });
    setFullAccess(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "改檔").done;
    const w = (await finished(h, t.id)) as WorkerRecord;
    expect(w.status).not.toBe("failed");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("changed\n");
    const skipped = eventsOf(h, w.grants.dispatchId as string).filter((e) => e.kind === "snapshot.skipped");
    expect(skipped.map((e) => e.detail.reason)).toEqual(["not_git"]);
  }, 30_000);

  it("11-05: at full access in a git repo whose snapshot fails: the turn still runs and the failure is recorded", async () => {
    const dir = tmp(true);
    // a file where git wants the refs/alca directory: update-ref fails, like any git error
    writeFileSync(join(dir, ".git", "refs", "alca"), "not a directory\n");
    h = makeAgents({
      router: routerFor({ harness: "coding", checks: ["true"] }),
      worker: () => say("不該用到"),
      tools: [editA(dir)],
      system: { workDir: () => dir, workerHarnessEngines: { coding: asksAll(editor) } },
    });
    setFullAccess(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "把 a.txt 改掉").done;
    const w = (await finished(h, t.id)) as WorkerRecord;
    expect(w.status).not.toBe("failed");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("changed\n");
    const ev = eventsOf(h, w.grants.dispatchId as string);
    expect(ev.filter((e) => e.kind === "snapshot")).toEqual([]);
    const failed = ev.filter((e) => e.kind === "snapshot.skipped");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    for (const e of failed) {
      expect(e.detail).toMatchObject({ workerId: w.id, reason: "snapshot_failed" });
      expect(String(e.detail.error ?? "")).not.toBe("");
    }
  }, 30_000);

  it("at 自主 and 每步確認 the same engine keeps no snapshot (unchanged)", async () => {
    for (const level of ["autonomous", "confirm_each_step"] as const) {
      const dir = tmp(true);
      const x = makeAgents({
        router: routerFor({ harness: "coding", checks: ["true"] }),
        worker: () => say("不該用到"),
        level,
        system: {
          workDir: () => dir,
          workerHarnessEngines: {
            coding: asksAll(({ pass }) =>
              pass === 0 ? call("r", "report_result", { status: "done", summary: "看過了" }) : say("完成"),
            ),
          },
        },
      });
      h = x;
      const t = x.core.createThread();
      await x.core.send(t.id, "看一下").done;
      const w = (await finished(x, t.id)) as WorkerRecord;
      expect(
        eventsOf(x, w.grants.dispatchId as string).filter((e) => e.kind === "snapshot"),
        level,
      ).toEqual([]);
      expect(x.store.gitSnapshots.repos(), level).toEqual([]);
      await x.close();
      h = undefined;
    }
  }, 30_000);
});
