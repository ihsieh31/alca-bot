// Phase 7 — coding harness on the formal path: router → worker_start →
// WorkerSupervisor → HarnessRun → gate → Alca's own coding tools, with a
// scripted API engine (Alca owns the tool loop). Every repo, file and task
// is fictional. Each scenario's checks look at what really happened on disk,
// in the dispatch ledger and in what the model was handed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BotWorkDirs, WorkspaceGuards } from "@alca/core";
import { type Script, type ScriptContext, ScriptedEngine, type ScriptStep } from "@alca/engines";
import { type Agents, agentSystem, call, say, until, using } from "../src/fixtures.ts";
import type { EvalContext, Scenario } from "../src/harness.ts";
import {
  cards,
  dispatchRouter,
  endedWorker,
  folders,
  ledgerOf,
  reportIn,
  type Step,
  type StepResult,
  stepper,
} from "../src/harness-fixtures.ts";

interface CodingRun {
  a: Agents;
  dir: string;
  threadId: string;
}

/** One coding dispatch in a fresh fictional folder; `fn` runs once the router got the report. */
async function coding(
  o: {
    files?: Record<string, string | Buffer>;
    worker: Script;
    route?: Record<string, unknown>;
    goal?: string;
    system?: Parameters<typeof agentSystem>[0]["system"];
    waitReport?: boolean;
    before?: (x: CodingRun) => void;
  },
  fn: (x: CodingRun) => Promise<void>,
): Promise<void> {
  const f = folders();
  const dir = f.make(o.files ?? {});
  try {
    await using(
      agentSystem({
        router: dispatchRouter({ harness: "coding", checks: ["true"], ...o.route }),
        worker: o.worker,
        level: "autonomous",
        system: { workDir: () => dir, ...o.system },
      }),
      async (a) => {
        const t = a.core.createThread();
        o.before?.({ a, dir, threadId: t.id });
        await a.core.send(t.id, o.goal ?? "請修改這個虛構專案").done;
        if (o.waitReport !== false) await reportIn(a, t.id, { ms: 25_000 });
        await fn({ a, dir, threadId: t.id });
      },
    );
  } finally {
    f.clean();
  }
}

const fileText = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");
const fileBytes = (dir: string, p: string) => readFileSync(join(dir, p));
const outcome = (x: CodingRun) => ledgerOf(x.a, x.a.store.workers.byThread(x.threadId)[0]);
const res = (results: StepResult[], i: number) => results[i] ?? { ok: false, output: "(no result)" };

/** The dispatch settled done and the host verified it. */
function settledVerified(ctx: EvalContext, x: CodingRun): void {
  const { row } = outcome(x);
  ctx.check("the dispatch settled as done", row?.outcome === "done", row?.outcome);
  ctx.check(
    "the host verified it",
    (row?.report as { verified?: boolean } | undefined)?.verified === true,
    row?.report,
  );
}

// "測試檔案\n名稱 = 範例\n" in Big5 (fictional content).
const BIG5 = Buffer.from([
  0xb4, 0xfa, 0xb8, 0xd5, 0xc0, 0xc9, 0xae, 0xd7, 0x0a, 0xa6, 0x57, 0xba, 0xd9, 0x20, 0x3d, 0x20, 0xbd, 0x64,
  0xa8, 0xd2, 0x0a,
]);

/** Pass check: `state.txt` says fixed. The `| cat` hides grep's exit code unless pipefail is on. */
const PIPED_CHECK = "grep -q fixed state.txt | cat";
const PLAIN_CHECK = "grep -q fixed state.txt";

/** A coding worker per run: write state.txt, report; after a red check it writes again (fixing it or not). */
function stateWriter(fixes: boolean) {
  const red = new Map<string, boolean>();
  const writes: string[] = [];
  const script = ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (pass === 0) red.set(req.runId, req.userMessage.includes("沒有通過"));
    const after = red.get(req.runId) ?? false;
    if (pass === 0) {
      const content = after && fixes ? "fixed\n" : "broken\n";
      writes.push(content.trim());
      return call("w", "write", { path: "state.txt", content });
    }
    if (pass === 1)
      return call("r", "report_result", { status: "done", summary: after ? "修好了" : "改好了" });
    return say("完成");
  };
  return { script, writes };
}

