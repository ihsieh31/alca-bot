// Phase 7 — general harness, the parts where a person (or the router) is
// asked: NEEDS_INPUT limits and expiry, who may answer (person-only questions
// never by the router), 完全授權 with its always-confirm floor, and the P14
// homework proposal read from report_result.proposal. Scripted engines on the
// formal path; fictional people and data only.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expiresAt, OFFER_SOURCE } from "@alca/core";
import type { ScriptContext, ScriptStep } from "@alca/engines";
import { FULL_ACCESS_REASON } from "@alca/policy";
import { type Agents, agentSystem, call, lastLine, say, tool, until, using } from "../src/fixtures.ts";
import type { Scenario } from "../src/harness.ts";
import {
  dispatchRouter,
  endedWorker,
  folders,
  gitInit,
  ledgerOf,
  reportIn,
  setBotLevel,
  stepper,
} from "../src/harness-fixtures.ts";

const workerIdIn = (s: string) => /<alca:worker id="(wkr_[^"]+)"/.exec(s)?.[1] ?? "";

/**
 * A general worker that asks `question` and ends; its continuation (after an
 * answer) reports done and remembers the goal it was given.
 */
function asker(question: Record<string, unknown>) {
  const seen = { goal: "" };
  const continued = new Map<string, boolean>();
  const script = ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (pass === 0) continued.set(req.runId, req.userMessage.includes("回答（"));
    if (!continued.get(req.runId))
      return pass === 0
        ? call("q", "report_result", {
            status: "needs_input",
            summary: "要先確定一件事",
            questions: [question],
          })
        : say("等回答");
    if (pass === 0) {
      seen.goal = req.userMessage;
      return call("d", "report_result", { status: "done", summary: "照回答做完了" });
    }
    return say("完成");
  };
  return { script, seen };
}

