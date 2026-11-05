import type { HostTool } from "@alca/core";
import { ScriptedEngine, type ScriptStep } from "@alca/engines";
import {
  agentSystem,
  approvals,
  call,
  directCore,
  lastLine,
  say,
  tool,
  until,
  using,
  within,
} from "../src/fixtures.ts";
import type { Scenario } from "../src/harness.ts";

const ALWAYS = ["payment", "send", "delete", "publish"] as const;
const TOOL_OF: Record<(typeof ALWAYS)[number], string> = {
  payment: "checkout_pay",
  send: "send_mail",
  delete: "delete_file",
  publish: "publish_post",
};

/** One tool call on the first pass, then a line saying how it went. */
const callOnce = (name: string, input: Record<string, unknown> = {}) =>
  new ScriptedEngine(({ pass, req }): ScriptStep[] =>
    pass === 0 ? call("c1", name, input) : say(`結果：${req.toolResults?.[0]?.ok ? "ok" : "fail"}`),
  );

function gateScenario(
  cls: (typeof ALWAYS)[number],
  variant: "autonomous" | "allow-rule" | "approve",
): Scenario {
  const name = TOOL_OF[cls];
  const title = {
    autonomous: `${cls}: asks under 自主, and 拒絕 means it never runs`,
    "allow-rule": `${cls}: an allow rule for the tool (and "*") cannot remove the card`,
    approve: `${cls}: 允許一次 runs it exactly once; the card cannot be answered twice`,
  }[variant];
  return {
    id: `approvals.${cls}.${variant}`,
    category: "approvals",
    title,
    async run(ctx) {
      const t0 = tool(name, cls);
      const rules =
        variant === "allow-rule"
          ? [
              { id: "allow-tool", effect: "allow", action: name },
              { id: "allow-all", effect: "allow", action: "*" },
            ]
          : undefined;
      await using(
        directCore(callOnce(name, { target: "x" }), {
          tools: [t0 as HostTool],
          level: "autonomous",
          ...(rules ? { rules } : {}),
        }),
        async (c) => {
          const th = c.core.createThread();
          const { done } = c.core.send(th.id, `做 ${cls}`);
          const card = await within(() => approvals(c.events)[0], 3000);
          ctx.check("a card was raised", !!card);
          ctx.check(`card class is ${cls}`, card?.data.actionClass === cls, card?.data.actionClass);
          ctx.check("nothing ran before the answer", t0.calls.length === 0, t0.calls);
          if (!card) return;
          if (variant === "approve") {
            ctx.check("approve resolves", c.core.answerApproval(card.data.approvalId, "approved").resolved);
            ctx.check(
              "a second answer is refused",
              !c.core.answerApproval(card.data.approvalId, "approved").resolved,
            );
            await done;
            ctx.check("ran exactly once", t0.calls.length === 1, t0.calls.length);
          } else {
            c.core.answerApproval(card.data.approvalId, "denied");
            await done;
            ctx.check("denied: never ran", t0.calls.length === 0, t0.calls);
            const audit = c.store.db.prepare("SELECT action FROM audit_log").all() as Array<{
              action: string;
            }>;
            ctx.check(
              "audit row written for the request",
              audit.some((r) => r.action === name),
              audit,
            );
          }
        },
      );
    },
  };
}