export const codingHarnessScenarios: Scenario[] = [
  {
    id: "harness.coding.read-before-write",
    category: "coding",
    title: "edit before read is refused (file untouched); after read the same edit applies",
    timeoutMs: 30_000,
    async run(ctx) {
      const edit: Step = {
        name: "edit",
        input: { path: "src/a.ts", edits: [{ old: "a = 1", new: "a = 2" }] },
      };
      let afterRefusal = "";
      const w = stepper([
        edit,
        (): Step => {
          afterRefusal = fileText(dir(), "src/a.ts");
          return { name: "read", input: { path: "src/a.ts" } };
        },
        edit,
      ]);
      let dirOf = "";
      const dir = () => dirOf;
      await coding(
        {
          files: { "src/a.ts": "export const a = 1;\n" },
          worker: w.script,
          before: (x) => {
            dirOf = x.dir;
          },
        },
        async (x) => {
          const first = res(w.seen.results, 0);
          ctx.check("the first edit failed as a tool error", first.ok === false, first);
          ctx.check("the model is told to read first", /先用 read/.test(first.output), first.output);
          ctx.check(
            "the refused edit left the file alone",
            afterRefusal === "export const a = 1;\n",
            afterRefusal,
          );
          ctx.check("the read worked", res(w.seen.results, 1).ok, w.seen.results[1]);
          ctx.check("the edit after the read worked", res(w.seen.results, 2).ok, w.seen.results[2]);
          ctx.check("the file has the change once", fileText(x.dir, "src/a.ts") === "export const a = 2;\n");
          settledVerified(ctx, x);
        },
      );
    },
  },
  {
    id: "harness.coding.loose-match",
    category: "coding",
    title: "an edit whose old text differs only in Unicode quotes and trailing blanks still applies, once",
    timeoutMs: 30_000,
    async run(ctx) {
      const src = "export function greet() {  \n  return \u201Chello\u201D;\n}\n";
      const w = stepper([
        { name: "read", input: { path: "greet.ts" } },
        {
          name: "edit",
          input: {
            path: "greet.ts",
            edits: [
              {
                old: 'export function greet() {\n  return "hello";',
                new: 'export function greet() {\n  return "hi";',
              },
            ],
          },
        },
      ]);
      await coding({ files: { "greet.ts": src }, worker: w.script }, async (x) => {
        const e = res(w.seen.results, 1);
        ctx.check("the loose edit was accepted", e.ok, e);
        ctx.check("the result names the loose level", /Unicode|行尾空白/.test(e.output), e.output);
        const after = fileText(x.dir, "greet.ts");
        ctx.check("the line now returns hi", after.includes('return "hi";'), after);
        ctx.check("the old line is gone", !after.includes("hello"), after);
        ctx.check("the closing brace is kept", after.trimEnd().endsWith("}"), after);
      });
    },
  },
  {
    id: "harness.coding.already-applied",
    category: "coding",
    title: "an edit or patch already in the file is reported as applied, not an error, and writes nothing",
    timeoutMs: 30_000,
    async run(ctx) {
      const src = 'const limit = 10;\nconst name = "demo";\n';
      const patch = [
        "*** Begin Patch",
        "*** Update File: cfg.ts",
        " const limit = 10;",
        '-const name = "old";',
        '+const name = "demo";',
        "*** End Patch",
      ].join("\n");
      const w = stepper([
        { name: "read", input: { path: "cfg.ts" } },
        {
          name: "edit",
          input: { path: "cfg.ts", edits: [{ old: "const limit = 5;", new: "const limit = 10;" }] },
        },
        { name: "apply_patch", input: { patch } },
      ]);
      await coding({ files: { "cfg.ts": src }, worker: w.script }, async (x) => {
        const e = res(w.seen.results, 1);
        const p = res(w.seen.results, 2);
        ctx.check("edit: ok, not a tool error", e.ok, e);
        ctx.check("edit: says 已套用", /^已套用/.test(e.output), e.output);
        ctx.check("patch: ok, says 已套用", p.ok && /^已套用/.test(p.output), p);
        ctx.check("the file is byte for byte as it was", fileText(x.dir, "cfg.ts") === src);
        settledVerified(ctx, x);
      });
    },
  },
  {
    id: "harness.coding.non-utf8-refused",
    category: "coding",
    title: "a Big5 file: read shows it with a note, edit and write are refused, the bytes stay",
    timeoutMs: 30_000,
    async run(ctx) {
      const w = stepper([
        { name: "read", input: { path: "big5.txt" } },
        { name: "edit", input: { path: "big5.txt", edits: [{ old: " = ", new: " := " }] } },
        { name: "write", input: { path: "big5.txt", content: "replaced\n" } },
      ]);
      await coding({ files: { "big5.txt": BIG5 }, worker: w.script }, async (x) => {
        const [r, e, wr] = [0, 1, 2].map((i) => res(w.seen.results, i));
        ctx.check("read says it is not UTF-8", !!r?.ok && r.output.includes("不是 UTF-8"), r);
        ctx.check(
          "edit is refused, pointing at bash",
          !e?.ok && /不是 UTF-8[\s\S]*bash/.test(e?.output ?? ""),
          e,
        );
        ctx.check("write is refused", !wr?.ok && (wr?.output ?? "").includes("不是 UTF-8"), wr);
        ctx.check("the bytes are untouched", fileBytes(x.dir, "big5.txt").equals(BIG5));
      });
    },
  },
  {
    id: "harness.coding.mixed-eol-kept",
    category: "coding",
    title: "an edit in a mixed CRLF / LF file keeps every untouched line's ending",
    timeoutMs: 30_000,
    async run(ctx) {
      const MIXED = "one\r\ntwo\nthree\r\nfour\nfive\r\n";
      const w = stepper([
        { name: "read", input: { path: "m.txt" } },
        { name: "edit", input: { path: "m.txt", edits: [{ old: "three", new: "THREE" }] } },
      ]);
      await coding({ files: { "m.txt": MIXED }, worker: w.script }, async (x) => {
        ctx.check("the edit worked", res(w.seen.results, 1).ok, w.seen.results[1]);
        const after = fileBytes(x.dir, "m.txt").toString("utf8");
        ctx.check(
          "only the changed line differs; CRLF and LF lines kept",
          after === "one\r\ntwo\nTHREE\r\nfour\nfive\r\n",
          JSON.stringify(after),
        );
      });
    },
  },
  {
    id: "harness.coding.pipefail-red-then-green",
    category: "coding",
    title: "a piped check that hides a failure is red under pipefail; the worker fixes it and it turns green",
    timeoutMs: 40_000,
    async run(ctx) {
      const w = stateWriter(true);
      await coding({ worker: w.script, route: { checks: [PIPED_CHECK] } }, async (x) => {
        const { row, kinds } = outcome(x);
        ctx.check(
          "the worker had to write twice (red, then fixed)",
          w.writes.join(",") === "broken,fixed",
          w.writes,
        );
        ctx.check("state.txt ends fixed", fileText(x.dir, "state.txt") === "fixed\n");
        ctx.check("two turns completed", kinds.filter((k) => k === "turn.completed").length === 2, kinds);
        ctx.check(
          "settled done and verified",
          row?.outcome === "done" && (row.report as { verified?: boolean }).verified === true,
          row,
        );
      });
    },
  },
  {
    id: "harness.coding.red-three-unverified",
    category: "coding",
    title: "the check stays red three rounds in a row → unverified, said honestly",
    timeoutMs: 40_000,
    async run(ctx) {
      const w = stateWriter(false);
      await coding({ worker: w.script, route: { checks: [PLAIN_CHECK] } }, async (x) => {
        const { row, kinds } = outcome(x);
        const msg = x.a.store.threads.messages(x.threadId).find((m) => m.content.includes("<alca:worker"));
        ctx.check("outcome unverified", row?.outcome === "unverified", row?.outcome);
        ctx.check(
          "report status unverified",
          (row?.report as { report?: { status?: string } })?.report?.status === "unverified",
          row?.report,
        );
        ctx.check(
          "first turn + 3 red rounds",
          kinds.filter((k) => k === "turn.completed").length === 4,
          kinds,
        );
        ctx.check("the router is told ok=false", !!msg?.content.includes('ok="false"'), msg?.content);
      });
    },
  },
  {
    id: "harness.coding.ownspaths-card",
    category: "coding",
    title: "ownsPaths: a write outside the assigned paths asks even under 自主; inside it does not",
    timeoutMs: 30_000,
    async run(ctx) {
      const w = stepper([
        { name: "write", input: { path: "README.md", content: "不在指派範圍\n" } },
        { name: "write", input: { path: "src/inside.ts", content: "export const ok = 1;\n" } },
      ]);
      const guardData = folders();
      await coding(
        {
          files: { "src/.keep": "" },
          worker: w.script,
          route: { ownsPaths: ["src"] },
          waitReport: false,
          // The workspace guards are what turn an ownsPaths breach into a card.
          before: (x) => {
            const store = x.a.store;
            const data = guardData.make();
            x.a.core.useGuards(
              new WorkspaceGuards({
                store,
                workDirs: new BotWorkDirs({ dataDir: data, store, defaultDir: x.dir }),
              }),
            );
          },
        },
        async (x) => {
          const card = await until(() => cards(x.a.events)[0], 15_000);
          ctx.check("the card names ownsPaths", /ownsPaths/.test(card.data.summary), card.data.summary);
          ctx.check("the card names the file", card.data.summary.includes("README.md"), card.data.summary);
          x.a.core.answerApproval(card.data.approvalId, "denied");
          await reportIn(x.a, x.threadId);
          let readme = true;
          try {
            fileText(x.dir, "README.md");
          } catch {
            readme = false;
          }
          ctx.check("README.md was not written", !readme);
          ctx.check("the write inside src ran", fileText(x.dir, "src/inside.ts").includes("ok = 1"));
          ctx.check("exactly one card", cards(x.a.events).length === 1, cards(x.a.events).length);
        },
      ).finally(() => guardData.clean());
    },
  },
  {
    id: "harness.coding.agents-md-layered",
    category: "coding",
    title: "AGENTS.md: the root one is in the task; a sub-folder's arrives with the first read there, once",
    timeoutMs: 30_000,
    async run(ctx) {
      const w = stepper([
        { name: "read", input: { path: "pkg/a.ts" } },
        { name: "read", input: { path: "pkg/b.ts" } },
      ]);
      const files = {
        ".git/HEAD": "ref: refs/heads/main\n",
        "AGENTS.md": "# 虛構專案\n\n根目錄規則：一律用 tabs。\n",
        "pkg/AGENTS.md": "pkg 規則：這裡不准用 any。\n",
        "pkg/a.ts": "export const a = 1;\n",
        "pkg/b.ts": "export const b = 2;\n",
      };
      await coding({ files, worker: w.script }, async () => {
        ctx.check(
          "the task carries the root AGENTS.md",
          w.seen.task.includes("根目錄規則"),
          w.seen.task.slice(0, 400),
        );
        ctx.check("the task does not carry the sub-folder's", !w.seen.task.includes("pkg 規則"));
        ctx.check(
          "the first read in pkg brings pkg/AGENTS.md",
          res(w.seen.results, 0).output.includes("pkg 規則"),
          w.seen.results[0],
        );
        ctx.check(
          "the second read does not repeat it",
          !res(w.seen.results, 1).output.includes("pkg 規則"),
          w.seen.results[1],
        );
      });
    },
  },
  {
    id: "harness.coding.todo-flush-before-compact",
    category: "coding",
    title: "before a compaction the todo list is flushed into the handover",
    timeoutMs: 30_000,
    async run(ctx) {
      let handover = "";
      const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
        if (req.userMessage.includes("<alca:handover>")) {
          if (pass === 0) {
            handover = req.userMessage;
            return call("rep", "report_result", { status: "done", summary: "接著做完了" });
          }
          return say("完成");
        }
        if (!req.tools?.length) return say("## 1. 目標\n修 sum\n## 2. 進度\n做了一半");
        if (pass === 0)
          return [
            { type: "usage", inputTokens: 18_000, outputTokens: 10 },
            ...call("t1", "todo", {
              todos: [
                { content: "讀程式", status: "completed" },
                { content: "修正", status: "in_progress" },
              ],
            }),
          ];
        return say("還在做");
      };
      await coding(
        {
          worker,
          system: {
            workerEngine: new ScriptedEngine(worker, {
              id: "worker",
              capabilities: { maxContextTokens: 20_000 },
            }),
          },
        },
        async () => {
          ctx.check("a handover happened", handover.length > 0);
          ctx.check(
            "it carries the todo heading",
            handover.includes("壓縮前的待辦清單（todo）"),
            handover.slice(0, 600),
          );
          ctx.check("the in-progress item", handover.includes("[>] 修正"));
          ctx.check("the completed item", handover.includes("[x] 讀程式"));
        },
      );
    },
  },
  {
    id: "harness.coding.reviewer-gaps-fed-back",
    category: "coding",
    title: "reviewer on: its gaps go back to the worker, the next report is reviewed again and passes",
    timeoutMs: 40_000,
    async run(ctx) {
      const verdicts = ['{"met":false,"gaps":["少了 README 的安裝說明"]}', '{"met":true,"gaps":[]}'];
      const seen = { reviews: [] as string[], fed: [] as string[], runs: 0 };
      const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
        if (req.userMessage.includes("<alca:review-goal>")) {
          seen.reviews.push(req.userMessage);
          return say(verdicts[seen.reviews.length - 1] ?? '{"met":true,"gaps":[]}');
        }
        if (pass === 0) {
          seen.runs++;
          if (req.userMessage.includes("獨立審查者")) seen.fed.push(req.userMessage);
          return call("w", "write", { path: "README.md", content: `# demo\n\n第 ${seen.runs} 版\n` });
        }
        if (pass === 1)
          return call("r", "report_result", {
            status: "done",
            summary: `README 第 ${seen.runs} 版`,
            changes: ["README.md"],
          });
        return say("完成");
      };
      await coding(
        {
          worker,
          before: (x) => {
            const bot = x.a.store.bots.ensureDefault().id;
            x.a.store.bots.update(bot, { harness: JSON.stringify({ reviewer: true }) });
          },
        },
        async (x) => {
          const msg = x.a.store.threads.messages(x.threadId).find((m) => m.content.includes("<alca:worker"));
          ctx.check("two reviews ran", seen.reviews.length === 2, seen.reviews.length);
          ctx.check(
            "the gap went back to the worker once",
            seen.fed.length === 1 && seen.fed[0]?.includes("少了 README 的安裝說明") === true,
            seen.fed,
          );
          ctx.check("the review saw the diff of README.md", seen.reviews[0]?.includes("README.md") === true);
          ctx.check(
            "the final report is the second version",
            !!msg?.content.includes("第 2 版"),
            msg?.content,
          );
          ctx.check("not unverified", !msg?.content.includes("unverified"), msg?.content);
        },
      );
    },
  },
  {
    id: "harness.coding.stall-partial",
    category: "coding",
    title: "three turns in a row whose tool calls all fail → partial, with the reason",
    timeoutMs: 30_000,
    async run(ctx) {
      let turns = 0;
      const worker = ({ pass }: ScriptContext): ScriptStep[] => {
        if (pass === 0) {
          turns++;
          return call(`r${turns}`, "read", { path: `missing-${turns}.ts` });
        }
        return say("找不到，再試一次");
      };
      await coding({ worker }, async (x) => {
        const w = await endedWorker(x.a, x.threadId);
        const msg = x.a.store.threads.messages(x.threadId).find((m) => m.content.includes("<alca:worker"));
        ctx.check("stopped after exactly 3 turns", turns === 3, turns);
        ctx.check("the report is partial", !!msg?.content.includes("partial"), msg?.content);
        ctx.check(
          "the reason is given",
          !!msg?.content.includes("連續 3 輪嘗試工具都沒有成功"),
          msg?.content,
        );
        ctx.check("the dispatch settled", ledgerOf(x.a, w).row?.status === "settled", ledgerOf(x.a, w).row);
      });
    },
  },
];