export const askHarnessScenarios: Scenario[] = [
  {
    id: "harness.general.needs-input-limits-expiry",
    category: "general",
    title:
      "NEEDS_INPUT: 4 questions are refused, 1–3 accepted; a text question expires after 72 h, once; options never",
    timeoutMs: 30_000,
    async run(ctx) {
      let now = Date.parse("Wed 2026-11-04 9:00 AM CST (UTC+08:00)");
      const four = [1, 2, 3, 4].map((i) => ({ question: `第 ${i} 個細節是什麼？` }));
      const w = stepper(
        [
          {
            name: "report_result",
            input: { status: "needs_input", summary: "有四件事要問", questions: four },
          },
        ],
        {
          status: "needs_input",
          summary: "要先確定收件地址",
          questions: [{ question: "卡片要寄到哪個地址？" }],
        },
      );
      await using(
        agentSystem({
          router: ({ req, pass }) => {
            if (req.userMessage.includes('status="expired"')) return say("問題過期了");
            if (req.userMessage.includes("<alca:worker")) return say("請回答工人的問題");
            return dispatchRouter({ harness: "general" })({ req, pass } as ScriptContext);
          },
          worker: w.script,
          level: "autonomous",
          system: { webFetch: false, now: () => new Date(now) },
        }),
        async (a) => {
          const t = a.core.createThread();
          await a.core.send(t.id, "寄一張卡片").done;
          await reportIn(a, t.id, { needle: "NEEDS_INPUT" });
          const first = w.seen.results[0];
          ctx.check(
            "four questions are refused",
            first?.ok === false && first.output.includes("最多問 3 題"),
            first,
          );
          const wk = a.store.workers.byThread(t.id)[0];
          const wait = a.store.dispatches.waitOf(wk?.id ?? "");
          ctx.check("one question is open", wait?.state === "open" && wait.questions.length === 1, wait);
          ctx.check(
            "a text question expires 72 h after it was asked",
            wait?.expiresAt === (wait?.createdAt ?? 0) + 72 * 3600_000,
            wait,
          );
          await until(() => !a.core.isBusy(t.id));
          now += 71 * 3600_000;
          ctx.check("not expired at 71 h", a.agents.sweep().expired === 0);
          now += 2 * 3600_000;
          ctx.check("expired at 73 h", a.agents.sweep().expired === 1);
          ctx.check("expired once only", a.agents.sweep().expired === 0);
          ctx.check(
            "the dispatch settled expired",
            ledgerOf(a, wk).row?.outcome === "expired",
            ledgerOf(a, wk).row,
          );
          let refused = "";
          try {
            a.agents.workers.answer(wk?.id ?? "", ["虛構市北區 1 號"], "user");
          } catch (e) {
            refused = String(e);
          }
          ctx.check("a late answer is refused", /過期/.test(refused), refused);
          ctx.check(
            "a question with options never expires",
            expiresAt([{ question: "哪一天？", personOnly: false, options: ["週五", "週六"] }], now) === null,
          );
        },
      );
    },
  },
  {
    id: "harness.general.person-only-not-router",
    category: "general",
    title:
      "a person-only question (a sign-in code) is never answered by the router, even under 自主; the person's words are",
    timeoutMs: 30_000,
    async run(ctx) {
      const w = asker({ question: "登入虛構圖書館的驗證碼是多少？" });
      const refusals: string[] = [];
      const relayed: string[] = [];
      let a0: () => Agents | undefined = () => undefined;
      await using(
        agentSystem({
          router: ({ req, pass }) => {
            if (pass > 0 && req.toolResults?.[0]?.id === "a") {
              refusals.push(req.toolResults[0].output);
              return say("請你告訴我驗證碼");
            }
            if (req.userMessage.includes("NEEDS_INPUT")) {
              relayed.push(req.userMessage);
              return call("a", "worker_answer", {
                workerId: workerIdIn(req.userMessage),
                answers: ["000000"],
              });
            }
            if (req.userMessage.includes("<alca:worker")) return say("收到回報");
            if (lastLine(req.userMessage).startsWith("驗證碼是")) {
              const wk = a0()?.store.workers.byThread(req.threadId)[0];
              return pass === 0
                ? call("u", "worker_answer", { workerId: wk?.id ?? "", answers: [lastLine(req.userMessage)] })
                : say("轉交了");
            }
            return dispatchRouter({ harness: "general" })({ req, pass } as ScriptContext);
          },
          worker: w.script,
          level: "autonomous",
          system: { webFetch: false },
        }),
        async (a) => {
          a0 = () => a;
          const t = a.core.createThread();
          await a.core.send(t.id, "幫我登入虛構圖書館").done;
          await until(() => refusals.length > 0, 15_000);
          const first = a.store.workers.byThread(t.id)[0];
          ctx.check(
            "the router saw it marked person-only",
            relayed[0]?.includes("只有本人能答") === true,
            relayed[0],
          );
          ctx.check(
            "the router's own answer is refused",
            refusals[0]?.includes("只有使用者本人能回答") === true,
            refusals[0],
          );
          ctx.check(
            "the question is still open",
            a.store.dispatches.waitOf(first?.id ?? "")?.state === "open",
          );
          await until(() => !a.core.isBusy(t.id));
          await a.core.send(t.id, "驗證碼是 482913").done;
          await reportIn(a, t.id, { needle: "照回答做完了" });
          ctx.check(
            "the continuation got the person's answer",
            w.seen.goal.includes("使用者回答") && w.seen.goal.includes("482913"),
            w.seen.goal,
          );
          const answered = ledgerOf(a, first).events.filter((e) => e.kind === "answered");
          ctx.check(
            "one answer is in the ledger, by the person",
            answered.length === 1 && (answered[0]?.detail as { by?: string })?.by === "user",
            answered,
          );
        },
      );
    },
  },
  {
    id: "harness.general.router-answers-autonomous",
    category: "general",
    title:
      "an ordinary choice under 自主: the router answers itself and the continuation finishes on the same dispatch",
    timeoutMs: 30_000,
    async run(ctx) {
      const w = asker({ question: "海報用哪個色系？", options: ["藍", "綠"] });
      await using(
        agentSystem({
          router: ({ req, pass }) => {
            if (req.userMessage.includes("NEEDS_INPUT"))
              return pass === 0
                ? call("a", "worker_answer", { workerId: workerIdIn(req.userMessage), answers: ["藍"] })
                : say("我先代答了");
            return dispatchRouter({ harness: "general" })({ req, pass } as ScriptContext);
          },
          worker: w.script,
          level: "autonomous",
          system: { webFetch: false },
        }),
        async (a) => {
          const t = a.core.createThread();
          await a.core.send(t.id, "做一張海報").done;
          await reportIn(a, t.id, { needle: "照回答做完了" });
          const [first, second] = a.store.workers.byThread(t.id);
          ctx.check(
            "the continuation serves the same dispatch",
            !!second && second.grants.dispatchId === first?.grants.dispatchId,
          );
          ctx.check(
            "its goal says the router answered",
            w.seen.goal.includes("總機代答") && w.seen.goal.includes("藍"),
            w.seen.goal,
          );
          ctx.check("settled done", ledgerOf(a, second).row?.outcome === "done", ledgerOf(a, second).row);
          ctx.check("the wait closed", a.store.dispatches.waitOf(first?.id ?? "")?.state === "closed");
        },
      );
    },
  },
  {
    id: "harness.general.full-access-floor",
    category: "general",
    title:
      "完全授權: git push and a file delete run and are ledgered auto_allowed; payment and an outward send still ask",
    timeoutMs: 30_000,
    async run(ctx) {
      // Alca's own bash (a coding tool) in a fictional repo with no remote: the push runs and fails offline.
      const f = folders();
      const dir = f.make({ "build.log": "old\n", "a.txt": "a\n" });
      gitInit(dir);
      const pay = tool("pay_invoice", "payment");
      const mail = tool("send_mail", "send");
      const w = stepper(
        [
          { name: "bash", input: { command: "git push origin main" } },
          { name: "bash", input: { command: "rm -f build.log" } },
          { name: "pay_invoice", input: { amount: 120 } },
          { name: "send_mail", input: { to: "vendor@example.test" } },
        ],
        { status: "partial", summary: "推送與刪除做了；付款與寄信沒有被核准" },
      );
      const coding = {
        router: dispatchRouter({ harness: "coding", checks: ["true"] }),
        system: { webFetch: false as const, workDir: () => dir },
      };
      try {
        await using(agentSystem({ ...coding, worker: w.script, tools: [pay, mail] }), async (a) => {
          setBotLevel(a, "full_access");
          const t = a.core.createThread();
          await a.core.send(t.id, "推送、清掉 log、付款、寄信").done;
          const payCard = await until(() => a.store.human.pendingApprovals()[0], 15_000);
          ctx.check("payment asks", payCard.actionClass === "payment", payCard.actionClass);
          a.core.answerApproval(payCard.id, "denied");
          const mailCard = await until(
            () => a.store.human.pendingApprovals().find((x) => x.actionClass === "send"),
            15_000,
          );
          a.core.answerApproval(mailCard.id, "denied");
          const wk = await endedWorker(a, t.id);
          const [push, rm] = w.seen.results;
          ctx.check(
            "the push ran (a structured exit code, offline)",
            !!push?.ok && push.output.includes("exit_code"),
            push,
          );
          ctx.check("the delete ran", !!rm?.ok && !existsSync(join(dir, "build.log")), rm);
          ctx.check("payment and send did not run", pay.calls.length === 0 && mail.calls.length === 0);
          const auto = ledgerOf(a, wk)
            .events.filter((e) => e.kind === "auto_allowed")
            .map((e) => e.detail as Record<string, unknown>);
          ctx.check(
            "each auto_allowed entry says why",
            auto.length > 0 && auto.every((d) => d.reason === FULL_ACCESS_REASON),
            auto,
          );
          const said = auto.map((d) => String(d.summary)).join("|");
          ctx.check("the push is ledgered auto_allowed", said.includes("git push origin main"), auto);
          ctx.check("the delete is ledgered auto_allowed", said.includes("rm -f build.log"), auto);
          const asked = a.store.db
            .prepare("SELECT action_class FROM approvals ORDER BY requested_at")
            .all() as Array<{ action_class: string }>;
          ctx.check(
            "only payment and send asked",
            asked.map((x) => x.action_class).join(",") === "payment,send",
            asked,
          );
        });
        // Control: the same push one level down (自主) asks as publish and does not run when denied.
        const w2 = stepper([{ name: "bash", input: { command: "git push origin main" } }], {
          status: "partial",
          summary: "沒推",
        });
        await using(agentSystem({ ...coding, worker: w2.script, level: "autonomous" }), async (a) => {
          const t = a.core.createThread();
          await a.core.send(t.id, "推送").done;
          const card = await until(() => a.store.human.pendingApprovals()[0], 15_000);
          ctx.check(
            "control: at 自主 the push asks as publish",
            card.actionClass === "publish",
            card.actionClass,
          );
          a.core.answerApproval(card.id, "denied");
          const wk = await endedWorker(a, t.id);
          ctx.check(
            "control: denied, nothing auto_allowed",
            !ledgerOf(a, wk).kinds.includes("auto_allowed"),
            ledgerOf(a, wk).kinds,
          );
        });
      } finally {
        f.clean();
      }
    },
  },
  {
    id: "harness.general.shell-alias-push-asks",
    category: "general",
    title:
      "A host tool named hands_run or shell: git push asks as publish at 自主 and 逐步確認; 完全授權 runs a plain push (auto_allowed), a send still asks",
    timeoutMs: 45_000,
    async run(ctx) {
      // Security fix 2026-11-05: the command line of every shell tool decides its class, not only Bash's.
      const f = folders();
      const dir = f.make({ "a.txt": "a\n" });
      gitInit(dir);
      const coding = {
        router: dispatchRouter({ harness: "coding", checks: ["true"] }),
        system: { webFetch: false as const, workDir: () => dir },
      };
      const asked = (a: Agents) =>
        (
          a.store.db.prepare("SELECT action_class FROM approvals ORDER BY requested_at").all() as Array<{
            action_class: string;
          }>
        ).map((x) => x.action_class);
      try {
        // 自主: both names put up a publish card; denied, neither runs.
        const hands = tool("hands_run", "execute");
        const shell = tool("shell", "execute");
        const w1 = stepper(
          [
            { name: "hands_run", input: { command: "git push origin main" } },
            { name: "shell", input: { command: "git push origin main" } },
          ],
          { status: "partial", summary: "沒推" },
        );
        await using(
          agentSystem({ ...coding, worker: w1.script, tools: [hands, shell], level: "autonomous" }),
          async (a) => {
            const t = a.core.createThread();
            await a.core.send(t.id, "推送").done;
            for (let i = 0; i < 2; i++) {
              const card = await until(() => a.store.human.pendingApprovals()[0], 15_000);
              a.core.answerApproval(card.id, "denied");
            }
            await endedWorker(a, t.id);
            ctx.check(
              "自主: hands_run and shell git push ask as publish",
              asked(a).join(",") === "publish,publish",
              asked(a),
            );
            ctx.check("自主: denied, neither ran", hands.calls.length === 0 && shell.calls.length === 0);
          },
        );
        // 逐步確認: the card is a publish card, not an execute card.
        const shell2 = tool("shell", "execute");
        const w2 = stepper([{ name: "shell", input: { command: "git push origin main" } }], {
          status: "partial",
          summary: "沒推",
        });
        await using(
          agentSystem({ ...coding, worker: w2.script, tools: [shell2], level: "confirm_each_step" }),
          async (a) => {
            const t = a.core.createThread();
            await a.core.send(t.id, "推送").done;
            const card = await until(() => a.store.human.pendingApprovals()[0], 15_000);
            ctx.check(
              "逐步確認: the shell push card is publish, not execute",
              card.actionClass === "publish",
              card.actionClass,
            );
            a.core.answerApproval(card.id, "denied");
            await endedWorker(a, t.id);
          },
        );
        // 完全授權: a plain git push runs and is ledgered; sendmail through hands_run still asks.
        const shell3 = tool("shell", "execute", () => "pushed");
        const hands3 = tool("hands_run", "execute", () => "sent");
        const w3 = stepper(
          [
            { name: "shell", input: { command: "git push origin main" } },
            { name: "hands_run", input: { command: "sendmail ops@example.test < note.txt" } },
          ],
          { status: "partial", summary: "推了；寄信沒有被核准" },
        );
        await using(agentSystem({ ...coding, worker: w3.script, tools: [shell3, hands3] }), async (a) => {
          setBotLevel(a, "full_access");
          const t = a.core.createThread();
          await a.core.send(t.id, "推送後寄信").done;
          const card = await until(() => a.store.human.pendingApprovals()[0], 15_000);
          ctx.check(
            "完全授權: sendmail through hands_run still asks as send",
            card.actionClass === "send",
            card.actionClass,
          );
          a.core.answerApproval(card.id, "denied");
          const wk = await endedWorker(a, t.id);
          ctx.check(
            "完全授權: the plain push ran, the send did not",
            shell3.calls.length === 1 && hands3.calls.length === 0,
          );
          const auto = ledgerOf(a, wk)
            .events.filter((e) => e.kind === "auto_allowed")
            .map((e) => e.detail as Record<string, unknown>);
          ctx.check(
            "完全授權: the push is ledgered auto_allowed as publish with its reason",
            auto.length === 1 &&
              auto[0]?.tool === "shell" &&
              auto[0]?.actionClass === "publish" &&
              auto[0]?.reason === FULL_ACCESS_REASON,
            auto,
          );
        });
      } finally {
        f.clean();
      }
    },
  },
  {
    id: "harness.general.p14-proposal-from-report",
    category: "general",
    title:
      "P14 homework: the offer card is report_result.proposal, not a 提案： line in the text; the old format still reads",
    timeoutMs: 30_000,
    async run(ctx) {
      const T = Date.parse("Tue 2026-11-03 10:00 AM CST (UTC+08:00)");
      const PROPOSAL = "報告 11 月 6 日截止。要我幫你排寫作進度嗎？";
      const homework =
        (report: Record<string, unknown>) =>
        ({ req, pass }: ScriptContext): ScriptStep[] =>
          req.userMessage.includes("主動留意發現了一件事") && pass === 0
            ? call("hw", "report_result", report)
            : say("完成。");
      const runOnce = async (report: Record<string, unknown>) => {
        let text = "";
        await using(
          agentSystem({
            router: () => say("好"),
            worker: homework(report),
            system: {
              webFetch: false,
              now: () => new Date(T),
              addonComplete: async ({ prompt }) => {
                const ids = [...prompt.matchAll(/id=(\S+)/gu)].map((m) => m[1] as string);
                const candidates = [
                  {
                    fact: "報告 11 月 6 日截止",
                    action: "排寫作進度",
                    category: "study",
                    due_at: new Date(T + 3 * 86400_000).toISOString(),
                    evidence_ids: ids.slice(0, 1),
                  },
                ];
                return { text: JSON.stringify({ candidates }), inputTokens: 100, outputTokens: 10 };
              },
            },
          }),
          async (a) => {
            const bot = a.store.bots.ensureDefault().id;
            a.agents.learning?.memory.remember(
              bot,
              {
                kind: "project",
                subject: "due:報告",
                body: "11月6日要交報告",
                quote: "11月6日要交報告",
                confidence: 1,
                dueAt: new Date(T + 3 * 86400_000).toISOString(),
              },
              {},
              { scope: "shared" },
            );
            a.agents.addons.set(bot, "proactive", { enabled: true, settings: {} });
            await a.agents.proactive.scan(bot, { force: true });
            text = (await until(() => a.store.offers.list({ source: OFFER_SOURCE })[0], 15_000)).text;
          },
        );
        return text;
      };
      const both = await runOnce({
        status: "done",
        summary: "細節查好了。\n提案：要我把報告交掉嗎？",
        proposal: PROPOSAL,
      });
      ctx.check("report_result.proposal wins over a 提案： line", both === PROPOSAL, both);
      const old = await runOnce({ status: "done", summary: `細節查好了。\n提案：${PROPOSAL}` });
      ctx.check("the old 提案： format is still read", old === PROPOSAL, old);
    },
  },
];