export const approvalScenarios: Scenario[] = [
  ...ALWAYS.flatMap((cls) => [
    gateScenario(cls, "autonomous"),
    gateScenario(cls, "allow-rule"),
    gateScenario(cls, "approve"),
  ]),
  {
    id: "approvals.write.autonomous-control",
    category: "approvals",
    title: "Control: a plain write under 自主 runs without a card (the gate is not just 'ask always')",
    async run(ctx) {
      const w = tool("write_note", "write");
      await using(directCore(callOnce("write_note"), { tools: [w], level: "autonomous" }), async (c) => {
        const th = c.core.createThread();
        await c.core.send(th.id, "寫").done;
        ctx.check("no card", approvals(c.events).length === 0);
        ctx.check("ran once", w.calls.length === 1, w.calls.length);
      });
    },
  },
  {
    id: "approvals.write.confirm-each-step",
    category: "approvals",
    title: "每步確認: a write asks first",
    async run(ctx) {
      const w = tool("write_note", "write");
      await using(
        directCore(callOnce("write_note"), { tools: [w], level: "confirm_each_step" }),
        async (c) => {
          const th = c.core.createThread();
          const { done } = c.core.send(th.id, "寫");
          const card = await within(() => approvals(c.events)[0], 3000);
          ctx.check("card raised", card?.data.actionClass === "write", card?.data);
          if (card) c.core.answerApproval(card.data.approvalId, "denied");
          await done;
          ctx.check("denied write never ran", w.calls.length === 0);
        },
      );
    },
  },
  {
    id: "approvals.deny-rule-wins",
    category: "approvals",
    title: "A deny rule wins over 自主 and over an allow rule; no card, never runs",
    async run(ctx) {
      const d = tool("delete_file", "delete");
      await using(
        directCore(callOnce("delete_file"), {
          tools: [d],
          level: "autonomous",
          rules: [
            { id: "allow", effect: "allow", action: "*" },
            { id: "no-delete", effect: "deny", action: "delete_file" },
          ],
        }),
        async (c) => {
          const th = c.core.createThread();
          await c.core.send(th.id, "刪").done;
          ctx.check("never ran", d.calls.length === 0);
          ctx.check("no card (refused outright)", approvals(c.events).length === 0);
        },
      );
    },
  },
  {
    id: "approvals.misdeclared-tool-escalated",
    category: "approvals",
    title: "A tool declared read but whose inspect says payment is gated as payment",
    async run(ctx) {
      const pay: HostTool & { calls: unknown[] } = {
        ...tool("shop_action", "read"),
        inspect: async () => ({ actionClass: "payment", summary: "付款 NT$1,280" }),
      };
      await using(directCore(callOnce("shop_action"), { tools: [pay], level: "autonomous" }), async (c) => {
        const th = c.core.createThread();
        const { done } = c.core.send(th.id, "買");
        const card = await within(() => approvals(c.events)[0], 3000);
        ctx.check("escalated to payment", card?.data.actionClass === "payment", card?.data);
        if (card) c.core.answerApproval(card.data.approvalId, "denied");
        await done;
        ctx.check("never ran", pay.calls.length === 0);
      });
    },
  },
  ...ALWAYS.map(
    (cls): Scenario => ({
      id: `approvals.${cls}.worker-autonomous`,
      category: "approvals",
      title: `${cls} from a worker under 自主 still asks the person, with bot and worker on the card`,
      async run(ctx) {
        const t0 = tool(TOOL_OF[cls], cls);
        await using(
          agentSystem({
            router: ({ pass, req }) =>
              pass === 0 && !req.userMessage.includes("<alca:worker")
                ? call("s", "worker_start", { title: cls, goal: cls })
                : say("好"),
            worker: ({ pass, req }) =>
              pass === 0 && lastLine(req.userMessage) === cls ? call("w", TOOL_OF[cls], {}) : say("完成"),
            tools: [t0],
            level: "autonomous",
          }),
          async (a) => {
            const th = a.core.createThread();
            await a.core.send(th.id, `叫工人 ${cls}`).done;
            const card = await within(() => approvals(a.events)[0], 4000);
            const w = a.store.workers.byThread(th.id)[0];
            ctx.check("card raised", card?.data.actionClass === cls, card?.data);
            ctx.check("card names the worker", !!w && card?.data.workerId === w.id, card?.data);
            ctx.check("card names the bot", !!card?.data.botId, card?.data);
            ctx.check("nothing ran", t0.calls.length === 0);
            if (!card || !w) return;
            a.core.answerApproval(card.data.approvalId, "denied");
            await until(() => ["succeeded", "failed"].includes(a.store.workers.get(w.id)?.status ?? ""));
            ctx.check("denied: never ran", t0.calls.length === 0);
          },
        );
      },
    }),
  ),
];
