import type { ScriptContext } from "@alca/engines";
import { agentSystem, call, lastLine, say, tool, until, using } from "../src/fixtures.ts";
import type { Scenario } from "../src/harness.ts";

/** Router that dispatches on "派工：<goal>" and reports a worker's result in one line. */
function dispatcher({ req, pass }: ScriptContext) {
  const msg = req.userMessage;
  if (msg.includes("<alca:worker")) {
    const title = /title="([^"]+)"/.exec(msg)?.[1] ?? "";
    return say(`回報：${title} 完成了`);
  }
  if (pass > 0) return say("已經派出去了，好了告訴你。");
  const text = lastLine(msg);
  if (text.startsWith("派兩件："))
    return [
      {
        type: "tool.call" as const,
        id: "r1",
        name: "worker_start",
        input: { title: "查天氣", goal: "weather" },
      },
      { type: "tool.call" as const, id: "r2", name: "worker_start", input: { title: "查匯率", goal: "fx" } },
      { type: "done" as const, stop: "tool_use" as const },
    ];
  if (text.startsWith("派工：")) return call("r1", "worker_start", { title: "工作", goal: text.slice(3) });
  return say(`回答：${text}`);
}

const doer = ({ req }: ScriptContext) => say(`做完：${lastLine(req.userMessage)}`);

export const routerScenarios: Scenario[] = [
  {
    id: "router.answers-without-dispatch",
    category: "router",
    title: "A plain question is answered by the router itself; no worker starts",
    async run(ctx) {
      await using(agentSystem({ router: dispatcher, worker: doer }), async (a) => {
        const t = a.core.createThread("q");
        await a.core.send(t.id, "今天星期幾？").done;
        ctx.check("no worker created", a.store.workers.byThread(t.id).length === 0);
        ctx.check("worker engine never called", a.worker.requests.length === 0, a.worker.requests.length);
        const last = a.core.messages(t.id).at(-1);
        ctx.check(
          "router replied",
          last?.role === "assistant" && last.content === "回答：今天星期幾？",
          last,
        );
      });
    },
  },
  {
    id: "router.dispatch-and-report",
    category: "router",
    title: "Dispatch: worker_start returns at once, the worker runs, its report comes back to the router",
    async run(ctx) {
      await using(agentSystem({ router: dispatcher, worker: doer }), async (a) => {
        const t = a.core.createThread("d");
        await a.core.send(t.id, "派工：整理收件匣").done;
        const ws = a.store.workers.byThread(t.id);
        ctx.check("one worker created by the router turn", ws.length === 1, ws.length);
        ctx.check(
          "router turn ended before the worker finished (async)",
          a.core.messages(t.id).some((m) => m.content === "已經派出去了，好了告訴你。"),
        );
        const w = await until(() => {
          const x = a.store.workers.get(ws[0]!.id);
          return x?.status === "succeeded" ? x : undefined;
        });
        ctx.check(
          "worker got the goal",
          a.worker.requests.some((r) => lastLine(r.userMessage) === "整理收件匣"),
        );
        ctx.check("worker result kept", w.result?.summary === "做完：整理收件匣", w.result);
        await until(() => a.core.messages(t.id).some((m) => m.content === "回報：工作 完成了"));
        ctx.check(
          "router read an <alca:worker> report",
          a.router.requests.some((r) => r.userMessage.includes(`<alca:worker id="${w.id}"`)),
        );
        ctx.check(
          "worker text stays out of the person's chat",
          !a.core.messages(t.id).some((m) => m.role === "assistant" && m.content.includes("做完：")),
        );
      });
    },
  },
  {
    id: "router.parallel-workers",
    category: "router",
    title: "Two tasks in one turn: two workers with their own jobs, both report back",
    async run(ctx) {
      await using(agentSystem({ router: dispatcher, worker: doer }), async (a) => {
        const t = a.core.createThread("p");
        await a.core.send(t.id, "派兩件：天氣和匯率").done;
        const ws = a.store.workers.byThread(t.id);
        ctx.check(
          "two workers",
          ws.length === 2,
          ws.map((w) => w.title),
        );
        ctx.check("separate jobs", new Set(ws.map((w) => w.jobId)).size === 2);
        await until(() => ws.every((w) => a.store.workers.get(w.id)?.status === "succeeded"));
        await until(
          () =>
            a.core.messages(t.id).some((m) => m.content === "回報：查天氣 完成了") &&
            a.core.messages(t.id).some((m) => m.content === "回報：查匯率 完成了"),
        );
        ctx.check("both reports reached the person", true);
      });
    },
  },
  {
    id: "router.has-no-host-tools",
    category: "router",
    title: "The router cannot run a host tool itself, even under 自主 (only workers act)",
    async run(ctx) {
      const send = tool("send_mail", "send");
      await using(
        agentSystem({
          router: ({ pass }) =>
            pass === 0 ? call("x", "send_mail", { to: "a@example.com" }) : say("我不能直接寄"),
          worker: doer,
          tools: [send],
          level: "autonomous",
        }),
        async (a) => {
          const t = a.core.createThread("r");
          await a.core.send(t.id, "直接寄信").done;
          const done = a.events.find((e) => e.type === "tool.completed");
          ctx.check(
            "router's call failed",
            !!done && (done.data as { ok: boolean }).ok === false,
            done?.data,
          );
          ctx.check("tool never ran", send.calls.length === 0, send.calls);
          ctx.check("no approval card was needed", !a.events.some((e) => e.type === "approval.requested"));
          ctx.check(
            "router was not offered host tools",
            a.router.requests.every((r) => !(r.tools ?? []).some((x) => x.name === "send_mail")),
          );
        },
      );
    },
  },
];
